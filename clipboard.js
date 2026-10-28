(() => {
  const canCopyArtifact = () => (
    Boolean(navigator.clipboard?.write) && typeof ClipboardItem !== 'undefined'
  );

  const phrases = Object.freeze({
    ready: Object.freeze({ phase: 'ready', text: '' }),
    saving: Object.freeze({ phase: 'saving', text: 'Saving...' }),
    copying: Object.freeze({ phase: 'copying', text: 'Copying...' }),
    saved: Object.freeze({ phase: 'saved', text: 'Download started.' }),
    copied: Object.freeze({ phase: 'copied', text: 'Copied.' }),
    'delivery-unknown': Object.freeze({ phase: 'error', text: 'Delivery may have completed. Choose Save or Copy to try again.' }),
    'reload-required': Object.freeze({ phase: 'blocked', text: 'Reload this page, then try again.' }),
    'artifact-expired': Object.freeze({ phase: 'error', text: 'Capture expired. Choose Save or Copy to capture again.' }),
    'incomplete-coverage': Object.freeze({ phase: 'error', text: 'This page could not be captured completely. Try another page.' }),
    'unstable-page': Object.freeze({ phase: 'error', text: 'This page kept changing. Wait for it to settle, then try again.' }),
    'resource-timeout': Object.freeze({ phase: 'error', text: 'Page images did not finish loading. Wait, then try again.' }),
    'work-timeout': Object.freeze({ phase: 'error', text: 'Capture took too long. Try a shorter page.' }),
    'target-changed': Object.freeze({ phase: 'error', text: 'The active page changed. Keep this page active, then try again.' }),
    'worker-interrupted': Object.freeze({ phase: 'error', text: 'Capture was interrupted. Try again.' }),
    'cleanup-failed': Object.freeze({ phase: 'blocked', text: 'The page could not be restored. Reload it, then try again.' }),
    'transfer-failed': Object.freeze({ phase: 'error', text: 'The PNG could not be transferred. Reopen Longform, then choose Save or Copy.' }),
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

  /** Callback resolves a validated Blob only after delivery commit succeeds. */
  async function copyBlobDuringGesture(getCommittedBlob) {
    if (globalThis.location?.protocol !== 'chrome-extension:') throw new Error('clipboard write runs in the popup');
    if (!canCopyArtifact()) return { phrase: 'copy-unavailable', deliveryOutcome: 'failed' };
    let captureError;
    const blobPromise = Promise.resolve().then(getCommittedBlob).then((blob) => {
      if (!(blob instanceof Blob) || blob.type !== 'image/png' || !blob.size) {
        throw Object.assign(new Error('Invalid PNG'), { code: 'copy-invalid' });
      }
      return blob;
    }).catch((error) => { captureError = error; throw error; });
    // Attach a rejection handler even if ClipboardItem throws synchronously.
    blobPromise.catch(() => {});
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blobPromise })]);
      await blobPromise;
      return { phrase: 'copied', deliveryOutcome: 'success' };
    } catch (writeError) {
      try { await blobPromise; } catch (error) { captureError = error; }
      return { phrase: phraseForFailure(captureError, writeError),
        deliveryOutcome: captureError?.code === 'delivery-unknown' ? 'unknown' : 'failed' };
    }
  }

  Longform.clipboard = Object.freeze({
    canCopyArtifact,
    phrases,
    copyBlobDuringGesture,
  });
})();
