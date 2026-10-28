import assert from 'node:assert/strict';
import test from 'node:test';
import { loadContext, inject, deferred, flush, fakeClock } from './helpers/runtime.mjs';

const coded = (code) => Object.assign(new Error(code), { code });
async function setup(options = {}) {
  const clock = fakeClock();
  const pending = deferred();
  const events = new Map();
  const messages = new Set();
  const stats = { snapshots: 0, preparations: 0, restores: 0, disposed: 0, allocations: 0,
    scrolls: [], tiles: [], draws: [], closes: 0, encodes: [], encodedSizes: [], canvases: [], requests: [], cleanupAt: null };
  let generation = 0;
  let scrollX = 0;
  let scrollY = 0;
  let rootHeight = options.height || 200;
  let owner;
  let held = false;
  const hold = async (stage) => {
    if (options.hold === stage && !held) { held = true; stats.held = stage; await pending.promise; }
  };
  const viewportWidth = options.viewportWidth || 100, viewportHeight = options.viewportHeight || 100;
  const pixelRatio = options.pixelRatio || 1;
  const metrics = () => ({ pageWidth: options.width || 100, pageHeight: rootHeight,
    viewportWidth, viewportHeight, pixelRatio, scrollX, scrollY,
    scrollLimits: { maxScrollX: Math.max(0, (options.width || 100) - viewportWidth), maxScrollY: Math.max(0, rootHeight - viewportHeight) } });
  const context = await loadContext(['capture-geometry.js', 'capture-session.js', 'capture.js'], {
    window: { addEventListener(type, fn) { if (!events.has(type)) events.set(type, new Set()); events.get(type).add(fn); },
      removeEventListener(type, fn) { events.get(type)?.delete(fn); } },
    document: { visibilityState: options.hidden ? 'hidden' : 'visible',
      addEventListener(type, fn) { if (!events.has(type)) events.set(type, new Set()); events.get(type).add(fn); },
      removeEventListener(type, fn) { events.get(type)?.delete(fn); },
      createElement(type) {
      assert.equal(type, 'canvas');
      const id = ++stats.allocations;
      const canvas = { width: 0, height: 0, getContext() { return { canvas, fillRect() {},
        drawImage() { stats.draws.push({ id, attempt: owner.snapshot().attempt }); } }; },
      toBlob(callback) {
        stats.encodes.push(id); stats.encodedSizes.push([canvas.width, canvas.height]);
        if (options.encodingFailure === 'throw' && id === 1) throw new Error('Native encoding failed');
        void hold('encoding').then(() => callback(options.encodingFailure === 'null' && id === 1 ? null
          : new Blob(options.oversizedPng ? [new Uint8Array(32 * 1024 * 1024 + 1)] : [String(id)], { type: 'image/png' })));
      } };
      stats.canvases.push(canvas);
      return canvas;
    } },
    fetch: async () => {
      const fetchIndex = stats.fetches = (stats.fetches || 0) + 1; await hold('fetch');
      if (options.tileFailure === 'fetch' && fetchIndex === 1) throw new Error('Native fetch failed');
      return { blob: async () => {
        await hold('blob');
        if (options.tileFailure === 'blob' && fetchIndex === 1) throw new Error('Native Blob failed');
        return new Blob(['tile']);
      } };
    },
    createImageBitmap: async () => {
      stats.decodes = (stats.decodes || 0) + 1; const decode = stats.decodes; await hold('bitmap');
      if (options.decodeFailure && decode === 1) throw new Error('Native decode failed');
      return { width: Math.ceil(viewportWidth * pixelRatio), height: Math.ceil(viewportHeight * pixelRatio),
        close() { stats.closes++; (stats.closeAllocations ||= []).push(stats.allocations); } };
    },
    chrome: { runtime: { id: 'extension',
      onMessage: { addListener(fn) { messages.add(fn); }, removeListener(fn) { messages.delete(fn); } },
      async sendMessage(request) {
      stats.requests.push(request);
      if (request.type === 'BROKER_HELLO') { await hold('hello'); return { success: true, generation: 'worker-one' }; }
      if (request.type === 'BROKER_RELEASE') return { success: true };
      stats.tiles.push(request.tileIndex);
      await hold('screenshot');
      if (owner.snapshot().attempt === 2) await hold('retry-screenshot');
      if (options.screenshotScroll) scrollY = 7;
      if (options.workerInterrupted) return { success: false, errorCode: 'worker-interrupted' };
      if (options.unstable && (options.unstable === 'always' || owner.snapshot().attempt === 1)) generation++;
      return { success: true, generation: 'worker-one', tileIndex: request.tileIndex, dataUrl: 'data:image/png;base64,eA==' };
    } } },
  });
  assert.equal(typeof context.Longform.capture?.run, 'function', 'managed capture API exists');
  context.Longform.page = {
    backgroundColor: () => 'white',
    beginTransaction(ctx) {
      stats.snapshots++;
      return { async prepare() { stats.preparations++; (stats.deadlines ||= []).push(ctx.deadline); const a = ctx.attempt; await hold('preparation'); ctx.checkpoint(a); },
        async scrollTo(x, y) { if (stats.tiles.length === 1) await hold('between-tiles'); ctx.checkpoint(); scrollX = x; scrollY = options.stuck ? 0 : options.fractional && y > 0 && y < rootHeight - 100 ? y + 0.25 : y; if (options.lazyGrowth && y === 100) rootHeight = 300; stats.scrolls.push([x, y]); },
        async restore() { stats.restores++; stats.cleanupAt ??= clock.now(); scrollX = 0; scrollY = 0;
          await hold('restoration'); return { ok: !options.cleanupFailed }; } };
    },
    observeLayout(transaction, ctx) { return { measure: metrics,
      sample: () => ({ ...metrics(), generation, visibleResourcesReady: true, resourceCount: 0 }),
      async settleVisible() { if (options.settlingTimeout) { await new Promise((resolve) => clock.schedule(resolve, 10000)); throw coded(options.settlingTimeout); } stats.elapsed = (stats.elapsed || 0) + (options.workPerSettle || 0); if (options.resourceError) throw coded('resource-failed'); const a = ctx.attempt; await hold(owner.snapshot().phase === 'validating' ? 'validation' : 'settle'); ctx.checkpoint(a); return this.sample(); },
      dispose() { stats.disposed++; } }; },
  };
  owner = context.Longform.sessions.install({ run: context.Longform.capture.run, now: () => clock.now() + (stats.elapsed || 0), schedule: clock.schedule });
  const start = () => owner.start({ destination: 'download' });
  const fire = (type, data = {}) => { for (const fn of [...(events.get(type) || [])]) fn({ type, ...data }); };
  return { owner, stats, clock, start, fire, pending, context, api: context.Longform.capture, document: context.document, runtime: context.chrome.runtime,
    notify(patch = {}, sender = { id: 'extension' }) {
      for (const fn of [...messages]) fn({ type: 'CAPTURE_TARGET_LOST', protocolVersion: 6,
        generation: 'worker-one', documentId: owner.snapshot().documentId, sessionId: owner.snapshot().sessionId, ...patch }, sender);
    } };
}

