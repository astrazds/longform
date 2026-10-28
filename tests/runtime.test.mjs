import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { loadRuntime, loadContext, inject, deferred, flush } from './helpers/runtime.mjs';

const { geometry } = await loadRuntime(['capture-geometry.js']);

function event() {
  const listeners = new Set();
  return { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn),
    emit: (...args) => [...listeners].forEach((fn) => fn(...args)), size: () => listeners.size };
}
function ports() {
  const a = { name: 'longform-session:v6', onMessage: event(), onDisconnect: event() };
  const b = { name: a.name, onMessage: event(), onDisconnect: event(), sender: { id: 'extension', frameId: 0 } };
  a.postMessage = (message) => queueMicrotask(() => b.onMessage.emit(message));
  b.postMessage = (message) => queueMicrotask(() => a.onMessage.emit(message));
  a.disconnect = b.disconnect = () => { a.onDisconnect.emit(); b.onDisconnect.emit(); };
  return [a, b];
}
async function sessionBridge({ run, send = async () => {} } = {}) {
  const onConnect = event();
  const context = await loadContext(['capture-session.js'], {
    chrome: { runtime: { id: 'extension', onConnect, onMessage: event() } },
    window: { top: null, addEventListener() {} },
  });
  context.window.top = context.window;
  context.Longform.capture = { run: run || (async () => new Blob(['png'], { type: 'image/png' })) };
  context.Longform.transfer = { send };
  await inject(context, 'content.js');
  const owner = context.Longform.sessions.install({ run });
  const links = [];
  const connect = () => { const [a,b] = ports(); links.push(b); onConnect.emit(b); return a; };
  const popup = await loadContext(['clipboard.js', 'popup.js'], {
    document: { addEventListener() {} }, location: { protocol: 'chrome-extension:' },
    crypto: { randomUUID: () => `id-${Math.random()}` },
    chrome: { tabs: { connect }, runtime: { id: 'extension' } },
  });
  return { context, owner, popup, onConnect, links };
}

test('v6 reopen attaches to one capture and commit waits for the exact producer promise', async () => {
  const work = deferred(); const sent = deferred(); let calls = 0;
  const { context, owner, popup, onConnect } = await sessionBridge({
    run: () => { calls++; return work.promise; }, send: () => sent.promise,
  });
  assert.equal(typeof popup.Longform.popup?.connectSession, 'function', 'managed session client exists');
  const first = await popup.Longform.popup.connectSession(1);
  const original = await first.start('download');
  first.disconnect();
  await inject(context, 'capture-geometry.js'); await inject(context, 'capture-page.js');
  const dependencies = { ...context.Longform };
  for (const file of context.Longform.protocol.contentFiles) await inject(context, file);
  for (const name of ['geometry', 'page', 'capture', 'sessions', 'transfer']) assert.equal(context.Longform[name], dependencies[name]);
  assert.equal(onConnect.size(), 1, 'reinjection does not replace subscription owner');
  const reopened = await popup.Longform.popup.connectSession(1);
  assert.equal(reopened.snapshot().sessionId, original.sessionId);
  work.resolve(new Blob(['png'], { type: 'image/png' })); await flush();
  // The receiver is independently tested; this boundary exercises producer/commit ordering.
  popup.Longform.transfer = { receive: async () => new Blob(['png'], { type: 'image/png' }) };
  const artifact = await reopened.artifact();
  const commit = reopened.commit(artifact.transferId);
  await flush();
  assert.equal(owner.snapshot().phase, 'transferring');
  sent.resolve();
  await commit;
  assert.equal(owner.snapshot().phase, 'delivering');
  await reopened.result(artifact.transferId, 'success');
  assert.equal(owner.snapshot().phase, 'completed');
  assert.equal(calls, 1);
  await reopened.start('clipboard'); await flush();
  assert.equal(reopened.snapshot().phase, 'ready-to-deliver');
  await reopened.artifact();
  reopened.disconnect(); owner.dispose();
});

