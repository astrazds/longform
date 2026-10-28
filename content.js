(() => {
  if (Longform.content) return;
  if (window.top !== window) return;
  const { protocolVersion, runtimeVersion, sessionPort } = Longform.protocol;
  const owner = Longform.sessions.install({ run: Longform.capture.run });
  const coded = (code) => Object.assign(new Error(code), { code });
  let serial = 0;
  const nextId = () => `content-${Date.now().toString(36)}-${++serial}`;

  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (/^captureFullPage(?::|$)/.test(message?.type || '')) {
      reply({ success: false, errorCode: 'reload-required' });
    }
    return false;
  });
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== sessionPort || port.sender?.id !== chrome.runtime.id
        || (port.sender.frameId !== undefined && port.sender.frameId !== 0)) return;
    let connected = true;
    let handshaken = false;
    let transfer;
    const requests = new Set();
    const post = (request, extra = {}) => {
      if (!connected) return;
      const snapshot = owner.snapshot();
      try {
        port.postMessage({ type: 'SNAPSHOT', protocolVersion, runtimeVersion,
          documentId: snapshot.documentId, sessionId: snapshot.sessionId,
          requestId: nextId(), replyTo: request?.requestId, snapshot, ...extra });
      } catch { disconnect(); try { port.disconnect(); } catch {} }
    };
    const abortTransfer = (code = 'transfer-failed') => {
      transfer?.controller.abort(coded(code));
    };
    const unsubscribe = owner.subscribe((snapshot) => {
      if (transfer && (snapshot.sessionId !== transfer.sessionId
          || ['cancelled', 'cancelling', 'expired', 'failed'].includes(snapshot.phase))) {
        abortTransfer(snapshot.errorCode || (snapshot.phase === 'expired' ? 'artifact-expired' : 'cancelled'));
      }
      if (handshaken) post();
    });
    function transferContext(record) {
      const checkpoint = () => {
        if (record.controller.signal.aborted) throw record.controller.signal.reason;
        const state = owner.snapshot();
        if (!connected || transfer !== record || state.documentId !== record.documentId
            || state.sessionId !== record.sessionId || state.phase !== 'transferring') throw coded('stale-transfer');
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
              if (error) reject(error); else {
                try { checkpoint(); resolve(value); } catch (failure) { reject(failure); }
              }
            };
            const abort = () => finish(signal.reason);
            const timer = setTimeout(() => finish(coded(code)), Math.min(10000, Math.max(0, record.expiresAt - Date.now())));
            signal.addEventListener('abort', abort, { once: true });
            Promise.resolve().then(() => { checkpoint(); return operation(); }).then((value) => finish(null, value), (error) => finish(error));
          });
        } });
    }
    const disconnect = () => {
      if (!connected) return;
      connected = false;
      owner.disconnectTransfer(transfer?.transferId);
      abortTransfer(); unsubscribe();
      port.onMessage.removeListener(message); port.onDisconnect.removeListener(disconnect);
    };
    const fail = () => { disconnect(); try { port.disconnect(); } catch {} };
    const message = async (request) => {
      // Wire messages belong to the transfer module, not the control validator.
      if (['CHUNK_ACK', 'ARTIFACT_CHUNK', 'ARTIFACT_END'].includes(request?.type)
          || (request?.type === 'ARTIFACT_BEGIN' && !request.control)) return;
      const state = owner.snapshot();
      if (!Longform.protocol.validateEnvelope(request, { documentId: state.documentId, sessionId: state.sessionId })
          || requests.has(request.requestId) || requests.size >= 16384
          || (!handshaken && request.type !== 'SNAPSHOT')) { fail(); return; }
      requests.add(request.requestId);
      try {
        if (request.type === 'SNAPSHOT') { handshaken = true; post(request); }
        else if (request.type === 'START') { owner.start({ destination: request.destination }); post(request); }
        else if (request.type === 'CANCEL') { owner.cancel(request.sessionId); post(request); }
        else if (request.type === 'ARTIFACT_BEGIN') {
          if (transfer) throw coded('transfer-failed');
          const started = owner.beginTransfer(request.sessionId, request.transferId);
          if (started.phase !== 'transferring') throw coded(started.errorCode || 'artifact-unavailable');
          const record = { ...started, transferId: request.transferId, controller: new AbortController() };
          transfer = record;
          // Store the exact promise before a final ACK can race COMMIT.
          record.sendPromise = Longform.transfer.send(owner.artifact(request.sessionId), {
            port, ctx: transferContext(record), transferId: request.transferId,
          });
          record.sendPromise.catch(() => fail());
          post(request);
        } else if (request.type === 'COMMIT_DELIVERY') {
          const record = transfer;
          if (!record || record.transferId !== request.transferId || record.sessionId !== request.sessionId) throw coded('stale-transfer');
          await transferContext(record).external(() => record.sendPromise);
          if (!connected || transfer !== record) throw coded('stale-transfer');
          const committed = owner.commitDelivery(request.sessionId, request.transferId);
          post(request, { committed });
        } else if (request.type === 'DELIVERY_RESULT') {
          owner.finishDelivery(request.sessionId, request.transferId, request.outcome); post(request);
          transfer = null;
        } else throw coded('invalid-request');
      } catch (error) { post(request, { errorCode: typeof error.code === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(error.code) ? error.code : 'capture-failed' }); }
    };
    port.onMessage.addListener(message); port.onDisconnect.addListener(disconnect);
  });
  window.addEventListener('pagehide', () => owner.dispose(), { once: true });
  Longform.content = Object.freeze({ runtimeVersion });
})();
