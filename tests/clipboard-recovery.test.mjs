import assert from 'node:assert/strict';
import test from 'node:test';
import { loadContext, fakeClock, deferred, flush } from './helpers/runtime.mjs';

// Keep the real owner, clipboard helper, popup renderer and gesture handler.
// Only the DOM and extension transport/native clipboard are boundary doubles.
async function setup(workMs = 0) {
  const clock = fakeClock();
  const writes = [];
  const results = [];
  const elements = new Map();
  const events = new Map();
  let owner;
  let captures = 0;
  let transferSequence = 0;
  const transfers = new Map();
  const firstWork = deferred();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { disabled: false, hidden: false, textContent: '',
      setAttribute() {}, removeAttribute() {}, focus() {},
      addEventListener(type, callback) { this[type] = callback; } });
    return elements.get(id);
  };
  const client = {
    snapshot: () => owner.snapshot(),
    subscribe: (fn) => owner.subscribe((state) => fn(state, true)),
    start: async (destination) => owner.start({ destination }),
    artifact: async () => {
      const sessionId = owner.snapshot().sessionId;
      const transferId = `transfer-${++transferSequence}`;
      owner.beginTransfer(sessionId, transferId); transfers.set(transferId, sessionId);
      return { transferId, blob: owner.artifact(sessionId) };
    },
    commit: async (transferId) => {
      assert.equal(owner.commitDelivery(transfers.get(transferId), transferId), true);
      return owner.snapshot();
    },
    result: async (transferId, outcome) => {
      results.push({ transferId, outcome });
      return owner.finishDelivery(transfers.get(transferId), transferId, outcome);
    },
  };
  const context = await loadContext(['capture-session.js', 'clipboard.js', 'popup.js'], {
    Date: { now: clock.now }, setTimeout: clock.schedule, clearTimeout: (cancel) => cancel?.(),
    document: { addEventListener: (name, fn) => events.set(name, fn),
      getElementById: element, querySelector: element },
    window: { addEventListener() {} }, location: { protocol: 'chrome-extension:' },
    navigator: { clipboard: { write(items) {
      const native = deferred(); writes.push({ native, blob: items[0].data['image/png'] });
      return native.promise;
    } } },
    ClipboardItem: class { constructor(data) { this.data = data; } },
    chrome: { tabs: { query: async () => [{ id: 1, url: 'https://example.test' }] },
      scripting: { executeScript: async () => [{ result: false }] } },
  });
  owner = context.Longform.sessions.install({ run: async () => {
    captures++;
    if (captures === 1) await firstWork.promise;
    return new Blob(['png'], { type: 'image/png' });
  }, now: clock.now, schedule: clock.schedule });
  context.Longform.popup = { ...context.Longform.popup, connectSession: async () => client };
  context.Longform.delivery = { save() {}, dispose() {} };
  await events.get('DOMContentLoaded')();
  return { clock, owner, elements, writes, results, captures: () => captures,
    copy: () => element('copyBtn').click(),
    async finishCapture() { await flush(); await clock.advance(workMs); firstWork.resolve(); await flush(); } };
}

for (const workMs of [0, 115000]) {
  test(`clipboard acknowledgement recovers UI at ${workMs ? 'remaining work deadline' : '10 second external bound'} and fences late completion`, async () => {
    const env = await setup(workMs);
    env.copy();
    assert.equal(env.writes.length, 1, 'native clipboard write starts synchronously in the click');
    await env.finishCapture();
    assert.equal(env.owner.snapshot().phase, 'delivering');
    await env.writes[0].blob;
    const wait = workMs ? 5000 : 10000;
    await env.clock.advance(wait - 1);
    assert.equal(env.elements.get('copyBtn').disabled, true);
    await env.clock.advance(1);
    assert.equal(env.owner.snapshot().phase, 'failed');
    assert.equal(env.owner.snapshot().deliveryOutcome, 'unknown');
    assert.equal(env.elements.get('copyBtn').disabled, false);
    assert.equal(env.elements.get('screenshotBtn').disabled, false);
    assert.equal(env.elements.get('cancelBtn').hidden, true);
    assert.match(env.elements.get('status').textContent, /may have completed/);
    const resultCount = env.results.length;
    if (workMs) {
      const terminal = env.owner.snapshot();
      env.writes[0].native.resolve(); await flush();
      assert.equal(env.owner.snapshot(), terminal);
      assert.equal(env.results.length, resultCount);
      env.owner.dispose(); return;
    }
    env.copy(); await flush();
    assert.equal(env.writes.length, 2, 'only the explicit second click initiates another write');
    await env.writes[1].blob;
    const retry = env.owner.snapshot();
    assert.equal(retry.phase, 'delivering');
    env.writes[0].native.resolve(); await flush();
    assert.equal(env.owner.snapshot(), retry, 'old native settlement cannot complete the retry');
    assert.equal(env.results.length, resultCount, 'late native completion emits no second result');
    env.writes[1].native.resolve(); await flush();
    assert.equal(env.owner.snapshot().phase, 'completed');
    assert.equal(env.elements.get('status').textContent, 'Copied.');
    assert.equal(env.results.filter((result) => result.outcome === 'success').length, 1);
    assert.equal(env.captures(), 1, 'retained recovery does not recapture');
    env.owner.dispose();
  });
}
