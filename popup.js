(() => {
  const { protocolVersion, runtimeVersion, sessionPort } = Longform.protocol;
  const coded = (code) => Object.assign(new Error(code), { code });
  const busyPhases = new Set(['preparing', 'capturing', 'validating', 'restoring', 'encoding', 'transferring', 'delivering', 'cancelling']);
  const phases = new Set(['idle', ...busyPhases, 'ready-to-deliver', 'completed', 'cancelled', 'failed', 'expired']);
  const snapshotKeys = new Set(['protocolVersion', 'documentId', 'sessionId', 'sequence', 'attempt', 'phase',
    'destination', 'section', 'sections', 'errorCode', 'canCancel', 'expiresAt', 'deliveryOutcome']);
  const token = (value) => typeof value === 'string' && value.length > 0 && value.length <= 200;
  const { phrases } = Longform.clipboard;
  function view(snapshot, copyAvailable, connected, now = Date.now()) {
    const phase = snapshot?.phase || 'idle';
    const busy = busyPhases.has(phase);
    let text = '';
    let tone = '';
    if (!connected) { text = phrases[snapshot?.errorCode || 'blocked']?.text || phrases.blocked.text; tone = 'error'; }
    else if (phase === 'capturing') text = `Capturing section ${snapshot.section} of ${snapshot.sections}…`;
    else if (phase === 'preparing') text = snapshot.attempt > 1 ? 'Page changed. Retrying…' : 'Preparing page…';
    else if (phase === 'validating') text = 'Validating capture…';
    else if (phase === 'restoring') text = 'Restoring page…';
    else if (phase === 'encoding') text = 'Encoding PNG…';
    else if (phase === 'transferring') text = 'Transferring PNG…';
    else if (phase === 'delivering') text = 'Delivering PNG…';
    else if (phase === 'cancelling') text = 'Cancelling…';
    else if (phase === 'cancelled') text = 'Cancelled.';
    else if (phase === 'ready-to-deliver') text = 'Capture ready. Choose Save or Copy.';
    else if (phase === 'expired') text = 'Capture expired. Choose Save or Copy to capture again.';
    else if (phase === 'completed') { text = phrases[snapshot.destination === 'download' ? 'saved' : 'copied'].text; tone = 'success'; }
    else if (phase === 'failed') {
      const code = snapshot.errorCode;
      text = snapshot.deliveryOutcome === 'unknown' ? phrases['delivery-unknown'].text
        : phrases[code]?.text || phrases[snapshot.destination === 'clipboard' ? 'copy-failed' : 'save-failed'].text;
      if (snapshot.expiresAt !== null && snapshot.expiresAt <= now) {
        text = `${snapshot.deliveryOutcome === 'unknown' ? 'Delivery may have completed. ' : ''}${phrases['artifact-expired'].text}`;
      }
      tone = 'error';
    } else if (!copyAvailable) text = phrases.readyCopyUnavailable.text;
    return Object.freeze({ text, tone, busy, blocked: !connected || snapshot?.errorCode === 'cleanup-failed',
      cancel: Boolean(connected && (snapshot?.canCancel || phase === 'cancelling')),
      canCancel: Boolean(connected && snapshot?.canCancel),
      determinate: phase === 'capturing' && snapshot.sections > 0,
      value: phase === 'completed' ? 1 : Math.min(0.95, (snapshot?.section || 0) / Math.max(1, snapshot?.sections || 0)) });
  }

  /** A subscription is independent of capture lifetime. No image bytes enter snapshots. */
  async function connectSession(tabId) {
    const port = chrome.tabs.connect(tabId, { name: sessionPort, frameId: 0 });
    let connected = true;
    let latest;
    let transfer;
    let commitSent = false;
    const pending = new Map();
    const listeners = new Set();
    const validator = Longform.protocol.createEnvelopeValidator();
    const id = () => crypto.randomUUID();
    const emit = () => { for (const listener of [...listeners]) listener(latest, connected); };
    const disconnect = () => {
      if (!connected) return;
      connected = false;
      const error = coded(commitSent ? 'delivery-unknown' : 'transfer-failed');
      transfer?.controller.abort(error);
      for (const wait of pending.values()) { clearTimeout(wait.timer); wait.reject(error); }
      pending.clear(); emit();
      port.onMessage.removeListener(message); port.onDisconnect.removeListener(disconnect);
    };
    const message = (reply) => {
      if (reply?.type !== 'SNAPSHOT') return;
      const s = reply.snapshot;
      if (!validator.accept(reply) || reply.runtimeVersion !== runtimeVersion
          || !s || s.protocolVersion !== protocolVersion || !phases.has(s.phase)
          || !token(s.documentId) || s.documentId !== reply.documentId
          || s.sessionId !== reply.sessionId || !Number.isSafeInteger(s.sequence) || s.sequence < 0
          || (s.sessionId !== null && !token(s.sessionId))
          || !Number.isInteger(s.attempt) || s.attempt < 0 || s.attempt > 2
          || ![null, 'download', 'clipboard'].includes(s.destination)
          || !Number.isSafeInteger(s.section) || s.section < 0
          || !Number.isSafeInteger(s.sections) || s.sections < 0 || s.section > s.sections
          || (s.expiresAt !== null && (!Number.isSafeInteger(s.expiresAt) || s.expiresAt < 0))
          || (s.errorCode !== null && (typeof s.errorCode !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(s.errorCode)))
          || ![null, 'known', 'unknown'].includes(s.deliveryOutcome)
          || Object.keys(s).some((key) => !snapshotKeys.has(key))
          || typeof s.canCancel !== 'boolean' || (latest && (s.documentId !== latest.documentId || s.sequence < latest.sequence))) {
        disconnect(); try { port.disconnect(); } catch {} return;
      }
      const changed = !latest || s.sequence > latest.sequence;
      latest = Object.freeze({ ...s });
      if (transfer) {
        if (s.phase === 'transferring') transfer.started = true;
        if (s.sessionId !== transfer.sessionId || ['cancelled', 'cancelling', 'expired', 'failed'].includes(s.phase)) {
          transfer.controller.abort(coded(s.errorCode || (s.phase === 'expired' ? 'artifact-expired' : 'cancelled')));
        }
      }
      if (changed) emit();
      const wait = pending.get(reply.replyTo);
      if (wait) { pending.delete(reply.replyTo); clearTimeout(wait.timer);
        if (reply.errorCode) wait.reject(coded(reply.errorCode)); else wait.resolve(reply); }
    };
    port.onMessage.addListener(message); port.onDisconnect.addListener(disconnect);
    function request(type, extra = {}) {
      if (!connected) return Promise.reject(coded(commitSent ? 'delivery-unknown' : 'transfer-failed'));
      const requestId = id();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId); reject(coded(commitSent ? 'delivery-unknown' : 'external-timeout'));
          disconnect(); try { port.disconnect(); } catch {}
        }, 10000);
        pending.set(requestId, { resolve, reject, timer });
        try { port.postMessage({ type, protocolVersion, requestId, documentId: latest?.documentId,
          sessionId: latest?.sessionId ?? null, ...extra }); }
        catch { disconnect(); }
      });
    }
    function transferContext(record) {
      const checkpoint = () => {
        if (record.controller.signal.aborted) throw record.controller.signal.reason;
        if (!connected || transfer !== record || latest.documentId !== record.documentId
            || latest.sessionId !== record.sessionId || (latest.phase !== 'transferring'
              && !(latest.phase === 'ready-to-deliver' && !record.started))) throw coded('stale-transfer');
        if (Date.now() >= record.expiresAt) throw coded('artifact-expired');
      };
      return Object.freeze({ documentId: record.documentId, sessionId: record.sessionId,
        signal: record.controller.signal, checkpoint,
        external(operation, code = 'external-timeout') {
          checkpoint();
          return new Promise((resolve, reject) => {
            let settled = false;
            const signal = record.controller.signal;
            const finish = (error, value) => {
              if (settled) return; settled = true;
              clearTimeout(timer); signal.removeEventListener('abort', abort);
              if (error) reject(error); else { try { checkpoint(); resolve(value); } catch (failure) { reject(failure); } }
            };
            const abort = () => finish(signal.reason);
            const timer = setTimeout(() => finish(coded(Date.now() >= record.expiresAt ? 'artifact-expired' : code)),
              Math.min(10000, Math.max(0, record.expiresAt - Date.now())));
            signal.addEventListener('abort', abort, { once: true });
            Promise.resolve().then(() => { checkpoint(); return operation(); }).then((value) => finish(null, value), (error) => finish(error));
          });
        } });
    }
    const client = Object.freeze({
      snapshot: () => latest,
      subscribe(listener) { listeners.add(listener); listener(latest, connected); return () => listeners.delete(listener); },
      async start(destination) { return (await request('START', { destination })).snapshot; },
      async cancel() { return (await request('CANCEL')).snapshot; },
      async artifact() {
        if (transfer || latest?.phase !== 'ready-to-deliver') throw coded('artifact-unavailable');
        const record = { ...latest, transferId: id(), controller: new AbortController(), started: false };
        transfer = record;
        const ctx = transferContext(record);
        // Listen before requesting production; initial ready state is permitted
        // only until the owner's first transferring snapshot arrives.
        const received = Longform.transfer.receive({ port, ctx, transferId: record.transferId });
        received.catch(() => {});
        try {
          await request('ARTIFACT_BEGIN', { control: true, transferId: record.transferId, chunkIndex: 0 });
          const blob = await received;
          ctx.checkpoint();
          return { blob, transferId: record.transferId };
        } catch (error) { disconnect(); try { port.disconnect(); } catch {} throw error; }
      },
      async commit(transferId) {
        if (!transfer || transfer.transferId !== transferId) throw coded('stale-transfer');
        commitSent = true;
        const response = await request('COMMIT_DELIVERY', { transferId });
        if (!response.committed) { commitSent = false; throw coded(response.snapshot.errorCode || 'cancelled'); }
        return response.snapshot;
      },
      async result(transferId, outcome) {
        const response = await request('DELIVERY_RESULT', { transferId, outcome });
        commitSent = false; transfer = null;
        return response.snapshot;
      },
      disconnect() { disconnect(); try { port.disconnect(); } catch {} },
    });
    await request('SNAPSHOT');
    return client;
  }
  Longform.popup = Object.freeze({ connectSession, view });
})();

