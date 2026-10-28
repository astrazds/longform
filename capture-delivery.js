(() => {
  globalThis.Longform ||= {};
  if (Longform.delivery) return;
  const urls = new Map();
  let active = true;
  const HANDOFF_MS = 1000;
  const fail = () => Object.assign(new Error('transfer-failed'), { code: 'transfer-failed' });
  function extensionDocument() {
    if (globalThis.location?.protocol !== 'chrome-extension:') throw new Error('Delivery requires an extension document');
    if (!active) throw fail();
  }
  /** Validate actual PNG decoding and the source IHDR dimensions before commit. */
  async function validate(blob, dimensions, ctx) {
    extensionDocument();
    if (!(blob instanceof Blob) || blob.type !== 'image/png' || !blob.size) throw fail();
    let bitmap;
    try {
      try { bitmap = await createImageBitmap(blob); }
      catch { if (ctx.signal.aborted) throw ctx.signal.reason; throw fail(); }
      ctx.checkpoint();
      extensionDocument();
      if (bitmap.width !== dimensions.width || bitmap.height !== dimensions.height) throw fail();
    } finally { bitmap?.close(); }
  }
  function revoke(url) {
    if (!urls.has(url)) return;
    clearTimeout(urls.get(url)); urls.delete(url); URL.revokeObjectURL(url);
  }
  function dispose() { active = false; for (const url of [...urls.keys()]) revoke(url); }
  /** Caller must have received a validated PNG and won COMMIT_DELIVERY first. */
  function save(blob, filename) {
    extensionDocument();
    if (!(blob instanceof Blob) || blob.type !== 'image/png' || !blob.size) throw fail();
    const url = URL.createObjectURL(blob);
    urls.set(url, null);
    let anchor;
    try {
      anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = typeof filename === 'string' && filename ? filename : 'capture.png';
      document.body.appendChild(anchor);
      anchor.click();
      urls.set(url, setTimeout(() => revoke(url), HANDOFF_MS));
      return { outcome: 'started' };
    } catch (error) { revoke(url); throw error; }
    finally { anchor?.remove(); }
  }
  if (globalThis.location?.protocol === 'chrome-extension:') {
    globalThis.addEventListener?.('pagehide', dispose);
    globalThis.addEventListener?.('unload', dispose);
  }
  Longform.delivery = Object.freeze({ validate, save, dispose });
})();
