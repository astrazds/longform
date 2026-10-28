import assert from 'node:assert/strict';
import test from 'node:test';
import { loadContext, inject, loadRuntime, deferred, flush, fakeClock } from './helpers/runtime.mjs';

const png = () => new Blob(['png'], { type: 'image/png' });
async function setup(run) {
  const clock = fakeClock();
  const context = await loadContext(['capture-session.js']);
  assert.equal(typeof context.Longform.sessions?.install, 'function', 'session install API must exist');
  const owner = context.Longform.sessions.install({ run, now: clock.now, schedule: clock.schedule });
  return { owner, clock, context };
}

test('duplicate start and reinjection share one run', async () => {
  const work = deferred();
  let runCalls = 0;
  const { owner, context } = await setup(() => { runCalls++; return work.promise; });
  const first = owner.start({ destination: 'download' });
  const second = owner.start({ destination: 'clipboard' });
  assert.equal(second.sessionId, first.sessionId);
  await inject(context, 'capture-session.js');
  assert.equal(context.Longform.sessions.install({ run: () => assert.fail('replaced dependency') }), owner);
  assert.equal(runCalls, 1);
  work.resolve(png());
  await flush();
  assert.equal(owner.snapshot().phase, 'ready-to-deliver');
  owner.dispose();
});

test('cancel waits for cleanup', async () => {
  const cleanup = deferred();
  let ctx;
  const { owner } = await setup((value) => { ctx = value; return cleanup.promise; });
  const { sessionId: id } = owner.start({ destination: 'download' });
  assert.equal(owner.cancel(id).phase, 'cancelling');
  assert.equal(ctx.signal.aborted, true);
  assert.throws(() => ctx.checkpoint(), { code: 'cancelled' });
  assert.equal(owner.start({ destination: 'download' }).sessionId, id);
  assert.equal(owner.commitDelivery(id, 'transfer'), false);
  cleanup.resolve(png());
  await flush();
  assert.equal(owner.snapshot().phase, 'cancelled');
  assert.throws(() => owner.artifact(id), { code: 'artifact-unavailable' });
});

test('retention expires without renewal', async () => {
  const { owner, clock } = await setup(async () => png());
  const { sessionId: id } = owner.start({ destination: 'download' });
  await flush();
  assert.equal(owner.snapshot().expiresAt, 120000);
  await clock.advance(60000);
  owner.beginTransfer(id, 'a');
  owner.disconnectTransfer('a');
  assert.equal(owner.snapshot().expiresAt, 120000);
  await clock.advance(59999);
  owner.beginTransfer(id, 'b');
  assert.ok(owner.artifact(id) instanceof Blob);
  await clock.advance(1);
  assert.equal(owner.snapshot().phase, 'expired');
  assert.equal(owner.commitDelivery(id, 'b'), false);
  assert.throws(() => owner.artifact(id), { code: 'artifact-unavailable' });
});

test('delivery arbitration is irreversible', async () => {
  const { owner } = await setup(async () => png());
  const { sessionId: id } = owner.start({ destination: 'download' });
  await flush();
  owner.beginTransfer(id, 'a');
  assert.equal(owner.commitDelivery(id, 'a'), true);
  assert.equal(owner.commitDelivery(id, 'a'), false);
  assert.equal(owner.cancel(id).phase, 'delivering');
  owner.disconnectTransfer('a');
  assert.equal(owner.snapshot().deliveryOutcome, 'unknown');
  assert.ok(owner.artifact(id) instanceof Blob);
  assert.equal(owner.beginTransfer(id, 'b').phase, 'failed');
  assert.equal(owner.commitDelivery(id, 'b'), false);
  owner.dispose();
});

test('disconnect before commit returns ready and stale transfer messages cannot deliver', async () => {
  const { owner } = await setup(async () => png());
  const { sessionId: id } = owner.start({ destination: 'clipboard' });
  await flush();
  owner.beginTransfer(id, 'a');
  assert.equal(owner.disconnectTransfer('wrong').phase, 'transferring');
  assert.equal(owner.disconnectTransfer('a').phase, 'ready-to-deliver');
  owner.beginTransfer(id, 'b');
  assert.equal(owner.commitDelivery('stale', 'b'), false);
  assert.equal(owner.commitDelivery(id, 'a'), false);
  assert.equal(owner.finishDelivery(id, 'b', 'success').phase, 'transferring');
  assert.equal(owner.commitDelivery(id, 'b'), true);
  assert.equal(owner.finishDelivery(id, 'a', 'success').phase, 'delivering');
  assert.equal(owner.finishDelivery(id, 'b', 'success').phase, 'completed');
  assert.throws(() => owner.artifact(id), { code: 'artifact-unavailable' });
});

