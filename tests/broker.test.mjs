import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { loadRuntime, loadContext, inject, deferred, flush, fakeClock } from './helpers/runtime.mjs';

const sender = (tabId = 1, windowId = 10, documentId = 'browser-document') => ({
  id: 'extension', frameId: 0, documentId, url: 'http://example.test/',
  tab: { id: tabId, windowId },
});
async function setup(capture, globals = {}) {
  let time = 0;
  let active = { 10: 1, 20: 2 };
  let updates = 0;
  const runtime = await loadRuntime(['capture-broker.js'], { crypto: webcrypto, ...globals });
  assert.ok(runtime.broker, 'broker API exists');
  const broker = runtime.broker.create({ runtimeId: 'extension', now: () => time,
    wait: async (ms) => { time += ms; }, tabs: {
      query: async ({ windowId, active: isActive }) => {
        assert.equal(isActive, true);
        return [{ id: active[windowId], windowId }];
      },
      update: async () => { updates++; },
      captureVisibleTab: capture || (async () => 'data:image/png;base64,YQ=='),
    } });
  const request = (s = sender(), extra = {}) => ({ type: 'CAPTURE_TILE', protocolVersion: 6,
    requestId: `request-${Math.random()}`, documentId: 'content-document', sessionId: 'session',
    tileIndex: 0, generation: broker.hello(s).generation, ...extra });
  return { broker, request, active, updates: () => updates, advance: (ms) => { time += ms; }, now: () => time };
}
const code = (expected) => (error) => { assert.equal(error.code, expected); return true; };