test('authenticated activity loss stops visible preparation and stale notifications cannot cancel a replacement', async () => {
  const env = await setup({ hold: 'preparation' });
  env.start(); await flush();
  const old = env.owner.snapshot();
  for (const patch of [{ documentId: 'stale' }, { sessionId: 'stale' }, { generation: 'old-worker' }, { protocolVersion: 5 }]) env.notify(patch);
  env.notify({}, { id: 'forged' }); await flush();
  assert.equal(env.stats.restores, 0);
  env.notify(); await flush();
  assert.equal(env.document.visibilityState, 'visible', 'native activity loss need not report visibility loss');
  assert.equal(env.owner.snapshot().errorCode, 'target-changed');
  assert.equal(env.stats.restores, 1);
  env.pending.resolve(); await flush();
  let sentStaleDuringReplacement = false;
  const unsubscribe = env.owner.subscribe((state) => {
    if (state.phase === 'capturing' && !sentStaleDuringReplacement) {
      sentStaleDuringReplacement = true; env.notify({ sessionId: old.sessionId });
    }
  });
  env.start(); await flush();
  assert.notEqual(env.owner.snapshot().sessionId, old.sessionId);
  env.notify({ sessionId: old.sessionId }); await flush();
  assert.equal(env.owner.snapshot().phase, 'ready-to-deliver');
  assert.equal(sentStaleDuringReplacement, true);
  assert.equal(env.stats.requests.filter((request) => request.type === 'BROKER_RELEASE').length, 2);
  unsubscribe(); env.owner.dispose();
});