test('failed delivery retains the artifact until expiry and emits one terminal event', async () => {
  const { owner, clock } = await setup(async () => png());
  const states = [];
  const unsubscribe = owner.subscribe((snapshot) => states.push(snapshot));
  const { sessionId: id } = owner.start({ destination: 'download' });
  await flush();
  owner.beginTransfer(id, 'a');
  owner.commitDelivery(id, 'a');
  owner.finishDelivery(id, 'a', 'failed');
  owner.finishDelivery(id, 'a', 'success');
  owner.disconnectTransfer('a');
  assert.equal(owner.snapshot().phase, 'failed');
  assert.equal(owner.snapshot().deliveryOutcome, 'known');
  assert.ok(owner.artifact(id) instanceof Blob);
  await clock.advance(120000);
  assert.equal(states.filter((s) => ['failed', 'completed', 'cancelled', 'expired'].includes(s.phase)).length, 1);
  assert.throws(() => owner.artifact(id), { code: 'artifact-unavailable' });
  assert.equal(new Set(states.map((s) => s.sequence)).size, states.length);
  assert.ok(states.every(Object.isFrozen));
  unsubscribe();
});

test('failed cleanup blocks start until reload and never exposes arbitrary error text', async () => {
  const { owner } = await setup(async () => { throw Object.assign(new Error('private page text'), { code: 'cleanup-failed' }); });
  owner.start({ destination: 'download' });
  await flush();
  assert.equal(owner.snapshot().errorCode, 'cleanup-failed');
  assert.equal(JSON.stringify(owner.snapshot()).includes('private'), false);
  assert.throws(() => owner.start({ destination: 'download' }), { code: 'reload-required' });
});

test('work timeout aborts at 120000ms and still waits for restoration', async () => {
  const restored = deferred();
  let ctx;
  const { owner, clock } = await setup((value) => { ctx = value; return restored.promise; });
  owner.start({ destination: 'download' });
  await clock.advance(119999);
  ctx.publish({ attempt: 2, phase: 'capturing', section: 1, sections: 2 });
  assert.equal(ctx.deadline, 120000);
  await clock.advance(1);
  assert.equal(ctx.signal.aborted, true);
  assert.equal(owner.snapshot().phase, 'cancelling');
  restored.resolve(png());
  await flush();
  assert.equal(owner.snapshot().errorCode, 'work-timeout');
  assert.equal(owner.snapshot().phase, 'failed');
});

test('external operations time out at 10000ms using the supplied safe code', async () => {
  const external = deferred();
  const cleanup = deferred();
  let rejected;
  const { owner, clock } = await setup(async (ctx) => {
    try { await ctx.external(() => external.promise, 'tile-timeout'); }
    catch (error) { rejected = error; await cleanup.promise; throw error; }
    return png();
  });
  owner.start({ destination: 'download' });
  await clock.advance(9999);
  assert.equal(rejected, undefined);
  await clock.advance(1);
  assert.equal(rejected.code, 'tile-timeout');
  cleanup.resolve();
  external.resolve('late');
  await flush();
  assert.equal(owner.snapshot().errorCode, 'tile-timeout');
});

test('ready retention pauses the original work budget and resumes it for transfer', async () => {
  const capture = deferred();
  const { owner, clock } = await setup(() => capture.promise);
  const { sessionId: id } = owner.start({ destination: 'download' });
  await clock.advance(110000);
  capture.resolve(png());
  await flush();
  await clock.advance(100000);
  assert.equal(owner.snapshot().phase, 'ready-to-deliver');
  owner.beginTransfer(id, 'a');
  await clock.advance(9999);
  assert.equal(owner.snapshot().phase, 'transferring');
  await clock.advance(1);
  assert.equal(owner.snapshot().phase, 'failed');
  assert.equal(owner.snapshot().errorCode, 'work-timeout');
});