document.addEventListener('DOMContentLoaded', async () => {
  const save = document.getElementById('screenshotBtn');
  if (!save) return; // The smoke extension page uses the same session client.
  const copy = document.getElementById('copyBtn');
  const cancel = document.getElementById('cancelBtn');
  const progress = document.getElementById('progress');
  const status = document.getElementById('status');
  const { phrases, canCopyArtifact, copyBlobDuringGesture } = Longform.clipboard;
  let client;
  let snapshot;
  let connected = false;
  let activeGesture = false;
  let announcementAt = -Infinity;
  let announcementTimer;
  let expiryTimer;
  let returnFocus = false;
  document.querySelector('h1').textContent = phrases.labels.heading;
  save.textContent = phrases.labels.save; copy.textContent = phrases.labels.copy; cancel.textContent = 'Cancel';
  save.setAttribute('aria-label', phrases.labels.saveAria); copy.setAttribute('aria-label', phrases.labels.copyAria);
  function render() {
    const model = Longform.popup.view(snapshot, canCopyArtifact(), connected);
    const cancelFocused = document.activeElement === cancel;
    if (cancelFocused && !model.cancel) returnFocus = true;
    save.disabled = model.busy || model.blocked || activeGesture;
    copy.disabled = save.disabled || !canCopyArtifact();
    cancel.hidden = !model.cancel; cancel.disabled = !model.canCancel;
    progress.hidden = !model.busy;
    if (model.determinate) progress.value = model.value; else progress.removeAttribute('value');
    progress.setAttribute('aria-label', model.text);
    status.className = `status${model.tone ? ` ${model.tone}` : ''}`;
    clearTimeout(announcementTimer);
    const announce = () => { status.textContent = model.text; announcementAt = Date.now(); };
    const delay = snapshot?.phase === 'capturing' ? Math.max(0, 1000 - (Date.now() - announcementAt)) : 0;
    if (delay) announcementTimer = setTimeout(announce, delay); else if (status.textContent !== model.text) announce();
    if (returnFocus && !save.disabled) { save.focus(); returnFocus = false; }
    clearTimeout(expiryTimer);
    if (snapshot?.expiresAt > Date.now()) expiryTimer = setTimeout(render, snapshot.expiresAt - Date.now());
  }
  function failure(error) {
    if (['cancelled', 'expired'].includes(client?.snapshot()?.phase)) {
      snapshot = client.snapshot(); render(); return;
    }
    snapshot = { ...(snapshot || {}), phase: 'failed', canCancel: false,
      errorCode: error.code || 'capture-failed', deliveryOutcome: error.code === 'delivery-unknown' ? 'unknown' : null };
    render();
  }
  async function attach() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https?:/i.test(tab.url || '')) throw Object.assign(new Error('blocked'), { code: 'blocked' });
    try {
      const [probe] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
        const runtime = globalThis.Longform;
        return Boolean(globalThis.window?.__longformContentScriptVersion
          || (runtime && runtime.protocol?.runtimeVersion !== '2026-10-28-managed-v1'));
      } });
      if (probe.result) throw Object.assign(new Error('reload-required'), { code: 'reload-required' });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: Longform.protocol.contentFiles });
    } catch (error) {
      throw Object.assign(new Error('injection failed'), { code: error.code === 'reload-required' ? error.code : 'blocked' });
    }
    client = await Longform.popup.connectSession(tab.id);
    client.subscribe((state, alive) => { snapshot = state; connected = alive; render(); });
  }
  function waitReady() {
    return new Promise((resolve, reject) => {
      let unsubscribe;
      const check = (state, alive) => {
        if (!alive || ['failed', 'cancelled', 'expired'].includes(state.phase)) {
          unsubscribe?.(); reject(Object.assign(new Error('Capture failed'), { code: state.errorCode || (state.phase === 'cancelled' ? 'cancelled' : 'transfer-failed') }));
        } else if (state.phase === 'ready-to-deliver') { unsubscribe?.(); resolve(); }
      };
      unsubscribe = client.subscribe(check);
      if (['ready-to-deliver', 'failed', 'cancelled', 'expired'].includes(client.snapshot().phase)) unsubscribe();
    });
  }
  async function committedArtifact(destination) {
    if (!connected) await attach();
    await client.start(destination);
    await waitReady();
    const artifact = await client.artifact();
    await client.commit(artifact.transferId);
    return artifact;
  }
  function deliver(destination) {
    if (activeGesture) return;
    activeGesture = true; render();
    let transferId;
    const produce = async () => { const artifact = await committedArtifact(destination); transferId = artifact.transferId; return artifact.blob; };
    // This call must occur synchronously in Copy's originating gesture.
    const operation = destination === 'clipboard' ? copyBlobDuringGesture(produce) : produce().then((blob) => {
      Longform.delivery.save(blob, `longform-capture-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
      return { deliveryOutcome: 'success' };
    });
    operation.then(async (outcome) => {
      if (transferId) await client.result(transferId, outcome.deliveryOutcome);
      if (outcome.deliveryOutcome !== 'success') failure({ code: outcome.deliveryOutcome === 'unknown' ? 'delivery-unknown' : outcome.phrase || 'delivery-failed' });
    }).catch(async (error) => {
      if (transferId) { try { await client.result(transferId, 'failed'); } catch (failure) { error = failure; } }
      failure(error);
    }).finally(() => { activeGesture = false; render(); });
  }
  save.addEventListener('click', () => deliver('download'));
  copy.addEventListener('click', () => deliver('clipboard'));
  cancel.addEventListener('click', () => { client?.cancel().catch(failure); });
  window.addEventListener('pagehide', () => { clearTimeout(announcementTimer); clearTimeout(expiryTimer); client?.disconnect(); Longform.delivery.dispose(); });
  try { await attach(); } catch (error) { connected = false; failure(error); }
});