test('concurrent clients grant one producer and losing disconnect cannot disturb the winner', async (t) => {
  const producers = [];
  const { owner, popup } = await sessionBridge({ send: async (_, options) => { producers.push(options); } });
  t.after(() => owner.dispose());
  popup.Longform.transfer = { receive: async () => new Blob(['png'], { type: 'image/png' }) };
  const winner = await popup.Longform.popup.connectSession(1);
  const loser = await popup.Longform.popup.connectSession(1);
  t.after(() => { winner.disconnect(); loser.disconnect(); });
  await winner.start('download'); await flush();
  assert.equal(winner.snapshot().phase, 'ready-to-deliver');
  assert.equal(loser.snapshot().phase, 'ready-to-deliver');

  const results = await Promise.allSettled([winner.artifact(), loser.artifact()]);
  assert.equal(producers.length, 1, 'only the port that acquires the owner may start production');
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected', 'losing client cannot obtain an artifact');
  loser.disconnect(); await flush();
  assert.equal(owner.snapshot().phase, 'transferring');
  assert.equal(producers[0].ctx.signal.aborted, false);
  producers[0].ctx.checkpoint();
  const { transferId } = results[0].value;
  assert.equal(transferId, producers[0].transferId);
  await winner.commit(transferId);
  assert.equal(owner.snapshot().phase, 'delivering');
  await winner.result(transferId, 'success');
  assert.equal(owner.snapshot().phase, 'completed');
});

for (const corruption of ['sequence', 'version', 'count', 'expiry']) {
  test(`client rejects ${corruption} corruption before replacing its authoritative snapshot`, async (t) => {
    const { owner, popup, links } = await sessionBridge();
    t.after(() => owner.dispose());
    const client = await popup.Longform.popup.connectSession(1);
    await client.start('download'); await flush();
    const original = client.snapshot();
    let alive = true; client.subscribe((_, connected) => { alive = connected; });
    const snapshot = { ...original };
    if (corruption === 'sequence') snapshot.sequence--;
    if (corruption === 'count') snapshot.sections = -1;
    if (corruption === 'expiry') snapshot.expiresAt = 'tomorrow';
    links[0].postMessage({ type: 'SNAPSHOT', protocolVersion: 6,
      runtimeVersion: corruption === 'version' ? 'old-runtime' : '2026-10-28-managed-v1',
      documentId: snapshot.documentId, sessionId: snapshot.sessionId, requestId: 'corrupt', snapshot });
    await flush();
    assert.equal(alive, false);
    assert.equal(client.snapshot(), original);
    owner.dispose();
  });
}

test('a lost commit reply records unknown and rejects without repeating delivery', async (t) => {
  const { owner, popup, links } = await sessionBridge();
  t.after(() => owner.dispose());
  popup.Longform.transfer = { receive: async () => new Blob(['png'], { type: 'image/png' }) };
  const client = await popup.Longform.popup.connectSession(1);
  await client.start('download'); await flush();
  const artifact = await client.artifact();
  const post = links[0].postMessage;
  let dropped = false;
  links[0].postMessage = (reply) => {
    if (!dropped && reply.replyTo && reply.snapshot.phase === 'delivering') { dropped = true; throw new Error('Popup closed'); }
    post(reply);
  };
  await assert.rejects(() => client.commit(artifact.transferId), { code: 'delivery-unknown' });
  assert.equal(owner.snapshot().deliveryOutcome, 'unknown');
  assert.equal(owner.snapshot().phase, 'failed');
  assert.ok(owner.artifact(client.snapshot().sessionId) instanceof Blob);
});