test('activity loss arriving before the registration reply cannot be forgotten', async () => {
  const env = await setup({ hold: 'hello' }); env.start(); await flush();
  env.notify({ generation: 'old-worker' }); env.notify();
  env.pending.resolve(); await flush();
  assert.equal(env.owner.snapshot().errorCode, 'target-changed');
  assert.equal(env.stats.preparations, 0);
  assert.equal(env.stats.restores, 1);
  assert.equal(env.stats.requests.filter((request) => request.type === 'BROKER_RELEASE').length, 1);
});

test('best-effort activity release cannot mask cleanup failure if messaging throws synchronously', async () => {
  const env = await setup({ cleanupFailed: true });
  const send = env.runtime.sendMessage;
  env.runtime.sendMessage = (request) => {
    if (request.type === 'BROKER_RELEASE') throw new Error('Extension context invalidated');
    return send(request);
  };
  env.start(); await flush();
  assert.equal(env.owner.snapshot().errorCode, 'cleanup-failed');
  assert.throws(env.start, { code: 'reload-required' });
});

// Losing activity must fence the session even when no broker call is in flight.
test('visibility loss latches during preparation and between screenshot requests', async (t) => {
  for (const hold of ['preparation', 'between-tiles']) await t.test(hold, async () => {
    const env = await setup({ hold });
    const { sessionId } = env.start(); await flush();
    assert.equal(env.stats.held, hold);
    const tiles = env.stats.tiles.length;
    env.document.visibilityState = 'hidden'; env.fire('visibilitychange');
    env.document.visibilityState = 'visible'; env.fire('visibilitychange');
    await flush();
    assert.equal(env.stats.restores, 1, 'cleanup starts without waiting for suspended page work');
    assert.equal(env.owner.snapshot().errorCode, 'target-changed');
    const scrolls = env.stats.scrolls.length;
    env.pending.resolve(); await flush();
    assert.equal(env.stats.tiles.length, tiles);
    assert.equal(env.stats.scrolls.length, scrolls);
    assert.deepEqual(env.stats.encodes, []);
    assert.throws(() => env.owner.artifact(sessionId), { code: 'artifact-unavailable' });
  });
});

test('an initially hidden document cannot start preparation', async () => {
  const env = await setup({ hidden: true }); env.start(); await flush();
  assert.equal(env.owner.snapshot().errorCode, 'target-changed');
  assert.equal(env.stats.preparations, 0);
  assert.equal(env.stats.requests.length, 0);
});

// Removing retry or retaining the first canvas makes these artifact assertions fail.
test('finite growth discards first attempt', async () => {
  const { owner, start, stats } = await setup({ unstable: 'first' });
  const { sessionId } = start(); await flush();
  assert.equal(owner.snapshot().phase, 'ready-to-deliver');
  assert.equal(owner.snapshot().attempt, 2);
  assert.equal(await owner.artifact(sessionId).text(), '2');
  assert.deepEqual(stats.encodes, [2]);
  assert.deepEqual(stats.tiles, stats.tiles.map((_, i) => i));
  assert.equal(stats.snapshots, 1);
  assert.equal(stats.restores, 1);
  assert.equal(stats.disposed, 1);
  assert.equal(stats.requests.filter((r) => r.type === 'BROKER_HELLO').length, 1);
  for (const request of stats.requests.filter((r) => r.type === 'CAPTURE_TILE')) {
    assert.equal(request.documentId, owner.snapshot().documentId);
    assert.equal(request.sessionId, sessionId);
    assert.equal(request.generation, 'worker-one');
  }
  owner.dispose();
});

test('second unstable attempt fails', async () => {
  const { owner, start, stats } = await setup({ unstable: 'always' }); start(); await flush();
  assert.equal(owner.snapshot().errorCode, 'unstable-page');
  assert.equal(owner.snapshot().attempt, 2);
  assert.deepEqual(stats.encodes, []);
  assert.equal(stats.snapshots, 1);
  assert.equal(stats.restores, 1);
});

