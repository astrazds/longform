(() => {
  globalThis.Longform ||= {};
  const { limits, protocolVersion } = Longform.protocol;
  const fail = (code) => Object.assign(new Error(code), { code });
  const token = (value) => typeof value === 'string' && value.length > 0 && value.length <= 200;

  /**
   * Worker-owned broker. Browser sender.documentId is NOT the session documentId:
   * authenticate the former, then bind the latter to that authenticated document.
   * Requests: {type,protocolVersion,requestId,documentId,sessionId,generation,
   * tileIndex?}; digest messages add {transferId,chunkIndex,byteLength?|data?}.
   * data is base64 of at most256KiB; byteLength is the complete artifact length.
   */
  function create({ tabs, runtimeId, now = Date.now, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
    const generation = crypto.randomUUID();
    const documents = new Map();
    const digests = new Set();
    let reserved = 0;
    let queue = Promise.resolve();
    let lastCapture = -Infinity;

    function authenticate(sender) {
      if (sender?.id !== runtimeId || sender.frameId !== 0 || !token(sender.documentId)
          || !Number.isInteger(sender.tab?.id) || !Number.isInteger(sender.tab?.windowId)
          || !/^https?:\/\//i.test(sender.url || '')
          || (sender.documentLifecycle && sender.documentLifecycle !== 'active')) throw fail('invalid-sender');
    }
    function release(entry) {
      clearTimeout(entry.timer);
      if (entry.released) return;
      entry.released = true;
      reserved -= entry.reservation;
      entry.buffer = null;
      digests.delete(entry);
    }
    function expire(entry) {
      entry.invalid = true;
      // Native hashing may still own a copy; keep its reservation until settled.
      if (entry.phase !== 'hashing') release(entry);
    }
    function sweep() {
      for (const entry of digests) if (now() - entry.touched >= limits.externalMs) expire(entry);
    }
    function touch(entry) {
      entry.touched = now();
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => expire(entry), limits.externalMs);
      entry.timer.unref?.();
    }
    function invalidate({ tabId, windowId }) {
      for (const [id, record] of documents) {
        if ((tabId !== undefined && id === tabId) || (windowId !== undefined && record.windowId === windowId)) {
          record.epoch++;
          // Activation invalidates in-flight work without forgetting tile counters.
          for (const entry of digests) if (entry.record === record) expire(entry);
        }
      }
    }
    function hello(sender) {
      authenticate(sender);
      const previous = documents.get(sender.tab.id);
      if (!previous || previous.browserDocumentId !== sender.documentId || previous.windowId !== sender.tab.windowId) {
        if (previous) {
          previous.epoch++;
          for (const entry of digests) if (entry.record === previous) expire(entry);
        }
        // At most one document per tab; stale bound records fail object identity fences.
        documents.set(sender.tab.id, { browserDocumentId: sender.documentId, windowId: sender.tab.windowId,
          epoch: 0, contentDocumentId: null, sessions: new Map() });
      }
      return { generation };
    }
    function scope(request, sender) {
      authenticate(sender);
      if (request?.generation !== generation) throw fail('worker-interrupted');
      if (request.protocolVersion !== protocolVersion || !token(request.requestId)
          || !token(request.documentId) || !token(request.sessionId)) throw fail('invalid-request');
      const record = documents.get(sender.tab.id);
      if (!record || record.browserDocumentId !== sender.documentId || record.windowId !== sender.tab.windowId) throw fail('target-changed');
      if (record.contentDocumentId && record.contentDocumentId !== request.documentId) throw fail('invalid-request');
      record.contentDocumentId = request.documentId;
      let session = record.sessions.get(request.sessionId);
      if (!session) {
        if (record.sessions.size >= 64) throw fail('memory-limit');
        session = { nextTile: 0, busy: false };
        record.sessions.set(request.sessionId, session);
      }
      return { record, session, epoch: record.epoch };
    }
    function fence(bound, sender) {
      if (documents.get(sender.tab.id) !== bound.record || bound.record.epoch !== bound.epoch) throw fail('target-changed');
    }
    function bounded(promise, onTimeout = () => {}) {
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => { onTimeout(); reject(fail('external-timeout')); }, limits.externalMs);
      });
      return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
    }
    async function active(bound, sender) {
      fence(bound, sender);
      const targets = await tabs.query({ active: true, windowId: sender.tab.windowId });
      fence(bound, sender);
      if (targets.length !== 1 || targets[0].id !== sender.tab.id || targets[0].windowId !== sender.tab.windowId) throw fail('target-changed');
    }
    async function capture(request, sender) {
      const bound = scope(request, sender);
      if (request.type !== 'CAPTURE_TILE' || !Number.isSafeInteger(request.tileIndex)
          || request.tileIndex !== bound.session.nextTile || bound.session.busy) throw fail('invalid-request');
      bound.session.busy = true;
      let expired = false;
      const check = () => { if (expired) throw fail('external-timeout'); fence(bound, sender); };
      const task = queue.then(async () => {
        check();
        await wait(Math.max(0, lastCapture + 600 - now()));
        check();
        await active(bound, sender);
        check();
        lastCapture = now();
        let dataUrl;
        try { dataUrl = await tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' }); }
        catch { throw fail('capture-failed'); }
        check();
        await active(bound, sender);
        check();
        if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) throw fail('capture-failed');
        bound.session.nextTile++;
        return { generation, tileIndex: request.tileIndex, dataUrl };
      }).finally(() => { bound.session.busy = false; });
      // The raw task owns the queue even after caller timeout: never overlap captures.
      queue = task.catch(() => {});
      return bounded(task, () => { expired = true; });
    }
    async function digestMessage(request, sender) {
      sweep();
      const bound = scope(request, sender);
      if (!['DIGEST_BEGIN', 'DIGEST_CHUNK', 'DIGEST_END'].includes(request.type)
          || !token(request.transferId) || !Number.isSafeInteger(request.chunkIndex) || request.chunkIndex < 0) throw fail('invalid-request');
      let entry = [...digests].find((item) => item.record === bound.record && item.sessionId === request.sessionId);
      if (request.type === 'DIGEST_BEGIN') {
        if (entry || request.chunkIndex !== 0) throw fail('invalid-request');
        if (!Number.isSafeInteger(request.byteLength) || request.byteLength <= 0 || request.byteLength > limits.artifactBytes) throw fail('memory-limit');
        const reservation = 8 * request.byteLength + limits.digestOverheadBytes;
        if (reserved + reservation > limits.workingMemoryBytes) throw fail('memory-limit');
        entry = { ...bound, sessionId: request.sessionId, transferId: request.transferId,
          buffer: new Uint8Array(request.byteLength), reservation, offset: 0, nextChunk: 0, phase: 'receiving' };
        reserved += reservation;
        digests.add(entry);
        touch(entry);
        return { generation, transferId: request.transferId, chunkIndex: 0 };
      }
      if (!entry || entry.invalid || entry.phase !== 'receiving' || entry.transferId !== request.transferId
          || entry.nextChunk !== request.chunkIndex) throw fail('invalid-request');
      fence(entry, sender);
      if (request.type === 'DIGEST_CHUNK') {
        if (typeof request.data !== 'string' || request.data.length > 4 * Math.ceil(limits.chunkBytes / 3)
            || request.data.length === 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(request.data)) throw fail('invalid-request');
        const raw = atob(request.data);
        if (raw.length > limits.chunkBytes || entry.offset + raw.length > entry.buffer.length) throw fail('invalid-request');
        for (let i = 0; i < raw.length; i++) entry.buffer[entry.offset + i] = raw.charCodeAt(i);
        entry.offset += raw.length;
        entry.nextChunk++;
        touch(entry);
        return { generation, transferId: entry.transferId, chunkIndex: entry.nextChunk };
      }
      if (entry.offset !== entry.buffer.length) throw fail('invalid-request');
      entry.phase = 'hashing';
      touch(entry);
      const hashing = crypto.subtle.digest('SHA-256', entry.buffer).then((hash) => {
        fence(entry, sender);
        if (entry.invalid) throw fail('external-timeout');
        return { generation, transferId: entry.transferId, chunkIndex: entry.nextChunk,
          digest: [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('') };
      }).finally(() => release(entry));
      return bounded(hashing, () => expire(entry));
    }
    return Object.freeze({ hello, capture, invalidate, digestMessage });
  }
  Longform.broker = Object.freeze({ create });
})();
