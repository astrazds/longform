import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';
import { loadContext, loadRuntime, deferred, flush, fakeClock } from './helpers/runtime.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const files = ['capture-transfer.js', 'capture-delivery.js'];
function event() {
  const listeners = new Set();
  return { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn),
    emit: (value) => { for (const fn of [...listeners]) fn(value); }, get size() { return listeners.size; } };
}
function ports(change = (message) => [message]) {
  const left = { onMessage: event(), onDisconnect: event() };
  const right = { onMessage: event(), onDisconnect: event() };
  const messages = [];
  left.postMessage = (message) => { messages.push(message); queueMicrotask(() => {
    for (const next of change(message)) right.onMessage.emit(next);
  }); };
  right.postMessage = (message) => { messages.push(message); queueMicrotask(() => left.onMessage.emit(message)); };
  const disconnect = () => { left.onDisconnect.emit(); right.onDisconnect.emit(); };
  return { left, right, messages, disconnect };
}
function context(overrides = {}) {
  const controller = new AbortController();
  const ctx = { documentId: 'doc', sessionId: 'session', signal: controller.signal,
    checkpoint() { if (controller.signal.aborted) throw controller.signal.reason; },
    async external(operation) {
      ctx.checkpoint(); let timer; let aborted;
      try {
        const value = await Promise.race([operation(), new Promise((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'transfer-failed' })), 500);
          aborted = () => reject(controller.signal.reason);
          controller.signal.addEventListener('abort', aborted, { once: true });
        })]);
        ctx.checkpoint(); return value;
      } finally { clearTimeout(timer); controller.signal.removeEventListener('abort', aborted); }
    },
    ...overrides };
  return { ctx, controller };
}
async function setup({ change, decode = async () => ({ width: 1, height: 1, close() {} }), sourceProtocol = 'http:' } = {}) {
  const worker = await loadContext(['capture-broker.js'], { crypto: webcrypto });
  const broker = worker.Longform.broker.create({ runtimeId: 'extension', tabs: {} });
  const sender = { id: 'extension', frameId: 0, documentId: 'browser-doc', tab: { id: 1, windowId: 2 }, url: `${sourceProtocol}//example.test/` };
  const requests = [];
  const source = await loadRuntime(files, { location: { protocol: sourceProtocol }, crypto: undefined,
    chrome: { runtime: { sendMessage: async (message) => {
      requests.push(message);
      try { return { success: true, ...(message.type === 'BROKER_HELLO'
        ? broker.hello(sender) : await broker.digestMessage(message, sender)) }; }
      catch (error) { return { success: false, errorCode: error.code }; }
    } } } });
  const target = await loadRuntime(files, { location: { protocol: 'chrome-extension:' }, crypto: webcrypto, createImageBitmap: decode });
  assert.equal(typeof source.transfer?.send, 'function', 'bounded transfer API exists');
  assert.equal(typeof target.delivery?.save, 'function', 'popup delivery API exists');
  return { source, target, requests, ...ports(change) };
}
async function exchange(s, blob = new Blob([png], { type: 'image/png' }), sourceCtx = context().ctx, targetCtx = context().ctx) {
  const received = s.target.transfer.receive({ port: s.right, ctx: targetCtx, transferId: 'transfer', maxBytes: 32 * 1024 * 1024 });
  const sent = s.source.transfer.send(blob, { port: s.left, ctx: sourceCtx, transferId: 'transfer' });
  return Promise.all([sent, received]);
}
test('bounded chunks round trip exactly', async () => {
  const s = await setup();
  const bytes = Buffer.concat([png, Buffer.alloc(600000, 113)]);
  const [, blob] = await exchange(s, new Blob([bytes], { type: 'image/png' }));
  assert.deepEqual(Buffer.from(await blob.arrayBuffer()), bytes);
  const rawChunkSizes = s.messages.filter((m) => m.type === 'ARTIFACT_CHUNK').map((m) => atob(m.data).length);
  assert.ok(Math.max(...rawChunkSizes) <= 256 * 1024);
  let unacknowledged = 0; let maxUnacknowledgedChunks = 0;
  for (const message of s.messages) {
    if (message.type === 'ARTIFACT_CHUNK') maxUnacknowledgedChunks = Math.max(maxUnacknowledgedChunks, ++unacknowledged);
    if (message.type === 'CHUNK_ACK' && message.ackFor === 'ARTIFACT_CHUNK') unacknowledged--;
  }
  assert.equal(maxUnacknowledgedChunks, 1);
  assert.equal(s.requests.filter((r) => r.type === 'DIGEST_END').length, 1);
  assert.equal(s.left.onMessage.size + s.right.onMessage.size, 0);
});
test('source digest works from HTTPS and HTTP without content WebCrypto', async () => {
  for (const sourceProtocol of ['http:', 'https:']) await exchange(await setup({ sourceProtocol }));
});
test('corrupt stream rejected', async (t) => {
  for (const kind of ['bytes', 'duplicate', 'order', 'length', 'session', 'transfer', 'digest', 'ack']) {
    await t.test(kind, async () => {
      const s = await setup({ change(message) {
        if (kind === 'digest' && message.type === 'ARTIFACT_BEGIN') return [{ ...message, digest: '0'.repeat(64) }];
        if (kind === 'length' && message.type === 'ARTIFACT_BEGIN') return [{ ...message, byteLength: message.byteLength - 1 }];
        if (message.type !== 'ARTIFACT_CHUNK') return [message];
        if (kind === 'bytes') return [{ ...message, data: btoa('x'.repeat(atob(message.data).length)) }];
        if (kind === 'duplicate') return [message, { ...message, requestId: `${message.requestId}-duplicate` }];
        if (kind === 'order') return [{ ...message, chunkIndex: 4 }];
        if (kind === 'session') return [{ ...message, sessionId: 'forged' }];
        if (kind === 'transfer') return [{ ...message, transferId: 'forged' }];
        return [message];
      } });
      if (kind === 'ack') {
        const post = s.right.postMessage;
        s.right.postMessage = (m) => post(m.type === 'CHUNK_ACK' ? { ...m, sessionId: 'forged' } : m);
      }
      const a = s.target.transfer.receive({ port: s.right, ctx: context().ctx, transferId: 'transfer', maxBytes: 1000000 });
      const b = s.source.transfer.send(new Blob([png], { type: 'image/png' }), { port: s.left, ctx: context().ctx, transferId: 'transfer' });
      const results = await Promise.allSettled([a, b]);
      assert.ok(results.some((r) => r.status === 'rejected' && r.reason.code === 'transfer-failed'));
      assert.ok(results.every((r) => r.status === 'rejected'));
    });
  }
});
test('receiver rejects allocation limits and unsupported PNG before commit', async () => {
  for (const variant of ['limit', 'type', 'decode', 'dimensions']) {
    let decodes = 0;
    const s = await setup({ decode: async () => { decodes++; if (variant === 'decode') throw Error('bad PNG');
      return { width: variant === 'dimensions' ? 2 : 1, height: 1, close() {} }; } });
    const received = s.target.transfer.receive({ port: s.right, ctx: context().ctx, transferId: 'transfer', maxBytes: variant === 'limit' ? 4 : 1000 });
    const sent = s.source.transfer.send(new Blob([png], { type: variant === 'type' ? 'image/jpeg' : 'image/png' }),
      { port: s.left, ctx: context().ctx, transferId: 'transfer' });
    // A source-side rejection has no BEGIN; connection teardown ends the receiver.
    sent.catch(() => s.disconnect());
    const results = await Promise.allSettled([received, sent]);
    assert.ok(results.every((r) => r.status === 'rejected'));
    if (variant === 'limit' || variant === 'type') assert.equal(decodes, 0);
  }
});
test('disconnect requires explicit delivery retry', async () => {
  const s = await setup(); let sends = 0;
  const source = context();
  source.ctx.external = async (op) => { sends++; return op(); };
  const received = s.target.transfer.receive({ port: s.right, ctx: context().ctx, transferId: 'transfer', maxBytes: 1000 });
  const sent = s.source.transfer.send(new Blob([png], { type: 'image/png' }), { port: s.left, ctx: source.ctx, transferId: 'transfer' });
  s.disconnect();
  const results = await Promise.allSettled([received, sent]);
  assert.ok(results.every((r) => r.status === 'rejected' && r.reason.code === 'transfer-failed'));
  const count = sends; await flush(); assert.equal(sends - count, 0, 'automaticRetryCount');
});
test('expired transfer never commits', async () => {
  const gate = deferred(); const decoding = deferred(); const target = context(); let closed = 0;
  const s = await setup({ decode: () => { decoding.resolve(); return gate.promise; } });
  const pending = exchange(s, undefined, context().ctx, target.ctx);
  await decoding.promise;
  target.controller.abort(Object.assign(new Error('expired'), { code: 'artifact-expired' }));
  gate.resolve({ width: 1, height: 1, close() { closed++; } });
  await assert.rejects(pending, (error) => error.code === 'artifact-expired' || error.code === 'transfer-failed');
  assert.equal(s.messages.some((m) => m.type === 'COMMIT_DELIVERY'), false);
  await flush(); assert.equal(closed, 1, 'late native decode is closed');
});