// Each suspended browser boundary must unwind before its delayed result arrives.
test('all cancellation phases fence callbacks', async (t) => {
  for (const hold of ['preparation', 'settle', 'screenshot', 'bitmap', 'validation', 'restoration', 'encoding']) {
    await t.test(hold, async () => {
      const { owner, start, stats, pending, clock } = await setup({ hold });
      const { sessionId } = start(); await flush();
      assert.equal(stats.held, hold);
      const cancelledAt = clock.now();
      owner.cancel(sessionId); await flush();
      assert.ok(stats.cleanupAt !== null && stats.cleanupAt - cancelledAt <= 250);
      const draws = stats.draws.length;
      const scrolls = stats.scrolls.length;
      pending.resolve(); await flush();
      assert.equal(stats.draws.length, draws);
      assert.equal(stats.scrolls.length, scrolls);
      assert.equal(owner.snapshot().phase, 'cancelled');
      assert.equal(stats.snapshots, 1);
      if (hold === 'bitmap') assert.equal(stats.closes, 1);
      assert.equal(stats.disposed, hold === 'preparation' ? 0 : 1);
      assert.throws(() => owner.artifact(sessionId), { code: 'artifact-unavailable' });
    });
  }
});

test('worker interruption still restores page', async () => {
  const { owner, start, stats } = await setup({ workerInterrupted: true }); start(); await flush();
  assert.equal(owner.snapshot().errorCode, 'worker-interrupted');
  assert.equal(stats.restores, 1); assert.equal(stats.snapshots, 1);
  assert.deepEqual(stats.encodes, []);
});

test('memory check precedes allocation', async () => {
  const { owner, start, stats, api } = await setup({ width: 10000, height: 10000 });
  assert.ok(api.estimateWorkingBytes({ canvasPixels: 100, tilePixels: 10, pngBytes: 20 }) < 512 * 1024 * 1024);
  start(); await flush();
  assert.equal(owner.snapshot().errorCode, 'page-too-large');
  assert.equal(stats.allocations, 0); assert.equal(stats.restores, 1);
});

// Summing later transfer copies with the canvas incorrectly rejects this ordinary page.
test('normal full-size HiDPI page captures at native resolution within the phase budget', async () => {
  const env = await setup({ width: 1621, height: 4200, viewportWidth: 1621, viewportHeight: 1378, pixelRatio: 1.5 });
  const { sessionId } = env.start(); await flush();
  assert.equal(env.owner.snapshot().phase, 'ready-to-deliver');
  assert.deepEqual(env.stats.encodedSizes, [[2432, 6300]]);
  assert.equal(await env.owner.artifact(sessionId).text(), '1');
  assert.equal(env.stats.restores, 1);
  assert.ok(env.stats.canvases.every((canvas) => canvas.width === 0 && canvas.height === 0));
  env.owner.dispose();
});

test('4K-width maximized and fullscreen HiDPI pages capture at native resolution', async (t) => {
  for (const viewportHeight of [1392, 1440]) await t.test(`2560x${viewportHeight}@1.5`, async () => {
    const env = await setup({ width: 2560, height: 4200, viewportWidth: 2560, viewportHeight, pixelRatio: 1.5 });
    const { sessionId } = env.start(); await flush();
    assert.equal(env.owner.snapshot().phase, 'ready-to-deliver');
    assert.deepEqual(env.stats.encodedSizes, [[3840, 6300]]);
    assert.equal(await env.owner.artifact(sessionId).text(), '1');
    assert.equal(env.stats.restores, 1);
    assert.ok(env.stats.canvases.every((canvas) => canvas.width === 0 && canvas.height === 0));
    env.owner.dispose();
  });
});

test('genuinely over-budget HiDPI page rejects before allocation and restores', async () => {
  const env = await setup({ width: 5000, height: 5000, viewportWidth: 1621, viewportHeight: 1378, pixelRatio: 1.5 });
  const { sessionId } = env.start(); await flush();
  assert.equal(env.owner.snapshot().errorCode, 'page-too-large');
  assert.equal(env.stats.allocations, 0);
  assert.equal(env.stats.restores, 1);
  assert.throws(() => env.owner.artifact(sessionId), { code: 'artifact-unavailable' });
});

// Each case isolates a phase: the other phase fits512MiB at these dimensions.
test('worst-case encoder and native tile peaks independently reject before allocation', async (t) => {
  for (const [phase, dimensions] of [
    ['encoder', { width: 3000, height: 9000, viewportWidth: 3000, viewportHeight: 1000 }],
    ['tile', { width: 3700, height: 3700, viewportWidth: 3700, viewportHeight: 3700 }],
  ]) await t.test(phase, async () => {
    const env = await setup(dimensions);
    const { sessionId } = env.start(); await flush();
    assert.equal(env.owner.snapshot().errorCode, 'page-too-large');
    assert.equal(env.stats.allocations, 0);
    assert.equal(env.stats.tiles.length, 0);
    assert.equal(env.stats.restores, 1);
    assert.throws(() => env.owner.artifact(sessionId), { code: 'artifact-unavailable' });
  });
});