test('dispose aborts pending work and fences late publication and restart', async () => {
  const capture = deferred();
  let ctx;
  const { owner } = await setup((value) => { ctx = value; return capture.promise; });
  owner.start({ destination: 'download' });
  owner.dispose('pagehide');
  assert.equal(ctx.signal.aborted, true);
  assert.throws(() => ctx.publish({ phase: 'capturing' }), { code: 'cancelled' });
  capture.resolve(png());
  await flush();
  assert.equal(owner.snapshot().phase, 'cancelled');
  assert.throws(() => owner.start({ destination: 'download' }), { code: 'reload-required' });
});

test('protocol validators reject stale duplicate mismatched and malformed envelopes', async () => {
  const { protocol } = await loadRuntime([]);
  assert.equal(typeof protocol.createEnvelopeValidator, 'function');
  const validator = protocol.createEnvelopeValidator({ documentId: 'doc', sessionId: 'session' });
  const message = { type: 'CANCEL', protocolVersion: 6, documentId: 'doc', sessionId: 'session', requestId: '1' };
  assert.equal(validator.accept({ ...message, protocolVersion: 5 }), false);
  assert.equal(validator.accept({ ...message, documentId: 'old' }), false);
  assert.equal(validator.accept({ ...message, sessionId: 'old' }), false);
  assert.equal(validator.accept(message), true);
  assert.equal(validator.accept(message), false);
  assert.equal(validator.accept({ ...message, requestId: '2', type: 'ARTIFACT_CHUNK' }), false);
  assert.equal(validator.accept({ ...message, requestId: '2', type: 'ARTIFACT_CHUNK', transferId: 't', chunkIndex: 0 }), true);
  assert.equal(validator.accept({ ...message, requestId: '3', sequence: 4 }), true);
  assert.equal(validator.accept({ ...message, requestId: '4', sequence: 3 }), false);
  assert.equal(protocol.validateEnvelope({ type: 'SNAPSHOT', protocolVersion: 6, requestId: 'hello' }), true);
});

test('incompatible runtime versions require reload even when idle', async () => {
  const { owner, context } = await setup(async () => png());
  context.Longform.protocol = { ...context.Longform.protocol, runtimeVersion: 'future' };
  assert.throws(() => context.Longform.sessions.install({ run: async () => png() }), { code: 'reload-required' });
  owner.dispose();
});

test('a disconnected transfer ID cannot be reused to authorize stale commit', async () => {
  const { owner } = await setup(async () => png());
  const { sessionId: id } = owner.start({ destination: 'download' });
  await flush();
  owner.beginTransfer(id, 'a');
  owner.disconnectTransfer('a');
  assert.equal(owner.beginTransfer(id, 'a').phase, 'ready-to-deliver');
  assert.equal(owner.commitDelivery(id, 'a'), false);
  owner.dispose();
});

test('committed delivery work timeout becomes unknown without undoing commit', async () => {
  const capture = deferred();
  const { owner, clock } = await setup(() => capture.promise);
  const { sessionId: id } = owner.start({ destination: 'download' });
  await clock.advance(119000);
  capture.resolve(png());
  await flush();
  owner.beginTransfer(id, 'a');
  owner.commitDelivery(id, 'a');
  await clock.advance(1000);
  assert.equal(owner.snapshot().phase, 'failed');
  assert.equal(owner.snapshot().deliveryOutcome, 'unknown');
  assert.equal(owner.commitDelivery(id, 'a'), false);
  assert.ok(owner.artifact(id) instanceof Blob);
  owner.dispose();
});

test('external cancellation releases its wait immediately and fences late completion', async () => {
  const external = deferred();
  const cleanup = deferred();
  let caught;
  const { owner } = await setup(async (ctx) => {
    try { await ctx.external(() => external.promise, 'tile-timeout'); }
    catch (error) { caught = error; await cleanup.promise; throw error; }
    assert.fail('late external completion escaped its cancellation fence');
  });
  const { sessionId: id } = owner.start({ destination: 'download' });
  owner.cancel(id);
  await flush();
  assert.equal(caught.code, 'cancelled');
  assert.equal(owner.snapshot().phase, 'cancelling');
  external.resolve('late');
  cleanup.resolve();
  await flush();
  assert.equal(owner.snapshot().phase, 'cancelled');
});

