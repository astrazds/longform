(() => {
  if (Longform.capture) return;
  const { limits, protocolVersion } = Longform.protocol;
  const geometry = Longform.geometry;
  const coded = (code) => Object.assign(new Error(code), { code });
  const MAX_SECTIONS = 2048;
  const scrollKeys = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Spacebar']);

  /** Conservative working-set estimate, not a guarantee of browser RSS. */
  function estimateWorkingBytes({ canvasPixels, tilePixels, pngBytes }) {
    if (![canvasPixels, tilePixels, pngBytes].every((n) => Number.isFinite(n) && n >= 0)) return Infinity;
    return 12 * canvasPixels + 8 * tilePixels + 8 * pngBytes + limits.digestOverheadBytes;
  }
  function memoryFor(metrics, pngBytes) {
    const size = geometry.getCanvasSize(metrics);
    const canvasPixels = size.width * size.height;
    const tilePixels = Math.ceil(metrics.viewportWidth * metrics.pixelRatio) * Math.ceil(metrics.viewportHeight * metrics.pixelRatio);
    // Reserve uncompressed RGBA plus row filters, conservative stored-deflate
    // block/chunk overhead and headers. Never assume image compressibility.
    const raw = canvasPixels * 4 + size.height;
    const reserve = raw + Math.ceil(raw / 16383) * 5 + Math.ceil(raw / 32768) * 12 + 1024;
    if (estimateWorkingBytes({ canvasPixels, tilePixels, pngBytes: pngBytes ?? reserve }) > limits.workingMemoryBytes) throw coded('page-too-large');
    return size;
  }
  function positions(metrics) {
    const xs = geometry.getCapturePositions(metrics.pageWidth, metrics.viewportWidth, metrics.scrollLimits.maxScrollX);
    const ys = geometry.getCapturePositions(metrics.pageHeight, metrics.viewportHeight, metrics.scrollLimits.maxScrollY);
    if (xs.length * ys.length > MAX_SECTIONS) throw coded('page-too-large');
    return ys.flatMap((y) => xs.map((x) => ({ x, y })));
  }
  function sameLayout(left, right) {
    return ['generation', 'pageWidth', 'pageHeight', 'viewportWidth', 'viewportHeight', 'pixelRatio']
      .every((key) => left[key] === right[key]) && right.visibleResourcesReady;
  }

  /** One original transaction, at most two complete capture attempts. Returns
   * a PNG only after validation and unconditional restoration have succeeded.
   * @param {object} ctx Managed SessionContext supplied by sessions.install.
   * @returns {Promise<Blob>}
   */
  async function run(ctx) {
    const controller = new AbortController();
    const stop = (code) => { if (!controller.signal.aborted) controller.abort(coded(code)); };
    const parentAbort = () => controller.abort(ctx.signal.reason);
    ctx.signal.addEventListener('abort', parentAbort, { once: true });
    if (ctx.signal.aborted) parentAbort();
    let finished = false;
    let generation;
    let pendingActivityGeneration;
    const checkpoint = (attempt = ctx.attempt) => {
      if (finished) throw coded('stale-session');
      if (document.visibilityState !== 'visible') stop('target-changed');
      if (controller.signal.aborted) throw controller.signal.reason;
      ctx.checkpoint(attempt);
    };
    // Race local input/pagehide interruption as well as the owner's work deadline.
    // Native operations may outlive the race; their results cannot escape it.
    async function guarded(operation, discard, code = 'external-timeout', external = true) {
      const attempt = ctx.attempt;
      checkpoint(attempt);
      let accepted = false;
      let discarded = false;
      const release = (value) => { if (!discarded) { discarded = true; discard?.(value); } };
      const native = Promise.resolve().then(() => { checkpoint(attempt); return operation(); });
      const aborted = deferredAbort(controller.signal);
      try {
        const value = await Promise.race([external ? ctx.external(() => native, code) : native, aborted.promise]);
        checkpoint(attempt);
        accepted = true;
        return value;
      } finally {
        aborted.dispose();
        void native.then((value) => { if (!accepted) release(value); }, () => {});
      }
    }
    const localCtx = Object.freeze({
      sessionId: ctx.sessionId, documentId: ctx.documentId,
      get attempt() { return ctx.attempt; }, get deadline() { return ctx.deadline; },
      signal: controller.signal, checkpoint, publish: (patch) => ctx.publish(patch),
      external: (operation, code) => guarded(operation, undefined, code),
    });
    const onInput = (event) => { if (event.type !== 'keydown' || scrollKeys.has(event.key)) stop('user-interrupted'); };
    const onHide = () => stop('page-restored');
    // A return to this tab cannot revive work after any loss of visibility.
    const onVisibility = () => { if (document.visibilityState !== 'visible') stop('target-changed'); };
    const onActivityLost = (message, sender) => {
      if (sender?.id === chrome.runtime.id && message?.type === 'CAPTURE_TARGET_LOST'
          && message.protocolVersion === protocolVersion
          && message.documentId === ctx.documentId && message.sessionId === ctx.sessionId) {
        if (generation && message.generation === generation) stop('target-changed');
        // The worker's notification may beat its HELLO reply across IPC. Check
        // its generation against that reply before any preparation can begin.
        else if (!generation) pendingActivityGeneration = message.generation;
      }
      return false;
    };
    const inputTypes = ['wheel', 'touchstart', 'keydown'];
    for (const type of inputTypes) window.addEventListener(type, onInput, { capture: true, passive: true });
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onVisibility);
    chrome.runtime.onMessage.addListener(onActivityLost);
    let transaction;
    let observer;
    let canvas;
    let captureMetrics;
    let restored = false;
    let tileIndex = 0; // Broker counter spans attempts; section progress does not.
    let requestIndex = 0;
    const releaseActivity = (workerGeneration) => {
      try {
        if (workerGeneration) void chrome.runtime.sendMessage({ type: 'BROKER_RELEASE', protocolVersion,
          requestId: `${ctx.sessionId}:release`, generation: workerGeneration,
          documentId: ctx.documentId, sessionId: ctx.sessionId }).catch(() => {});
      } catch { /* Destroyed extension contexts cannot mask page cleanup failure. */ }
    };
    const freeCanvas = () => { if (canvas) { canvas.width = 0; canvas.height = 0; canvas = null; } };
    async function restore() {
      if (restored || !transaction) return;
      restored = true;
      try { ctx.publish({ phase: 'restoring' }); } catch { /* Cleanup cannot depend on publication. */ }
      let failed = false;
      try { observer?.dispose(); } catch { failed = true; }
      try { if (!(await transaction.restore())?.ok) failed = true; } catch { failed = true; }
      if (failed) throw coded('cleanup-failed');
    }
    // The observer owns the local 10s settle bound and its resource/layout
    // classification. Only its external polls are raced against 10s by ctx.
    const settleVisible = () => guarded(() => observer.settleVisible(), undefined, 'external-timeout', false);
    async function traverse() {
      const visited = new Set();
      for (let count = 0; ; count++) {
        checkpoint();
        const metrics = observer.measure();
        memoryFor(metrics);
        const next = positions(metrics).find(({ x, y }) => !visited.has(`${x}:${y}`));
        if (!next) break;
        if (count >= MAX_SECTIONS) throw coded('unstable-page');
        visited.add(`${next.x}:${next.y}`);
        await guarded(() => transaction.scrollTo(next.x, next.y)); checkpoint();
        await settleVisible(); checkpoint();
      }
      // Lazy additions may have introduced fixed/sticky elements. The same
      // transaction journals only newly touched declarations.
      await guarded(() => transaction.prepare()); checkpoint();
      await guarded(() => transaction.scrollTo(0, 0)); checkpoint();
      await settleVisible(); checkpoint();
    }
    try {
      checkpoint();
      transaction = Longform.page.beginTransaction(localCtx);
      const hello = await guarded(() => chrome.runtime.sendMessage({ type: 'BROKER_HELLO', protocolVersion,
        documentId: ctx.documentId, sessionId: ctx.sessionId }), (late) => releaseActivity(late?.generation)); checkpoint();
      if (!hello?.success || typeof hello.generation !== 'string' || !hello.generation) throw coded(hello?.errorCode || 'worker-interrupted');
      generation = hello.generation;
      if (pendingActivityGeneration === generation) stop('target-changed');
      checkpoint();
      for (let attempt = 1; attempt <= 2; attempt++) {
        ctx.publish({ attempt, phase: 'preparing', section: 0, sections: 0 });
        try {
          await guarded(() => transaction.prepare()); checkpoint(attempt);
          observer ||= Longform.page.observeLayout(transaction, localCtx);
          await traverse(); checkpoint(attempt);
          const frozen = observer.sample();
          const metrics = Object.freeze({ ...frozen });
          captureMetrics = metrics;
          const size = memoryFor(metrics);
          const planned = positions(metrics);
          canvas = document.createElement('canvas');
          canvas.width = size.width; canvas.height = size.height;
          const drawing = canvas.getContext('2d');
          if (!drawing) throw coded('canvas-unavailable');
          drawing.fillStyle = Longform.page.backgroundColor();
          drawing.fillRect(0, 0, canvas.width, canvas.height);
          const coverage = geometry.createCoverage(size);
          ctx.publish({ phase: 'capturing', sections: planned.length, section: 0 });
          for (let section = 0; section < planned.length; section++) {
            const { x, y } = planned[section];
            await guarded(() => transaction.scrollTo(x, y)); checkpoint(attempt);
            await settleVisible(); checkpoint(attempt);
            let actual = observer.sample();
            if (!sameLayout(frozen, actual)) throw coded('unstable-page');
            const index = tileIndex++;
            const response = await guarded(() => chrome.runtime.sendMessage({
              type: 'CAPTURE_TILE', protocolVersion, requestId: `${ctx.sessionId}:tile:${requestIndex++}`,
              documentId: ctx.documentId, sessionId: ctx.sessionId, generation, tileIndex: index,
            })); checkpoint(attempt);
            if (!response?.success) throw coded(response?.errorCode || 'capture-failed');
            if (response.generation !== generation) throw coded('worker-interrupted');
            if (response.tileIndex !== index || typeof response.dataUrl !== 'string') throw coded('invalid-response');
            const beforeScreenshot = actual;
            const bitmap = await guarded(async () => {
              const responseBlob = await fetch(response.dataUrl); checkpoint(attempt);
              const blob = await responseBlob.blob(); checkpoint(attempt);
              return createImageBitmap(blob);
            }, (late) => late?.close());
            try {
              checkpoint(attempt);
              actual = observer.sample();
              if (!sameLayout(frozen, actual) || actual.scrollX !== beforeScreenshot.scrollX
                  || actual.scrollY !== beforeScreenshot.scrollY) throw coded('unstable-page');
              coverage.add(geometry.drawCapture(drawing, bitmap, metrics, actual.scrollX, actual.scrollY));
            } finally { bitmap.close(); }
            ctx.publish({ section: section + 1 });
          }
          ctx.publish({ phase: 'validating' });
          await settleVisible(); checkpoint(attempt);
          if (!sameLayout(frozen, observer.sample())) throw coded('unstable-page');
          if (!coverage.result().complete) throw coded('incomplete-coverage');
          break;
        } catch (error) {
          freeCanvas();
          checkpoint(attempt);
          if (!['unstable-page', 'layout-unstable'].includes(error?.code)) throw error;
          if (attempt === 2) throw coded('unstable-page');
        }
      }
      await restore(); checkpoint();
      ctx.publish({ phase: 'encoding' });
      memoryFor(captureMetrics);
      // The pre-allocation check reserved the entire worst-case PNG. Check the
      // actual encoded size again before exposing any bytes to the owner.
      const blob = await guarded(() => canvasToPngBlob(canvas)); checkpoint();
      if (!(blob instanceof Blob) || blob.type !== 'image/png' || !blob.size) throw coded('encoding-failed');
      if (blob.size > limits.artifactBytes) throw coded('page-too-large');
      memoryFor(captureMetrics, blob.size);
      return blob;
    } finally {
      // Restoration never checkpoints, even when preparation only partially ran.
      try { await restore(); }
      finally {
        finished = true;
        freeCanvas();
        ctx.signal.removeEventListener('abort', parentAbort);
        for (const type of inputTypes) window.removeEventListener(type, onInput, { capture: true });
        window.removeEventListener('pagehide', onHide);
        document.removeEventListener('visibilitychange', onVisibility);
        chrome.runtime.onMessage.removeListener(onActivityLost);
        releaseActivity(generation);
      }
    }
  }
  function deferredAbort(signal) {
    let listener;
    const promise = new Promise((resolve, reject) => {
      listener = () => reject(signal.reason);
      if (signal.aborted) listener(); else signal.addEventListener('abort', listener, { once: true });
    });
    return { promise, dispose: () => signal.removeEventListener('abort', listener) };
  }
  function canvasToPngBlob(canvas) {
    return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(coded('encoding-failed')), 'image/png'));
  }
  Longform.capture = Object.freeze({ run, estimateWorkingBytes });
})();