test('cancelled native encoding must settle before replacement canvas allocation', async () => {
  const env = await setup({ hold: 'encoding' });
  const { sessionId } = env.start(); await flush();
  assert.equal(env.stats.held, 'encoding');
  env.owner.cancel(sessionId); await flush();
  assert.equal(env.owner.snapshot().phase, 'cancelled');
  assert.ok(env.stats.canvases.every((canvas) => canvas.width === 0 && canvas.height === 0));
  await inject(env.context, 'capture.js'); // Reinjection must preserve the live native-encoder gate.
  const next = env.start(); await flush();
  assert.equal(env.stats.allocations, 1, 'the abandoned encoder still owns its native snapshot');
  assert.equal(env.stats.preparations, 2, 'replacement has not prepared while the native encoder remains live');
  env.pending.resolve(); await flush();
  assert.equal(env.owner.snapshot().sessionId, next.sessionId);
  assert.equal(env.owner.snapshot().phase, 'ready-to-deliver');
  assert.equal(await env.owner.artifact(next.sessionId).text(), '2');
  assert.throws(() => env.owner.artifact(sessionId), { code: 'artifact-unavailable' });
  env.owner.dispose();
});

test('cancelled native tile work must release before replacement canvas allocation', async (t) => {
  for (const hold of ['fetch', 'blob', 'bitmap']) for (const stop of ['cancel', 'timeout']) await t.test(`${hold}/${stop}`, async () => {
    const env = await setup({ hold });
    const first = env.start(); await flush();
    assert.equal(env.stats.held, hold);
    if (stop === 'cancel') env.owner.cancel(first.sessionId);
    else await env.clock.advance(10000);
    await flush();
    assert.equal(env.owner.snapshot().phase, stop === 'cancel' ? 'cancelled' : 'failed');
    if (stop === 'timeout') assert.equal(env.owner.snapshot().errorCode, 'external-timeout');
    assert.equal(env.stats.restores, 1);
    assert.ok(env.stats.canvases.every((canvas) => canvas.width === 0 && canvas.height === 0));
    await inject(env.context, 'capture.js');
    const next = env.start(); await flush();
    assert.equal(env.stats.allocations, 1, 'abandoned native tile work still owns storage');
    assert.deepEqual(env.stats.encodes, []);
    env.pending.resolve(); await flush();
    assert.equal(env.owner.snapshot().sessionId, next.sessionId);
    assert.equal(env.owner.snapshot().phase, 'ready-to-deliver');
    if (hold === 'bitmap') assert.equal(env.stats.closeAllocations[0], 1, 'old bitmap closes before replacement allocation');
    assert.equal(env.stats.decodes, env.stats.closes);
    assert.equal(await env.owner.artifact(next.sessionId).text(), '2');
    assert.throws(() => env.owner.artifact(first.sessionId), { code: 'artifact-unavailable' });
    env.owner.dispose();
  });
});

test('replacement waiting for abandoned native work honors cancel and external timeout', async (t) => {
  for (const hold of ['encoding', 'bitmap']) for (const outcome of ['cancel', 'timeout']) await t.test(`${hold}/${outcome}`, async () => {
    const env = await setup({ hold });
    const first = env.start(); await flush(); env.owner.cancel(first.sessionId); await flush();
    const next = env.start(); await flush();
    if (outcome === 'cancel') env.owner.cancel(next.sessionId);
    else await env.clock.advance(10000);
    await flush();
    assert.equal(env.owner.snapshot().phase, outcome === 'cancel' ? 'cancelled' : 'failed');
    if (outcome === 'timeout') assert.equal(env.owner.snapshot().errorCode, 'external-timeout');
    env.pending.resolve(); await flush();
    assert.equal(env.stats.allocations, 1, 'late callback cannot resume the stopped replacement');
    assert.throws(() => env.owner.artifact(next.sessionId), { code: 'artifact-unavailable' });
    const third = env.start(); await flush();
    assert.equal(env.owner.snapshot().phase, 'ready-to-deliver');
    assert.equal(await env.owner.artifact(third.sessionId).text(), '2');
    env.owner.dispose();
  });
});