test('external operation is bounded by the smaller remaining work budget', async () => {
  const begin = deferred();
  const pending = deferred();
  let caught;
  const { owner, clock } = await setup(async (ctx) => {
    await begin.promise;
    try { await ctx.external(() => pending.promise, 'tile-timeout'); }
    catch (error) { caught = error; throw error; }
    return png();
  });
  owner.start({ destination: 'download' });
  await clock.advance(115000);
  begin.resolve();
  await flush();
  await clock.advance(5000);
  assert.equal(caught.code, 'work-timeout');
  assert.equal(owner.snapshot().phase, 'failed');
  pending.resolve('late');
});

test('retry attempt guards reject prior attempt checkpoints and external results', async () => {
  const capture = deferred();
  const late = deferred();
  let ctx;
  const { owner } = await setup((value) => { ctx = value; return capture.promise; });
  owner.start({ destination: 'download' });
  const attempt = ctx.attempt;
  const external = ctx.external(() => late.promise);
  assert.throws(() => ctx.publish({ attempt: 2, section: -1 }), { code: 'invalid-progress' });
  assert.equal(ctx.attempt, 1);
  ctx.publish({ attempt: 2, phase: 'preparing' });
  assert.throws(() => ctx.checkpoint(attempt), { code: 'stale-attempt' });
  ctx.checkpoint();
  assert.throws(() => ctx.publish({ attempt: 1 }), { code: 'invalid-attempt' });
  assert.throws(() => ctx.publish({ attempt: 3 }), { code: 'invalid-attempt' });
  late.resolve('old tile');
  await assert.rejects(external, { code: 'stale-attempt' });
  owner.dispose();
  capture.resolve(png());
  await flush();
});

test('idle handshake bootstraps START but cannot bypass an active session identity', async () => {
  const { protocol } = await loadRuntime([]);
  const start = { type: 'START', protocolVersion: 6, documentId: 'doc', sessionId: null, requestId: 'start' };
  assert.equal(protocol.validateEnvelope(start, { documentId: 'doc', sessionId: null }), true);
  assert.equal(protocol.validateEnvelope(start), false);
  assert.equal(protocol.validateEnvelope(start, { documentId: 'doc', sessionId: 'active' }), false);
  assert.equal(protocol.validateEnvelope({ ...start, documentId: 'stale' }, { documentId: 'doc', sessionId: null }), false);
  assert.equal(protocol.validateEnvelope({ ...start, type: 'CANCEL' }, { documentId: 'doc', sessionId: null }), false);
  assert.equal(protocol.validateEnvelope({ ...start, type: 'CANCEL', sessionId: 'invented' }, { documentId: 'doc', sessionId: null }), false);
  assert.equal(protocol.validateEnvelope({ type: 'SNAPSHOT', protocolVersion: 6, runtimeVersion: protocol.runtimeVersion,
    documentId: 'doc', sessionId: null, requestId: 'hello', sequence: 0 }), true);
});

test('subscription at an elapsed expiry receives one terminal snapshot', async () => {
  let time = 0;
  const { sessions } = await loadRuntime(['capture-session.js']);
  const owner = sessions.install({ run: async () => png(), now: () => time, schedule: () => () => {} });
  owner.start({ destination: 'download' });
  await flush();
  time = 120000;
  const states = [];
  owner.subscribe((state) => states.push(state));
  assert.equal(states.length, 1);
  assert.equal(states[0].phase, 'expired');
});

test('null and stale disconnect before transfer cannot pause capture work', async () => {
  const capture = deferred();
  let ctx;
  const { owner, clock } = await setup((value) => { ctx = value; return capture.promise; });
  owner.start({ destination: 'download' });
  const before = owner.snapshot();
  for (const transferId of [null, undefined, '', 'stale-transfer']) {
    assert.equal(owner.disconnectTransfer(transferId), before);
  }
  assert.equal(owner.snapshot().phase, 'preparing');
  assert.equal(ctx.signal.aborted, false);
  await clock.advance(120001);
  assert.equal(ctx.signal.aborted, true);
  assert.equal(owner.snapshot().phase, 'cancelling');
  capture.resolve(png());
  await flush();
  assert.equal(owner.snapshot().phase, 'failed');
  assert.equal(owner.snapshot().errorCode, 'work-timeout');
});