test('switch away and back invalidates in flight tile', async () => {
  const pending = deferred();
  const f = await setup(() => pending.promise);
  const result = f.broker.capture(f.request(), sender());
  await flush();
  f.active[10] = 3; f.broker.invalidate({ windowId: 10 });
  f.active[10] = 1; f.broker.invalidate({ windowId: 10 });
  pending.resolve('secret-bytes');
  await assert.rejects(result, code('target-changed'));
  assert.equal(f.updates(), 0);
});
test('forged sender is rejected', async () => {
  const f = await setup();
  for (const bad of [{ ...sender(), id: 'other' }, { ...sender(), frameId: 1 },
    { ...sender(), documentId: undefined }, { ...sender(), tab: undefined },
    { ...sender(), url: 'chrome://settings' }]) {
    assert.throws(() => f.broker.hello(bad), code('invalid-sender'));
    await assert.rejects(f.broker.capture(f.request(), bad), code('invalid-sender'));
  }
});
test('worker generation mismatch fails', async () => {
  const a = await setup(); const b = await setup();
  assert.notEqual(a.broker.hello(sender()).generation, b.broker.hello(sender()).generation);
  await assert.rejects(b.broker.capture(a.request(), sender()), code('worker-interrupted'));
});
test('two windows share capture rate limiter', async () => {
  let f; let running = 0; let maxConcurrent = 0; const times = [];
  f = await setup(async () => { times.push(f.now()); running++; maxConcurrent = Math.max(running, maxConcurrent);
    await flush(); running--; return 'data:image/png;base64,YQ=='; });
  await Promise.all([f.broker.capture(f.request(), sender()),
    f.broker.capture(f.request(sender(2, 20)), sender(2, 20))]);
  assert.ok(times[1] - times[0] >= 600);
  assert.equal(maxConcurrent, 1);
});
test('changed window and stale tile index fail without returning bytes', async () => {
  const f = await setup(); const req = f.request();
  await f.broker.capture(req, sender());
  await assert.rejects(f.broker.capture({ ...req, requestId: 'next' }, sender()), code('invalid-request'));
  await assert.rejects(f.broker.capture({ ...req, tileIndex: 1 }, sender(1, 20)), code('target-changed'));
  await assert.rejects(f.broker.capture({ ...req, tileIndex: 1, documentId: 'forged' }, sender()), code('invalid-request'));
});
test('navigation while awaiting capture discards screenshot', async () => {
  const pending = deferred(); const f = await setup(() => pending.promise);
  const result = f.broker.capture(f.request(), sender()); await flush();
  f.broker.invalidate({ tabId: 1 }); pending.resolve('secret');
  await assert.rejects(result, code('target-changed'));
});
test('quota rejection is coded and queue recovers', async () => {
  let calls = 0; const f = await setup(async () => {
    if (++calls === 1) throw new Error('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND');
    return 'data:image/png;base64,YQ==';
  });
  await assert.rejects(f.broker.capture(f.request(), sender()), code('capture-failed'));
  assert.equal((await f.broker.capture(f.request(), sender())).tileIndex, 0);
});
const digest = (f, type, extra = {}) => ({ ...f.request(), type, transferId: 'transfer', chunkIndex: 0, ...extra });
test('digest sequential chunks hash native worker bytes and clear completed buffer', async () => {
  const f = await setup(); const begin = digest(f, 'DIGEST_BEGIN', { byteLength: 3 });
  assert.equal((await f.broker.digestMessage(begin, sender())).chunkIndex, 0);
  await f.broker.digestMessage(digest(f, 'DIGEST_CHUNK', { data: 'YWJj' }), sender());
  const reply = await f.broker.digestMessage(digest(f, 'DIGEST_END', { chunkIndex: 1 }), sender());
  assert.equal(reply.digest, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  await assert.rejects(f.broker.digestMessage(digest(f, 'DIGEST_END', { chunkIndex: 1 }), sender()), code('invalid-request'));
});
test('digest rejects chunk order size and session mismatch', async () => {
  for (const patch of [{ chunkIndex: 1 }, { data: btoa('a'.repeat(262145)) }, { sessionId: 'other' },
    { documentId: 'other' }, { transferId: 'other' }]) {
    const f = await setup();
    await f.broker.digestMessage(digest(f, 'DIGEST_BEGIN', { byteLength: 3 }), sender());
    await assert.rejects(f.broker.digestMessage(digest(f, 'DIGEST_CHUNK', { data: 'YWJj', ...patch }), sender()), code('invalid-request'));
  }
});
test('digest expires stalled buffers and rejects oversized artifacts', async () => {
  const f = await setup();
  await assert.rejects(f.broker.digestMessage(digest(f, 'DIGEST_BEGIN', { byteLength: 33554433 }), sender()), code('memory-limit'));
  await f.broker.digestMessage(digest(f, 'DIGEST_BEGIN', { byteLength: 3 }), sender());
  f.advance(10000);
  await assert.rejects(f.broker.digestMessage(digest(f, 'DIGEST_CHUNK', { data: 'YWJj' }), sender()), code('invalid-request'));
});
test('aggregate digest memory ceiling rejects reservations and expiry frees capacity', async () => {
  const f = await setup();
  await f.broker.digestMessage(digest(f, 'DIGEST_BEGIN', { byteLength: 33554432 }), sender());
  await assert.rejects(f.broker.digestMessage(digest(f, 'DIGEST_BEGIN', { byteLength: 33554432,
    sessionId: 'second' }), sender()), code('memory-limit'));
  f.advance(10000);
  await f.broker.digestMessage(digest(f, 'DIGEST_BEGIN', { byteLength: 33554432,
    sessionId: 'second' }), sender());
});

test('fresh authenticated digest supersedes abandoned receiving transfer and fences stale identities', async () => {
  const f = await setup();
  const old = digest(f, 'DIGEST_BEGIN', { byteLength: 33554432 });
  await f.broker.digestMessage(old, sender());
  // Forged session/document/generation/sender cannot free the original reservation.
  for (const patch of [{ sessionId: 'forged' }, { documentId: 'forged' }, { generation: 'stale' }]) {
    await assert.rejects(f.broker.digestMessage({ ...old, ...patch, transferId: 'new' }, sender()));
  }
  await assert.rejects(f.broker.digestMessage({ ...old, transferId: 'new' }, { ...sender(), frameId: 1 }), code('invalid-sender'));
  await assert.rejects(f.broker.digestMessage(digest(f, 'DIGEST_BEGIN', { sessionId: 'other-session', byteLength: 33554432 }), sender()), code('memory-limit'));
  const next = { ...old, transferId: 'fresh', byteLength: 3 };
  await f.broker.digestMessage(next, sender());
  await assert.rejects(f.broker.digestMessage(old, sender()), code('invalid-request'));
  await assert.rejects(f.broker.digestMessage(digest(f, 'DIGEST_CHUNK', { data: 'YWJj' }), sender()), code('invalid-request'));
  await f.broker.digestMessage({ ...next, type: 'DIGEST_CHUNK', data: 'YWJj' }, sender());
  const result = await f.broker.digestMessage({ ...next, type: 'DIGEST_END', chunkIndex: 1 }, sender());
  assert.equal(result.digest, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  await assert.rejects(f.broker.digestMessage(next, sender()), code('invalid-request'));
});

test('superseded native hash retains its reservation until native settlement without shadowing fresh digest', async () => {
  const pending = deferred(); let calls = 0;
  const f = await setup(undefined, { crypto: { randomUUID: () => 'worker', subtle: {
    digest: (...args) => ++calls === 1 ? pending.promise : webcrypto.subtle.digest(...args),
  } } });
  const old = digest(f, 'DIGEST_BEGIN', { byteLength: 33554432 });
  await f.broker.digestMessage(old, sender());
  const chunk = btoa('x'.repeat(262144));
  for (let index = 0; index < 128; index++) await f.broker.digestMessage({ ...old, type: 'DIGEST_CHUNK', chunkIndex: index, data: chunk }, sender());
  const hashing = f.broker.digestMessage({ ...old, type: 'DIGEST_END', chunkIndex: 128 }, sender());
  const rejected = assert.rejects(hashing, code('external-timeout'));
  const fresh = { ...old, transferId: 'fresh', byteLength: 3 };
  await f.broker.digestMessage(fresh, sender());
  await f.broker.digestMessage({ ...fresh, type: 'DIGEST_CHUNK', data: 'YWJj' }, sender());
  await assert.rejects(f.broker.digestMessage({ ...old, sessionId: 'other', transferId: 'large-retry' }, sender()), code('memory-limit'));
  pending.resolve(new Uint8Array(32).buffer); await rejected;
  // Late old-hash release must not delete or invalidate this replacement.
  assert.equal((await f.broker.digestMessage({ ...fresh, type: 'DIGEST_END', chunkIndex: 1 }, sender())).digest,
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  await f.broker.digestMessage({ ...old, sessionId: 'other', transferId: 'after-settlement' }, sender());
});

test('native digest timeout retains memory reservation until native promise settles', async () => {
  const clock = fakeClock(); const pending = deferred();
  const f = await setup(undefined, { crypto: { randomUUID: () => 'worker', subtle: { digest: () => pending.promise } },
    setTimeout: (fn, ms) => clock.schedule(fn, ms), clearTimeout: (cancel) => cancel?.(),
  });
  const old = digest(f, 'DIGEST_BEGIN', { byteLength: 33554432 });
  await f.broker.digestMessage(old, sender());
  const chunk = btoa('x'.repeat(262144));
  for (let index = 0; index < 128; index++) await f.broker.digestMessage({ ...old, type: 'DIGEST_CHUNK', chunkIndex: index, data: chunk }, sender());
  const hashing = f.broker.digestMessage({ ...old, type: 'DIGEST_END', chunkIndex: 128 }, sender());
  const rejected = assert.rejects(hashing, code('external-timeout'));
  await clock.advance(10000); await rejected;
  await assert.rejects(f.broker.digestMessage({ ...old, sessionId: 'other', transferId: 'fresh' }, sender()), code('memory-limit'));
  pending.resolve(new Uint8Array(32).buffer); await flush();
  await f.broker.digestMessage({ ...old, sessionId: 'other', transferId: 'after-settlement' }, sender());
});
test('browser and content document identities are distinct and hello does not reset tile counter', async () => {
  const f = await setup();
  await f.broker.capture(f.request(), sender());
  f.broker.hello(sender());
  await assert.rejects(f.broker.capture(f.request(), sender()), code('invalid-request'));
  const replacement = sender(1, 10, 'new-browser-document');
  const stale = f.request();
  f.broker.hello(replacement);
  await assert.rejects(f.broker.capture(stale, sender()), code('target-changed'));
  assert.equal((await f.broker.capture(f.request(replacement, { documentId: 'new-content-document' }), replacement)).tileIndex, 0);
});
test('more than 64 sequential capture sessions preserve old tile replay fences', async () => {
  const f = await setup();
  const first = f.request(sender(), { sessionId: 'session-0' });
  for (let index = 0; index < 80; index++) {
    const result = await f.broker.capture(f.request(sender(), { sessionId: `session-${index}` }), sender());
    assert.equal(result.tileIndex, 0);
  }
  await assert.rejects(f.broker.capture(first, sender()), code('invalid-request'));
});
test('navigation clears document session metadata while activation retains replay fences', async () => {
  const f = await setup(); const request = f.request();
  await f.broker.capture(request, sender());
  f.broker.invalidate({ windowId: 10 });
  await assert.rejects(f.broker.capture(request, sender()), code('invalid-request'));
  const next = { ...request, requestId: 'next', tileIndex: 1 };
  f.broker.invalidate({ tabId: 1 });
  await assert.rejects(f.broker.capture(next, sender()), code('target-changed'));
  // A fresh HELLO re-establishes a document after navigation/removal invalidation.
  f.broker.hello(sender());
  assert.equal((await f.broker.capture(request, sender())).tileIndex, 0);
});
test('capture timeout fences late bytes and never overlaps pending native call', async () => {
  const clock = fakeClock(); const pending = deferred(); let calls = 0;
  const f = await setup(() => { calls++; return pending.promise; }, {
    setTimeout: (fn, ms) => clock.schedule(fn, ms), clearTimeout: (cancel) => cancel?.(),
  });
  const first = f.broker.capture(f.request(), sender());
  const rejected = assert.rejects(first, code('external-timeout'));
  await flush(); await clock.advance(10000); await rejected;
  const second = f.broker.capture(f.request(sender(2, 20)), sender(2, 20));
  await flush(); assert.equal(calls, 1);
  pending.resolve('data:image/png;base64,YQ==');
  await second; assert.equal(calls, 2);
});
test('background routes authenticated broker replies and activation invalidates pending request', async () => {
  const listeners = []; const events = {}; const pending = deferred();
  const tabs = { query: async () => [{ id: 1, windowId: 10 }], captureVisibleTab: () => pending.promise };
  for (const name of ['onActivated', 'onUpdated', 'onRemoved', 'onDetached']) {
    tabs[name] = { addListener: (listener) => { events[name] = listener; } };
  }
  const context = await loadContext(['capture-broker.js'], {
    crypto: webcrypto, importScripts: () => {}, chrome: { tabs,
      runtime: { id: 'extension', onMessage: { addListener: (listener) => listeners.push(listener) } } },
  });
  await inject(context, 'background.js');
  const send = (request) => new Promise((resolve) => assert.equal(listeners[0](request, sender(), resolve), true));
  const hello = await send({ type: 'BROKER_HELLO' });
  assert.equal(hello.success, true);
  const capture = send({ type: 'CAPTURE_TILE', protocolVersion: 6, generation: hello.generation,
    documentId: 'content-document', sessionId: 'session', requestId: 'request', tileIndex: 0 });
  await flush();
  events.onActivated({ tabId: 3, windowId: 10 });
  events.onActivated({ tabId: 1, windowId: 10 });
  pending.resolve('secret');
  const reply = await capture;
  assert.equal(reply.errorCode, 'target-changed');
  assert.equal(reply.dataUrl, undefined);
});