test('native work wait is bounded by the replacement original work deadline', async (t) => {
  for (const hold of ['encoding', 'bitmap']) await t.test(hold, async () => {
    const env = await setup({ hold });
    const first = env.start(); await flush(); env.owner.cancel(first.sessionId); await flush();
    const unsubscribe = env.owner.subscribe((state) => {
      if (state.phase === 'preparing' && state.sessionId !== first.sessionId) env.stats.elapsed = 119500;
    });
    const next = env.start(); await flush();
    await env.clock.advance(500);
    assert.equal(env.owner.snapshot().errorCode, 'work-timeout');
    assert.equal(env.stats.allocations, 1);
    env.pending.resolve(); await flush();
    assert.throws(() => env.owner.artifact(next.sessionId), { code: 'artifact-unavailable' });
    assert.equal(env.stats.allocations, 1);
    unsubscribe(); env.owner.dispose();
  });
});

test('native tile failure releases its lifetime gate for a new capture', async (t) => {
  for (const tileFailure of ['fetch', 'blob', 'bitmap']) await t.test(tileFailure, async () => {
    const env = await setup({ tileFailure, decodeFailure: tileFailure === 'bitmap' });
    env.start(); await flush();
    assert.equal(env.owner.snapshot().phase, 'failed');
    assert.equal(env.stats.restores, 1);
    const next = env.start(); await flush();
    assert.equal(env.owner.snapshot().phase, 'ready-to-deliver');
    assert.equal(await env.owner.artifact(next.sessionId).text(), '2');
    env.owner.dispose();
  });
});

test('late native tile rejection releases a waiting replacement without stale output', async () => {
  const env = await setup({ hold: 'bitmap', decodeFailure: true });
  const first = env.start(); await flush(); env.owner.cancel(first.sessionId); await flush();
  const next = env.start(); await flush();
  assert.equal(env.stats.allocations, 1);
  env.pending.resolve(); await flush();
  assert.equal(env.owner.snapshot().phase, 'ready-to-deliver');
  assert.equal(await env.owner.artifact(next.sessionId).text(), '2');
  assert.throws(() => env.owner.artifact(first.sessionId), { code: 'artifact-unavailable' });
  env.owner.dispose();
});

test('authenticated activity loss while waiting for native storage stops the replacement', async () => {
  const env = await setup({ hold: 'bitmap' });
  const first = env.start(); await flush(); env.owner.cancel(first.sessionId); await flush();
  const next = env.start(); await flush();
  assert.equal(env.stats.requests.filter((request) => request.type === 'BROKER_HELLO').length, 2,
    'replacement registers browser activity before waiting on native storage');
  env.notify(); await flush();
  assert.equal(env.owner.snapshot().errorCode, 'target-changed');
  assert.equal(env.stats.allocations, 1);
  env.pending.resolve(); await flush();
  assert.equal(env.stats.allocations, 1);
  assert.equal(env.stats.decodes, env.stats.closes);
  assert.throws(() => env.owner.artifact(next.sessionId), { code: 'artifact-unavailable' });
  env.owner.dispose();
});

test('native encoding failure clears the gate for a new capture', async (t) => {
  for (const encodingFailure of ['null', 'throw']) await t.test(encodingFailure, async () => {
    const env = await setup({ encodingFailure });
    env.start(); await flush();
    assert.equal(env.owner.snapshot().phase, 'failed');
    const next = env.start(); await flush();
    assert.equal(env.owner.snapshot().phase, 'ready-to-deliver');
    assert.equal(await env.owner.artifact(next.sessionId).text(), '2');
    env.owner.dispose();
  });
});

test('user input and pagehide stop suspended work without suppressing events', async (t) => {
  for (const type of ['wheel', 'touchstart', 'keydown', 'pagehide']) await t.test(type, async () => {
    const { owner, start, stats, pending, fire } = await setup({ hold: 'screenshot' }); start(); await flush();
    fire(type, { key: 'PageDown', preventDefault() { assert.fail('input suppressed'); } }); await flush();
    const scrolls = stats.scrolls.length; pending.resolve(); fire('pageshow'); await flush();
    assert.equal(owner.snapshot().errorCode, type === 'pagehide' ? 'page-restored' : 'user-interrupted');
    assert.equal(stats.scrolls.length, scrolls); assert.equal(stats.restores, 1); assert.deepEqual(stats.encodes, []);
  });
});

