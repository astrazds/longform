(() => {
  globalThis.Longform ||= {};
  if (Longform.transfer) return;
  const { limits, protocolVersion } = Longform.protocol;
  const fail = () => Object.assign(new Error('transfer-failed'), { code: 'transfer-failed' });
  const token = (value) => typeof value === 'string' && value.length > 0 && value.length <= 200;
  let serial = 0;
  const requestId = () => `transfer-${Date.now().toString(36)}-${++serial}`;
  const hex = (buffer) => [...new Uint8Array(buffer)].map((v) => v.toString(16).padStart(2, '0')).join('');
  // Worker8N + popup bytes/native digest/blob4N + retained sourceN + decoded
  // bitmap4P, conservatively summed even across stages that don't overlap.
  // Capture canvases are released; also reserve transport strings/chunk copies.
  const estimateWorkingBytes = (size, pixels = 0) => Number.isSafeInteger(size) && size > 0
    && Number.isSafeInteger(pixels) && pixels >= 0
    ? 13 * size + 4 * pixels + limits.digestOverheadBytes + 8 * limits.chunkBytes : Infinity;
  function boundedSize(size, max = limits.artifactBytes, pixels = 0) {
    if (!Number.isSafeInteger(size) || size <= 0 || size > max || size > limits.artifactBytes
        || estimateWorkingBytes(size, pixels) > limits.workingMemoryBytes) throw fail();
  }
  function encode(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  }
  function decode(data) {
    if (typeof data !== 'string' || !data.length || data.length > 4 * Math.ceil(limits.chunkBytes / 3)
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw fail();
    const raw = atob(data);
    if (!raw.length || raw.length > limits.chunkBytes) throw fail();
    return Uint8Array.from(raw, (char) => char.charCodeAt(0));
  }
  function pngDimensions(bytes) {
    if (bytes.length < 33 || ![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)
        || bytes[8] || bytes[9] || bytes[10] || bytes[11] !== 13
        || String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') throw fail();
    const integer = (offset) => bytes[offset] * 16777216 + bytes[offset + 1] * 65536 + bytes[offset + 2] * 256 + bytes[offset + 3];
    const width = integer(16); const height = integer(20);
    if (!width || !height || width > 32767 || height > 32767 || width * height > 268435456) throw fail();
    return { width, height };
  }
  /**
   * TransferContext: {documentId,sessionId,signal,checkpoint(),external(operation,code?)}.
   * checkpoint must fence this transfer, identity, work budget and original TTL;
   * external must race abort and min(10s, time until expiresAt). It is NOT the
   * capture runner's context, which is invalid after runner settlement.
   */
  function connection(port, ctx, transferId) {
    if (!token(transferId) || !token(ctx?.documentId) || !token(ctx?.sessionId)
        || !ctx.signal || typeof ctx.checkpoint !== 'function' || typeof ctx.external !== 'function') throw fail();
    const validator = Longform.protocol.createEnvelopeValidator(ctx);
    let stopped; let waiter; let queued;
    let rejectClosed;
    const closed = new Promise((_, reject) => { rejectClosed = reject; });
    closed.catch(() => {});
    const stop = (error = fail()) => {
      if (stopped) return;
      stopped = error;
      waiter?.reject(error); waiter = null; queued = null;
      rejectClosed(error);
    };
    const message = (value) => {
      if (!['ARTIFACT_BEGIN', 'ARTIFACT_CHUNK', 'ARTIFACT_END', 'CHUNK_ACK'].includes(value?.type)) return;
      if (stopped) return;
      if (!validator.accept(value) || value.transferId !== transferId || queued) { stop(); return; }
      if (waiter) { const next = waiter; waiter = null; next.resolve(value); }
      else queued = value;
    };
    const disconnect = () => stop();
    const abort = () => stop(ctx.signal.reason || fail());
    port.onMessage.addListener(message);
    port.onDisconnect.addListener(disconnect);
    ctx.signal.addEventListener('abort', abort, { once: true });
    if (ctx.signal.aborted) abort();
    const check = () => { if (stopped) throw stopped; ctx.checkpoint(); };
    return {
      check,
      async work(operation) {
        check();
        const result = await ctx.external(() => Promise.race([Promise.resolve().then(() => { check(); return operation(); }), closed]));
        check(); return result;
      },
      envelope(type, chunkIndex, extra = {}) {
        return { type, protocolVersion, documentId: ctx.documentId, sessionId: ctx.sessionId,
          requestId: requestId(), transferId, chunkIndex, ...extra };
      },
      post(value) { check(); try { port.postMessage(value); } catch { throw fail(); } },
      take() {
        check();
        if (queued) { const value = queued; queued = null; return Promise.resolve(value); }
        return new Promise((resolve, reject) => { waiter = { resolve, reject }; });
      },
      dispose() {
        stop();
        port.onMessage.removeListener(message);
        port.onDisconnect.removeListener(disconnect);
        ctx.signal.removeEventListener('abort', abort);
      },
    };
  }
  /** Content producer: source SHA-256 is computed by the authenticated worker. */
  async function send(blob, { port, ctx, transferId }) {
    const wire = connection(port, ctx, transferId);
    try {
      if (!(blob instanceof Blob) || blob.type !== 'image/png') throw fail();
      boundedSize(blob.size);
      const dimensions = pngDimensions(new Uint8Array(await wire.work(() => blob.slice(0, 33).arrayBuffer())));
      boundedSize(blob.size, limits.artifactBytes, dimensions.width * dimensions.height);
      const hello = await wire.work(() => chrome.runtime.sendMessage({ type: 'BROKER_HELLO' }));
      if (!hello?.success || !token(hello.generation)) throw fail();
      const generation = hello.generation;
      async function digest(type, chunkIndex, extra = {}) {
        const reply = await wire.work(() => chrome.runtime.sendMessage({ type, protocolVersion,
          requestId: requestId(), documentId: ctx.documentId, sessionId: ctx.sessionId,
          generation, transferId, chunkIndex, ...extra }));
        const expected = chunkIndex + (type === 'DIGEST_CHUNK' ? 1 : 0);
        if (!reply?.success) throw Object.assign(fail(), { code: reply?.errorCode || 'transfer-failed' });
        if (reply.generation !== generation || reply.transferId !== transferId || reply.chunkIndex !== expected) throw fail();
        return reply;
      }
      await digest('DIGEST_BEGIN', 0, { byteLength: blob.size });
      let count = 0;
      for (let offset = 0; offset < blob.size; offset += limits.chunkBytes) {
        const bytes = new Uint8Array(await wire.work(() => blob.slice(offset, offset + limits.chunkBytes).arrayBuffer()));
        await digest('DIGEST_CHUNK', count++, { data: encode(bytes) });
      }
      const { digest: sourceDigest } = await digest('DIGEST_END', count);
      if (!/^[a-f0-9]{64}$/.test(sourceDigest)) throw fail();
      async function acknowledged(type, chunkIndex, extra = {}) {
        const outgoing = wire.envelope(type, chunkIndex, extra);
        const reply = await wire.work(() => { const pending = wire.take(); wire.post(outgoing); return pending; });
        if (reply.type !== 'CHUNK_ACK' || reply.success !== true || reply.replyTo !== outgoing.requestId
            || reply.ackFor !== type || reply.chunkIndex !== chunkIndex + (type === 'ARTIFACT_CHUNK' ? 1 : 0)) throw fail();
      }
      await acknowledged('ARTIFACT_BEGIN', 0, { byteLength: blob.size, mimeType: 'image/png', digest: sourceDigest, ...dimensions });
      let index = 0;
      for (let offset = 0; offset < blob.size; offset += limits.chunkBytes) {
        const bytes = new Uint8Array(await wire.work(() => blob.slice(offset, offset + limits.chunkBytes).arrayBuffer()));
        await acknowledged('ARTIFACT_CHUNK', index++, { data: encode(bytes) });
      }
      await acknowledged('ARTIFACT_END', index);
    } finally { wire.dispose(); }
  }
  /** Popup receiver: allocates only after bounds validation; no delivery commit. */
  async function receive({ port, ctx, transferId, maxBytes = limits.artifactBytes }) {
    if (globalThis.location?.protocol !== 'chrome-extension:') throw fail();
    const wire = connection(port, ctx, transferId);
    let bytes; let incoming;
    const ack = (success, chunkIndex) => wire.post(wire.envelope('CHUNK_ACK', chunkIndex, {
      replyTo: incoming.requestId, ackFor: incoming.type, success,
    }));
    try {
      incoming = await wire.work(() => wire.take());
      if (incoming.type !== 'ARTIFACT_BEGIN' || incoming.chunkIndex !== 0 || incoming.mimeType !== 'image/png'
          || !/^[a-f0-9]{64}$/.test(incoming.digest) || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw fail();
      boundedSize(incoming.byteLength, maxBytes);
      const metadata = incoming;
      if (!Number.isSafeInteger(metadata.width) || !Number.isSafeInteger(metadata.height)
          || metadata.width <= 0 || metadata.height <= 0 || metadata.width > 32767 || metadata.height > 32767
          || metadata.width * metadata.height > 268435456) throw fail();
      boundedSize(metadata.byteLength, maxBytes, metadata.width * metadata.height);
      bytes = new Uint8Array(metadata.byteLength);
      ack(true, 0);
      let index = 0; let offset = 0;
      for (;;) {
        incoming = await wire.work(() => wire.take());
        if (incoming.chunkIndex !== index) throw fail();
        if (incoming.type === 'ARTIFACT_END') break;
        if (incoming.type !== 'ARTIFACT_CHUNK') throw fail();
        const chunk = decode(incoming.data);
        if (offset + chunk.length > bytes.length) throw fail();
        bytes.set(chunk, offset); offset += chunk.length;
        ack(true, ++index);
      }
      if (offset !== bytes.length) throw fail();
      const dimensions = pngDimensions(bytes);
      if (dimensions.width !== metadata.width || dimensions.height !== metadata.height) throw fail();
      const digest = hex(await wire.work(() => crypto.subtle.digest('SHA-256', bytes)));
      if (digest !== metadata.digest) throw fail();
      const blob = new Blob([bytes], { type: 'image/png' });
      await wire.work(() => Longform.delivery.validate(blob, dimensions, ctx));
      wire.check();
      ack(true, index);
      return blob;
    } catch (error) {
      // Negative acknowledgement contains no bytes or arbitrary exception text.
      try { if (incoming) ack(false, incoming.chunkIndex); } catch { /* disconnected/expired */ }
      throw error;
    } finally { bytes = null; wire.dispose(); }
  }
  Longform.transfer = Object.freeze({ send, receive, estimateWorkingBytes });
})();