test('receiver reserves decoded PNG memory before accepting image chunks', async () => {
  const s = await setup({ change: (m) => [m.type === 'ARTIFACT_BEGIN' ? { ...m, width: 32767, height: 8192 } : m] });
  await assert.rejects(exchange(s), (error) => error.code === 'transfer-failed');
  assert.equal(s.messages.filter((m) => m.type === 'ARTIFACT_CHUNK').length, 0);
  assert.ok(s.source.transfer.estimateWorkingBytes(32 * 1024 * 1024) < 512 * 1024 * 1024);
});
test('Cancel before commit leaves no delivery and disconnect after commit is unknown', async () => {
  for (const committed of [false, true]) {
    const clock = fakeClock();
    const { sessions } = await loadRuntime(['capture-session.js']);
    const owner = sessions.install({ run: async () => new Blob([png], { type: 'image/png' }), now: clock.now, schedule: clock.schedule });
    owner.start({ destination: 'download' }); await flush();
    const { sessionId } = owner.snapshot();
    owner.beginTransfer(sessionId, 'transfer');
    if (committed) { assert.equal(owner.commitDelivery(sessionId, 'transfer'), true); owner.disconnectTransfer('transfer');
      assert.equal(owner.snapshot().deliveryOutcome, 'unknown'); assert.ok(owner.artifact(sessionId)); }
    else { owner.cancel(sessionId); assert.equal(owner.commitDelivery(sessionId, 'transfer'), false); }
    owner.dispose();
  }
});
test('save refuses page origin', async () => {
  let pageDocumentAnchorCount = 0;
  const { delivery } = await loadRuntime(files, { location: { protocol: 'https:' },
    document: { createElement() { pageDocumentAnchorCount++; } } });
  assert.equal(typeof delivery?.save, 'function', 'popup delivery API exists');
  assert.throws(() => delivery.save(new Blob([png], { type: 'image/png' }), 'capture.png'), /extension/);
  assert.equal(pageDocumentAnchorCount, 0);
});
test('popup URL registry survives handoff then revokes on timer or teardown', async () => {
  const urls = new Set(); const timers = []; const events = new Map(); const anchors = [];
  const { delivery } = await loadRuntime(files, { location: { protocol: 'chrome-extension:' },
    URL: { createObjectURL() { const url = `blob:${urls.size}`; urls.add(url); return url; }, revokeObjectURL: (url) => urls.delete(url) },
    setTimeout: (fn, delay) => { timers.push({ fn, delay }); return timers.length; }, clearTimeout() {},
    addEventListener: (name, fn) => events.set(name, fn),
    document: { body: { appendChild() {} }, createElement: () => { const anchor = { click() {}, remove() {} }; anchors.push(anchor); return anchor; } } });
  assert.equal(typeof delivery?.save, 'function', 'popup delivery API exists');
  assert.deepEqual({ ...delivery.save(new Blob([png], { type: 'image/png' }), 'capture.png') }, { outcome: 'started' });
  assert.equal(urls.size, 1); assert.equal(timers[0].delay, 1000); assert.equal(anchors[0].download, 'capture.png');
  timers[0].fn(); assert.equal(urls.size, 0);
  delivery.save(new Blob([png], { type: 'image/png' }), 'capture.png');
  events.get('pagehide')(); assert.equal(urls.size, 0);
  assert.throws(() => delivery.save(new Blob([png], { type: 'image/png' }), 'late.png'));
  assert.equal(anchors.length, 2, 'teardown fences late save continuations');
});

test('PNG validation preserves the transfer checkpoint error and closes its bitmap', async () => {
  let closed = 0;
  const s = await setup({ decode: async () => ({ width: 1, height: 1, close() { closed++; } }) });
  const ctx = context().ctx;
  ctx.checkpoint = () => { throw Object.assign(new Error('work-timeout'), { code: 'work-timeout' }); };
  await assert.rejects(s.target.delivery.validate(new Blob([png], { type: 'image/png' }), { width: 1, height: 1 }, ctx),
    (error) => error.code === 'work-timeout');
  assert.equal(closed, 1);
});
