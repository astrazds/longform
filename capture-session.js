(() => {
  globalThis.Longform ||= {};
  if (Longform.sessions) return;
  const { protocolVersion, runtimeVersion } = Longform.protocol;
  const WORK_MS = 120000;
  const RETENTION_MS = 120000;
  const EXTERNAL_MS = 10000;
  const workPhases = new Set(['preparing', 'capturing', 'validating', 'restoring', 'encoding']);
  const coded = (code) => Object.assign(new Error(code), { code });
  const safeCode = (code, fallback) => typeof code === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(code) ? code : fallback;
  const token = (value) => typeof value === 'string' && value.length > 0 && value.length <= 200;
  const identity = () => globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  let installed;

  /**
   * Snapshot: {protocolVersion, documentId, sessionId, sequence, attempt, phase,
   * destination, section, sections, errorCode, canCancel, expiresAt, deliveryOutcome}.
   * No image bytes or arbitrary exception strings are published.
   * schedule(callback, milliseconds) returns a cancellation function.
   * run(ctx) MUST settle only after restoration, even when ctx.signal aborts.
   */
  function install({ run, now = () => Date.now(), schedule = (fn, ms) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  } } = {}) {
    if (Longform.protocol.runtimeVersion !== runtimeVersion
        || Longform.protocol.protocolVersion !== protocolVersion) throw coded('reload-required');
    if (installed) return installed;
    if (typeof run !== 'function') throw coded('invalid-run');
    const documentId = identity();
    const listeners = new Set();
    let disposed = false;
    let blocked = false;
    let generation = 0;
    let current;
    let sequence = 0;
    let state = Object.freeze({ protocolVersion, documentId, sessionId: null, sequence,
      attempt: 0, phase: 'idle', destination: null, section: 0, sections: 0,
      errorCode: null, canCancel: false, expiresAt: null, deliveryOutcome: null });

    function emit(patch) {
      state = Object.freeze({ ...state, ...patch, sequence: ++sequence });
      for (const listener of [...listeners]) {
        try { listener(state); } catch { /* A disconnected UI cannot break cleanup. */ }
      }
      return state;
    }
    function remaining(session) {
      return session.remaining - (session.activeSince === null ? 0 : now() - session.activeSince);
    }
    function pause(session) {
      if (session.activeSince !== null) session.remaining = remaining(session);
      session.activeSince = null;
      session.stopWork?.();
      session.stopWork = null;
    }
    function resume(session) {
      if (session.activeSince !== null) return;
      session.activeSince = now();
      session.stopWork = schedule(() => abort(session, 'work-timeout'), Math.max(0, remaining(session)));
    }
    function terminal(session, phase, patch = {}) {
      if (current !== session || session.terminal) return state;
      session.terminal = true;
      pause(session);
      return emit({ phase, canCancel: false, ...patch });
    }
    function clearArtifact(session) {
      session.blob = null;
      session.stopRetention?.();
      session.stopRetention = null;
    }
    function expire(session) {
      if (current !== session || !session.blob || now() < session.expiresAt) return;
      clearArtifact(session);
      if (!session.committed && !session.terminal) {
        session.transferId = null;
        session.controller.abort(coded('artifact-expired'));
        terminal(session, 'expired', { errorCode: 'artifact-expired' });
      }
      // A delivery that crossed commit is irreversible; TTL only frees its bytes.
    }
    function fresh() {
      if (current) {
        expire(current);
        if (!current.terminal && current.activeSince !== null && remaining(current) <= 0) abort(current, 'work-timeout');
      }
      return state;
    }
    function abort(session, code) {
      if (current !== session || session.terminal || session.controller.signal.aborted) return;
      if (session.committed) {
        if (code === 'work-timeout') terminal(session, 'failed', {
          deliveryOutcome: 'unknown', errorCode: 'delivery-unknown',
        });
        return;
      }
      session.abortCode = code;
      session.controller.abort(coded(code));
      clearArtifact(session);
      pause(session);
      if (session.running) emit({ phase: 'cancelling', canCancel: false, errorCode: code === 'cancelled' ? null : code });
      else terminal(session, code === 'cancelled' ? 'cancelled' : 'failed', { errorCode: code === 'cancelled' ? null : code });
    }
    function checkpoint(session, expectedAttempt = session.attempt) {
      if (current !== session || session.generation !== generation) throw coded('stale-session');
      if (session.controller.signal.aborted) throw session.controller.signal.reason;
      if (expectedAttempt !== session.attempt) throw coded('stale-attempt');
      if (remaining(session) <= 0) {
        abort(session, 'work-timeout');
        throw coded('work-timeout');
      }
      if (!session.running) throw coded('stale-session');
    }
    function contextFor(session) {
      return Object.freeze({
        sessionId: session.id,
        documentId,
        get attempt() { return session.attempt; },
        signal: session.controller.signal,
        get deadline() { return now() + remaining(session); },
        // Capture ctx.attempt before async work, then pass it to fence a retry's late continuation.
        checkpoint: (expectedAttempt) => checkpoint(session, expectedAttempt),
        publish(patch) {
          // Restoration is unconditional; publishing it cannot prevent cleanup after abort.
          if (patch?.phase === 'restoring' && session.controller.signal.aborted
              && current === session && session.running) return state;
          checkpoint(session);
          if (!patch || (patch.phase !== undefined && !workPhases.has(patch.phase))) throw coded('invalid-progress');
          const progress = {};
          if (patch.attempt !== undefined) {
            if (!Number.isInteger(patch.attempt) || patch.attempt < session.attempt || patch.attempt > 2) throw coded('invalid-attempt');
            progress.attempt = patch.attempt;
          }
          if (patch.phase !== undefined) progress.phase = patch.phase;
          for (const key of ['section', 'sections']) {
            if (patch[key] !== undefined) {
              if (!Number.isSafeInteger(patch[key]) || patch[key] < 0) throw coded('invalid-progress');
              progress[key] = patch[key];
            }
          }
          if (progress.attempt !== undefined) session.attempt = progress.attempt;
          return emit(progress);
        },
        external(operation, code = 'external-timeout') {
          try { checkpoint(session); } catch (error) { return Promise.reject(error); }
          const attempt = session.attempt;
          const signal = session.controller.signal;
          return new Promise((resolve, reject) => {
            let settled = false;
            let cancelTimer;
            const finish = (error, value) => {
              if (settled) return;
              settled = true;
              cancelTimer?.();
              signal.removeEventListener('abort', cancelled);
              if (error) reject(error); else resolve(value);
            };
            const cancelled = () => finish(signal.reason);
            signal.addEventListener('abort', cancelled, { once: true });
            const budget = remaining(session);
            cancelTimer = schedule(() => {
              if (budget <= EXTERNAL_MS) {
                abort(session, 'work-timeout');
                finish(coded('work-timeout'));
              } else finish(coded(safeCode(code, 'external-timeout')));
            }, Math.min(EXTERNAL_MS, budget));
            try {
              Promise.resolve(operation()).then((value) => {
                try { checkpoint(session, attempt); finish(null, value); } catch (error) { finish(error); }
              }, (error) => finish(error));
            } catch (error) { finish(error); }
          });
        },
      });
    }
    function settle(session, error, blob) {
      session.running = false;
      if (current !== session || session.generation !== generation) return;
      if (error?.code === 'cleanup-failed') {
        blocked = true;
        clearArtifact(session);
        terminal(session, 'failed', { errorCode: 'cleanup-failed' });
      } else if (session.controller.signal.aborted) {
        terminal(session, session.abortCode === 'cancelled' ? 'cancelled' : 'failed',
          { errorCode: session.abortCode === 'cancelled' ? null : session.abortCode });
      } else if (error) {
        terminal(session, 'failed', { errorCode: safeCode(error.code, 'capture-failed') });
      } else if (remaining(session) <= 0) {
        abort(session, 'work-timeout');
      } else if (!(blob instanceof Blob) || blob.type !== 'image/png' || !blob.size) {
        terminal(session, 'failed', { errorCode: 'invalid-artifact' });
      } else {
        pause(session);
        session.blob = blob;
        session.expiresAt = now() + RETENTION_MS;
        session.stopRetention = schedule(() => expire(session), RETENTION_MS);
        emit({ phase: 'ready-to-deliver', canCancel: true, expiresAt: session.expiresAt });
      }
    }
    const owner = Object.freeze({
      start({ destination } = {}) {
        fresh();
        if (disposed || blocked) throw coded('reload-required');
        if (current && !current.terminal) return state;
        if (!['download', 'clipboard'].includes(destination)) throw coded('invalid-destination');
        if (current) clearArtifact(current);
        const session = { id: identity(), generation: ++generation, attempt: 1,
          controller: new AbortController(), running: true, terminal: false,
          remaining: WORK_MS, activeSince: null, blob: null, transferId: null,
          committed: false, abortCode: null, transfers: new Set() };
        current = session;
        resume(session);
        emit({ sessionId: session.id, attempt: 1, phase: 'preparing', destination,
          section: 0, sections: 0, errorCode: null, canCancel: true,
          expiresAt: null, deliveryOutcome: null });
        try {
          Promise.resolve(run(contextFor(session))).then(
            (blob) => settle(session, null, blob), (error) => settle(session, error));
        } catch (error) { settle(session, error); }
        return state;
      },
      snapshot: fresh,
      subscribe(listener) {
        if (typeof listener !== 'function') throw coded('invalid-subscriber');
        fresh();
        listeners.add(listener);
        try { listener(state); } catch { /* Same isolation as later events. */ }
        return () => listeners.delete(listener);
      },
      cancel(sessionId) {
        fresh();
        if (current?.id === sessionId) abort(current, 'cancelled');
        return state;
      },
      artifact(sessionId) {
        fresh();
        if (current?.id !== sessionId || !current.blob) throw coded('artifact-unavailable');
        return current.blob;
      },
      beginTransfer(sessionId, transferId) {
        fresh();
        if (current?.id !== sessionId || !token(transferId) || state.phase !== 'ready-to-deliver'
            || current.committed || !current.blob || current.transfers.has(transferId)) return state;
        current.transfers.add(transferId);
        current.transferId = transferId;
        resume(current);
        return emit({ phase: 'transferring', canCancel: true });
      },
      commitDelivery(sessionId, transferId) {
        fresh();
        if (current?.id !== sessionId || current.transferId !== transferId
            || state.phase !== 'transferring' || !current.blob || current.committed
            || current.controller.signal.aborted) return false;
        current.committed = true;
        emit({ phase: 'delivering', canCancel: false });
        return true;
      },
      finishDelivery(sessionId, transferId, outcome) {
        fresh();
        if (current?.id !== sessionId || current.transferId !== transferId || !current.committed
            || current.terminal || !['success', 'failed', 'unknown'].includes(outcome)) return state;
        if (outcome === 'success') clearArtifact(current);
        return terminal(current, outcome === 'success' ? 'completed' : 'failed', {
          deliveryOutcome: outcome === 'unknown' ? 'unknown' : 'known',
          errorCode: outcome === 'success' ? null : outcome === 'unknown' ? 'delivery-unknown' : 'delivery-failed',
        });
      },
      disconnectTransfer(transferId) {
        fresh();
        if (!current || current.transferId !== transferId || current.terminal) return state;
        if (current.committed) return owner.finishDelivery(current.id, transferId, 'unknown');
        current.transferId = null;
        pause(current);
        return emit({ phase: 'ready-to-deliver', canCancel: true });
      },
      dispose() {
        disposed = true;
        if (current) {
          if (current.committed && !current.terminal) owner.finishDelivery(current.id, current.transferId, 'unknown');
          else abort(current, 'cancelled');
          clearArtifact(current);
        }
      },
    });
    installed = owner;
    return owner;
  }
  Longform.sessions = Object.freeze({ install });
})();
