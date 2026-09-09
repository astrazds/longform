(() => {
  const canCopyArtifact = () => (
    Boolean(navigator.clipboard?.write) && typeof ClipboardItem !== 'undefined'
  );

  function base64ToUint8Array(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    return bytes;
  }

  function isPngBytes(bytes) {
    return bytes.length >= 8
      && bytes[0] === 0x89
      && bytes[1] === 0x50
      && bytes[2] === 0x4e
      && bytes[3] === 0x47
      && bytes[4] === 0x0d
      && bytes[5] === 0x0a
      && bytes[6] === 0x1a
      && bytes[7] === 0x0a;
  }

  function pngBase64ToBlob(base64) {
    if (typeof base64 !== 'string' || !base64) {
      throw new Error('Capture did not return image data for the clipboard');
    }

    const bytes = base64ToUint8Array(base64);
    if (!bytes.length) {
      throw new Error('Capture returned empty PNG data for the clipboard');
    }

    if (!isPngBytes(bytes)) {
      throw new Error('Capture returned invalid PNG data for the clipboard');
    }

    return new Blob([bytes], { type: 'image/png' });
  }

  async function copyPngBlobPromiseToClipboard(blobPromise) {
    if (!canCopyArtifact()) {
      throw new Error('Copying images is not supported in this browser');
    }

    // Start write during the click gesture; the promise may resolve after capture.
    await navigator.clipboard.write([
      new ClipboardItem({
        'image/png': blobPromise,
      }),
    ]);
  }

  Longform.clipboard = Object.freeze({
    canCopyArtifact,
    pngBase64ToBlob,
    copyPngBlobPromiseToClipboard,
  });
})();
