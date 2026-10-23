(() => {
  const canCopyArtifact = () => (
    Boolean(navigator.clipboard?.write) && typeof ClipboardItem !== 'undefined'
  );

  const phrases = Object.freeze({
    ready: Object.freeze({ phase: 'ready', text: '' }),
    saving: Object.freeze({ phase: 'saving', text: 'Saving...' }),
    copying: Object.freeze({ phase: 'copying', text: 'Copying...' }),
    saved: Object.freeze({ phase: 'saved', text: 'Saved.' }),
    copied: Object.freeze({ phase: 'copied', text: 'Copied.' }),
    'page-too-large': Object.freeze({
      phase: 'blocked',
      text: 'This page is too large for one PNG. Try another page.',
    }),
    incomplete: Object.freeze({
      phase: 'blocked',
      text: 'This page could not be captured completely. Try another page.',
    }),
    blocked: Object.freeze({
      phase: 'blocked',
      text: 'Open a regular web page, then try again.',
    }),
    'copy-unavailable': Object.freeze({
      phase: 'error',
      text: 'Copy is unavailable in this browser. Save the screenshot instead.',
    }),
    readyCopyUnavailable: Object.freeze({
      phase: 'ready',
      text: 'Copy is unavailable in this browser. You can still save the screenshot.',
    }),
    'copy-denied': Object.freeze({
      phase: 'error',
      text: 'Clipboard access was blocked. Try again, or save the screenshot.',
    }),
    'copy-too-large': Object.freeze({
      phase: 'error',
      text: 'This PNG is too large to copy. Save it instead.',
    }),
    'copy-invalid': Object.freeze({
      phase: 'error',
      text: 'The screenshot could not be copied. Save it instead.',
    }),
    'copy-decode': Object.freeze({
      phase: 'error',
      text: 'The screenshot could not be copied. Try again, or save it instead.',
    }),
    'copy-failed': Object.freeze({
      phase: 'error',
      text: 'Could not copy this page. Try again, or save the screenshot.',
    }),
    'save-failed': Object.freeze({
      phase: 'error',
      text: 'Could not save this page. Try again or choose another page.',
    }),
    labels: Object.freeze({
      heading: 'Full-page screenshot',
      save: 'Save',
      copy: 'Copy',
      saveAria: 'Save full-page screenshot as PNG',
      copyAria: 'Copy full-page screenshot as PNG',
    }),
  });

  const CAPTURE_PHRASES = new Set(['page-too-large', 'incomplete', 'blocked']);

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
      const error = new Error('Capture did not return image data for the clipboard');
      error.code = 'copy-invalid';
      throw error;
    }

    const bytes = base64ToUint8Array(base64);
    if (!bytes.length) {
      const error = new Error('Capture returned empty PNG data for the clipboard');
      error.code = 'copy-invalid';
      throw error;
    }

    if (!isPngBytes(bytes)) {
      const error = new Error('Capture returned invalid PNG data for the clipboard');
      error.code = 'copy-invalid';
      throw error;
    }

    return new Blob([bytes], { type: 'image/png' });
  }

  async function pngBlobToBase64(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const chunkSize = 0x8000;
    let binary = '';

    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const chunk = bytes.subarray(offset, offset + chunkSize);
      binary += String.fromCharCode.apply(null, chunk);
    }

    return btoa(binary);
  }

  function classifyWriteError(error) {
    if (phrases[error?.code]) return error.code;

    const message = error?.message || '';

    if (/not supported/i.test(message)) return 'copy-unavailable';

    if (/notallowed|permission|denied|document is not focused|clipboarditem presentation/i.test(message)) {
      return 'copy-denied';
    }

    if (/message length|QuotaExceeded|too large to copy|Array buffer/i.test(message)) {
      return 'copy-too-large';
    }

    if (/did not return image data|invalid png|empty png/i.test(message)) return 'copy-invalid';

    if (/decode|ClipboardItemData|clipboard item/i.test(message)) return 'copy-decode';

    return 'copy-failed';
  }

  function phraseForFailure(captureError, writeError) {
    const code = captureError?.code;
    if (CAPTURE_PHRASES.has(code)) return code;
    if (code === 'no-area' || code === 'failed') return 'copy-failed';
    if (!captureError) return classifyWriteError(writeError);
    if (phrases[code]) return code;
    return classifyWriteError(captureError);
  }

  async function copyDuringGesture(startCapture) {
    if (globalThis.location?.protocol !== 'chrome-extension:') {
      throw new Error('clipboard write runs in the popup');
    }

    if (!canCopyArtifact()) {
      return { phrase: 'copy-unavailable' };
    }

    let settled;
    const capturePromise = Promise.resolve()
      .then(startCapture)
      .then((record) => {
        if (record?.errorCode) {
          const error = new Error(record.error || 'Capture failed');
          error.code = record.errorCode;
          throw error;
        }
        return pngBase64ToBlob(record.clipboardPngBase64);
      })
      .catch((error) => {
        settled = error;
        throw error;
      });

    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'image/png': capturePromise,
        }),
      ]);
      await capturePromise;
    } catch (writeError) {
      try {
        await capturePromise;
      } catch (pending) {
        settled = pending;
      }
      return { phrase: phraseForFailure(settled, writeError) };
    }

    return { phrase: 'copied' };
  }

  Longform.clipboard = Object.freeze({
    canCopyArtifact,
    phrases,
    pngBase64ToBlob,
    pngBlobToBase64,
    copyDuringGesture,
  });
})();