test('popup cancellation waits for runner cleanup and disconnect does not cancel capture', async () => {
  const work = deferred(); let runContext;
  const { owner, popup } = await sessionBridge({ run: (ctx) => { runContext = ctx; return work.promise; } });
  const client = await popup.Longform.popup.connectSession(1);
  const start = await client.start('download'); client.disconnect();
  assert.equal(runContext.signal.aborted, false);
  const recovery = await popup.Longform.popup.connectSession(1);
  assert.equal(recovery.snapshot().sessionId, start.sessionId);
  await recovery.cancel();
  assert.equal(runContext.signal.aborted, true);
  assert.equal(recovery.snapshot().phase, 'cancelling');
  work.resolve(new Blob(['png'], { type: 'image/png' })); await flush();
  assert.equal(recovery.snapshot().phase, 'cancelled');
  await assert.rejects(() => recovery.artifact(), { code: 'artifact-unavailable' });
  recovery.disconnect(); owner.dispose();
});

test('legacy runtime is rejected before protocol replacement', async () => {
  const context = vm.createContext({ Longform: { captureFullPage() {} } });
  const legacy = context.Longform;
  assert.throws(() => vm.runInContext(awaitProtocol, context), { code: 'reload-required' });
  assert.equal(context.Longform, legacy);
  assert.equal(context.Longform.protocol, undefined);
});
const awaitProtocol = await readFile(new URL('../protocol.js', import.meta.url), 'utf8');

test('snapshot renderer keeps progress incomplete through cleanup and offers explicit recovery', async () => {
  const { popup } = await loadRuntime(['clipboard.js', 'popup.js'], { document: { addEventListener() {} } });
  assert.equal(typeof popup?.view, 'function', 'snapshot renderer exists');
  const base = { phase: 'preparing', section: 0, sections: 0, attempt: 1, canCancel: true };
  assert.equal(popup.view(base, true, true).text, 'Preparing page…');
  assert.equal(popup.view(base, true, true).determinate, false);
  for (const phase of ['capturing', 'validating', 'restoring', 'encoding', 'transferring']) {
    const view = popup.view({ ...base, phase, section: 12, sections: 12 }, true, true);
    assert.equal(view.busy, true); assert.equal(view.cancel, true);
    assert.equal(view.value < 1, true, 'cleanup precedes complete progress');
  }
  assert.equal(popup.view({ ...base, phase: 'ready-to-deliver' }, true, true).text,
    'Capture ready. Choose Save or Copy.');
  assert.equal(popup.view({ ...base, phase: 'expired' }, true, true).busy, false);
  assert.match(popup.view({ ...base, phase: 'failed', deliveryOutcome: 'unknown' }, true, true).text, /may have completed/);
  assert.equal(popup.view({ ...base, phase: 'failed', deliveryOutcome: 'unknown', expiresAt: 100 }, true, true, 100).text,
    'Delivery may have completed. Capture expired. Choose Save or Copy to capture again.');
  assert.equal(popup.view({ ...base, phase: 'completed', destination: 'download' }, true, true).text, 'Download started.');
});

test('tile planning covers both edges and retains the actual scroll limit', () => {
  assert.deepEqual([...geometry.getCapturePositions(2000, 720, 1280)], [0, 560, 1120, 1280]);
  assert.deepEqual([...geometry.getCapturePositions(2000, 720, 1300)], [0, 560, 1120, 1280, 1300]);
  assert.deepEqual([...geometry.getCapturePositions(400, 720, 0)], [0]);
  assert.deepEqual([...geometry.getCapturePositions(400, 720, 12)], [0, 12]);
});

test('canvas limits apply after device-pixel scaling', () => {
  const size = geometry.getCanvasSize({ pageWidth: 800, pageHeight: 1200, pixelRatio: 1.25 });
  assert.deepEqual({ ...size }, { width: 1000, height: 1500 });
  for (const metrics of [
    { pageWidth: 0, pageHeight: 100, pixelRatio: 1 },
    { pageWidth: 800, pageHeight: 16384, pixelRatio: 2 },
    { pageWidth: 20000, pageHeight: 20000, pixelRatio: 1 },
  ]) {
    assert.throws(() => geometry.getCanvasSize(metrics), /captureable area|too large/);
  }
});