test('cleanup failure blocks reuse and encoding follows restoration', async () => {
  const { owner, start, stats } = await setup({ cleanupFailed: true }); start(); await flush();
  assert.equal(owner.snapshot().errorCode, 'cleanup-failed'); assert.deepEqual(stats.encodes, []);
  assert.throws(start, { code: 'reload-required' });
});

test('fractional actual scrolling is drawn and exact coverage decides completeness', async () => {
  const { owner, start, stats } = await setup({ fractional: true }); start(); await flush();
  assert.equal(owner.snapshot().phase, 'ready-to-deliver');
  assert.equal(owner.snapshot().attempt, 1);
  assert.ok(stats.draws.length > 0); owner.dispose();
});

test('scroll movement during screenshot rejects mixed coordinates', async () => {
  const { owner, start, stats } = await setup({ screenshotScroll: true }); start(); await flush();
  assert.equal(owner.snapshot().errorCode, 'unstable-page');
  assert.equal(stats.draws.length, 0); assert.equal(stats.restores, 1);
});

test('cancellation after fetch never starts image decoding', async () => {
  const { owner, start, stats, pending } = await setup({ hold: 'fetch' });
  const { sessionId } = start(); await flush(); owner.cancel(sessionId); await flush();
  pending.resolve(); await flush();
  assert.equal(stats.decodes || 0, 0); assert.equal(stats.restores, 1);
});

test('finite root growth is traversed before metrics freeze', async () => {
  const { owner, start, stats } = await setup({ lazyGrowth: true }); start(); await flush();
  assert.equal(owner.snapshot().phase, 'ready-to-deliver');
  assert.equal(owner.snapshot().attempt, 1);
  assert.ok(stats.scrolls.some(([, y]) => y === 200)); owner.dispose();
});

test('incomplete coverage and resource failures do not retry', async (t) => {
  for (const options of [{ stuck: true }, { resourceError: true }]) await t.test(JSON.stringify(options), async () => {
    const { owner, start, stats } = await setup(options); start(); await flush();
    assert.equal(owner.snapshot().errorCode, options.stuck ? 'incomplete-coverage' : 'resource-failed');
    assert.equal(owner.snapshot().attempt, 1); assert.equal(stats.restores, 1);
  });
});

test('total deadline survives retry and stalled screenshot timeout', async () => {
  const { owner, start, stats, clock, pending } = await setup({ unstable: 'first', hold: 'retry-screenshot' });
  start(); await flush(); assert.equal(owner.snapshot().attempt, 2);
  await clock.advance(10000); assert.equal(owner.snapshot().errorCode, 'external-timeout');
  assert.equal(stats.restores, 1); pending.resolve(); await flush(); assert.equal(owner.snapshot().phase, 'failed');
});

test('encoded PNG cap rejects after restored state', async () => {
  const { owner, start, stats } = await setup({ oversizedPng: true, width: 1621, height: 4200, viewportWidth: 1621, viewportHeight: 1378, pixelRatio: 1.5 });
  const { sessionId } = start(); await flush();
  assert.equal(owner.snapshot().errorCode, 'page-too-large'); assert.equal(stats.restores, 1);
  assert.deepEqual(stats.encodedSizes, [[2432, 6300]]);
  assert.ok(stats.canvases.every((canvas) => canvas.width === 0 && canvas.height === 0));
  assert.throws(() => owner.artifact(sessionId), { code: 'artifact-unavailable' });
});


test('retry consumes the original 120 second active work budget', async () => {
  const { owner, start, stats } = await setup({ unstable: 'first', workPerSettle: 1000 }); start(); await flush();
  assert.equal(owner.snapshot().attempt, 2);
  assert.equal(owner.snapshot().errorCode, 'work-timeout');
  assert.equal(stats.restores, 1); assert.equal(stats.allocations, 1);
  assert.ok(stats.deadlines.every((deadline) => deadline === 120000));
});


test('local settling preserves resource and layout timeout classifications', async (t) => {
  for (const code of ['resource-timeout', 'layout-unstable']) await t.test(code, async () => {
    const { owner, start, stats, clock } = await setup({ settlingTimeout: code }); start(); await flush();
    await clock.advance(10000);
    if (code === 'layout-unstable') { assert.equal(owner.snapshot().attempt, 2); await clock.advance(10000); }
    assert.equal(owner.snapshot().errorCode, code === 'layout-unstable' ? 'unstable-page' : code);
    assert.equal(stats.restores, 1);
  });
});