test('the final tile is clipped to the canvas at its actual scroll position', () => {
  const calls = [];
  const context = { canvas: { width: 1280, height: 800 }, drawImage: (...args) => calls.push(args) };
  const bitmap = { width: 1280, height: 720 };
  const metrics = { pageWidth: 1280, pageHeight: 800, viewportWidth: 1280, viewportHeight: 720, pixelRatio: 1 };
  assert.deepEqual({ ...geometry.drawCapture(context, bitmap, metrics, 0, 560) }, {
    left: 0, top: 560, right: 1280, bottom: 800,
  });
  assert.deepEqual(calls, [[bitmap, 0, 0, 1280, 240, 0, 560, 1280, 240]]);
  assert.equal(geometry.drawCapture(context, bitmap, metrics, 1280, 800), null);
  assert.equal(calls.length, 1);
});

test('fractional scroll coordinates use device pixels without crossing canvas edges', () => {
  const calls = [];
  const context = { canvas: { width: 875, height: 1000 }, drawImage: (...args) => calls.push(args) };
  const bitmap = { width: 800, height: 600 };
  const metrics = { pageWidth: 700, pageHeight: 800, viewportWidth: 640, viewportHeight: 480, pixelRatio: 1.25 };
  assert.deepEqual({ ...geometry.drawCapture(context, bitmap, metrics, 100.5, 400.5) }, {
    left: 125, top: 500, right: 875, bottom: 1000,
  });
  assert.deepEqual(calls, [[bitmap, 0, 0, 750, 500, 125, 500, 750, 500]]);
});

test('clipboard write starts in original gesture', async () => {
  let called = false;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { clipboard } = await loadRuntime(['clipboard.js'], {
    location: { protocol: 'chrome-extension:' },
    navigator: { clipboard: { write: () => { called = true; return Promise.resolve(); } } },
    ClipboardItem: class { constructor(data) { this.data = data; } },
  });
  assert.equal(typeof clipboard.copyBlobDuringGesture, 'function', 'committed blob clipboard API exists');
  const result = clipboard.copyBlobDuringGesture(() => gate);
  assert.equal(called, true, 'clipboardWriteCalledBeforeFirstAwait');
  release(new Blob(['png'], { type: 'image/png' }));
  assert.deepEqual({ ...await result }, { phrase: 'copied', deliveryOutcome: 'success' });
});

test('blob clipboard early rejection waits for commit callback cleanup', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { clipboard } = await loadRuntime(['clipboard.js'], {
    location: { protocol: 'chrome-extension:' },
    navigator: { clipboard: { write: () => Promise.reject(new Error('permission denied')) } },
    ClipboardItem: class { constructor(data) { this.data = data; } },
  });
  assert.equal(typeof clipboard.copyBlobDuringGesture, 'function', 'committed blob clipboard API exists');
  let settled = false;
  const pending = clipboard.copyBlobDuringGesture(() => gate.then(() => { throw Object.assign(new Error('cancelled'), { code: 'cancelled' }); }));
  pending.then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  release();
  assert.deepEqual({ ...await pending }, { phrase: 'copy-failed', deliveryOutcome: 'failed' });
});

test('blob clipboard preserves unknown commit outcome', async () => {
  const { clipboard } = await loadRuntime(['clipboard.js'], {
    location: { protocol: 'chrome-extension:' },
    navigator: { clipboard: { write: (items) => items[0].data['image/png'] } },
    ClipboardItem: class { constructor(data) { this.data = data; } },
  });
  const result = await clipboard.copyBlobDuringGesture(() => {
    throw Object.assign(new Error('disconnected'), { code: 'delivery-unknown' });
  });
  assert.equal(result.deliveryOutcome, 'unknown');
});
