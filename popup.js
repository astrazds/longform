document.addEventListener('DOMContentLoaded', async () => {
  // Popup controller: validate the source page, ask the content script to capture, then deliver the PNG.
  const screenshotButton = document.getElementById('screenshotBtn');
  const copyButton = document.getElementById('copyBtn');
  const statusElement = document.getElementById('status');
  const statusDetailElement = document.getElementById('statusDetail');
  const tabTitleElement = document.getElementById('tabTitle');
  const tabUrlElement = document.getElementById('tabUrl');
  const tabFaviconElement = document.getElementById('tabFavicon');
  const FULL_PAGE_MESSAGE_TYPE = 'captureFullPage:v4';
  const SUPPORTED_TAB_PROTOCOL = /^https?:/i;

  const setStatus = (message, type = '', detail = '') => {
    statusElement.textContent = message;
    statusElement.className = `status${type ? ` ${type}` : ''}`;
    statusDetailElement.textContent = detail;
  };

  const setSourceActions = ({ enabled = true, copyAvailable = true } = {}) => {
    screenshotButton.querySelector('span').textContent = 'Capture page';
    copyButton.querySelector('span').textContent = 'Copy PNG';
    screenshotButton.disabled = !enabled;
    copyButton.disabled = !enabled || !copyAvailable;
  };

  const canCopyArtifact = () => (
    Boolean(navigator.clipboard?.write) && typeof ClipboardItem !== 'undefined'
  );

  const getBoundaryDetail = (message) => {
    if (/too large/i.test(message)) {
      return 'This page cannot become one complete PNG in Chromium.';
    }

    if (/fully scrolled/i.test(message)) {
      return 'The browser would not scroll far enough to capture the complete page.';
    }

    if (/cannot be captured/i.test(message)) {
      return 'Open a normal http:// or https:// page, then try again.';
    }

    return '';
  };

  const getClipboardErrorDetail = (error) => {
    const message = error?.message || '';

    if (/not supported/i.test(message)) {
      return 'This browser cannot write image data to the clipboard. Use Capture page instead.';
    }

    if (/notallowed|permission|denied|document is not focused|clipboarditem presentation/i.test(message)) {
      return 'Clipboard access was blocked. Keep the popup open and try again, or use Capture page.';
    }

    if (/message length| QuotaExceeded|too large to copy|Array buffer/i.test(message)) {
      return 'The PNG was too large to copy. Use Capture page to save it instead.';
    }

    if (/did not return image data|invalid png|empty png/i.test(message)) {
      return 'The capture finished, but no usable PNG reached the popup. Try Capture page instead.';
    }

    if (/decode|ClipboardItemData|clipboard item/i.test(message)) {
      return 'The browser could not place this PNG on the clipboard. Try Capture page instead.';
    }

    return 'No image was placed on the clipboard. Try again or use Capture page.';
  };

  const getDisplayUrl = (url) => {
    try {
      return new URL(url).host;
    } catch {
      return url || 'Unavailable';
    }
  };

  const updateTabSummary = (tab) => {
    tabTitleElement.textContent = tab?.title || 'Untitled tab';
    tabUrlElement.textContent = getDisplayUrl(tab?.url || '');
    tabFaviconElement.src = 'icons/icon16.png';
  };

  async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab?.id) {
      throw new Error('No active tab found');
    }

    return tab;
  }

  function validateTab(tab) {
    if (!SUPPORTED_TAB_PROTOCOL.test(tab.url || '')) {
      throw new Error('This page cannot be captured');
    }
  }

  async function injectContentScript(tabId) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });
  }

  function getCaptureFilename() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    return `longform-capture-${timestamp}.png`;
  }

  async function requestLongformCapture(tabId, { delivery, filename } = {}) {
    const response = await chrome.tabs.sendMessage(tabId, {
      delivery,
      filename,
      type: FULL_PAGE_MESSAGE_TYPE,
    });

    if (!response?.success) {
      const error = new Error(response?.error || 'Capture failed');
      error.captureDiagnostics = response?.diagnostics;
      throw error;
    }

    return {
      artifact: response.artifact,
      diagnostics: response.diagnostics,
      clipboardPngBase64: response.clipboardPngBase64,
      clipboardType: response.clipboardType,
    };
  }

  async function createCaptureArtifact(destination) {
    const tab = await getActiveTab();
    updateTabSummary(tab);
    validateTab(tab);
    await injectContentScript(tab.id);
    const filename = destination === 'save' ? getCaptureFilename() : undefined;
    const {
      artifact,
      diagnostics,
      clipboardPngBase64,
      clipboardType,
    } = await requestLongformCapture(tab.id, {
      delivery: destination === 'save' ? 'download' : 'clipboard',
      filename,
    });

    return {
      artifact,
      diagnostics,
      filename,
      tab,
      clipboardPngBase64,
      clipboardType,
    };
  }

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

  async function refreshPopupState({ preserveStatus = false } = {}) {
    try {
      const tab = await getActiveTab();
      updateTabSummary(tab);
      validateTab(tab);
      setSourceActions({ enabled: true, copyAvailable: canCopyArtifact() });
      if (!preserveStatus) {
        const detail = canCopyArtifact()
          ? ''
          : 'Copy is unavailable in this browser. Saving is still available.';
        setStatus('Ready', '', detail);
      }
    } catch (error) {
      console.error(error);
      setSourceActions({ enabled: false });
      setStatus(
        error.message || 'This page cannot be captured',
        'error',
        'Open a normal http:// or https:// page, then try again.'
      );
    }
  }

  await refreshPopupState();

  async function captureAndDeliver(destination) {
    screenshotButton.disabled = true;
    copyButton.disabled = true;

    try {
      if (destination === 'save') {
        setStatus('Preparing capture...');
        const artifactRecord = await createCaptureArtifact('save');
        setStatus('Artifact saved.', 'success', artifactRecord.filename);
        await refreshPopupState({ preserveStatus: true });
        return;
      }

      setStatus('Copying artifact...');

      // Capture in the page, then write from this extension page so clipboardWrite
      // and the click gesture apply. Host-page clipboard rules no longer matter.
      // Start write during the click; rebuild a real PNG Blob from base64 after
      // capture. Do not pass messaging ArrayBuffers into ClipboardItem.
      const blobPromise = createCaptureArtifact('copy').then((record) => (
        pngBase64ToBlob(record.clipboardPngBase64)
      ));

      await copyPngBlobPromiseToClipboard(blobPromise);

      setStatus('Artifact copied.', 'success', 'Paste it into your review thread.');
      await refreshPopupState({ preserveStatus: true });
    } catch (error) {
      console.error(error);
      const boundaryDetail = getBoundaryDetail(error.message || '');
      const clipboardDetail = destination === 'copy' && !boundaryDetail
        ? getClipboardErrorDetail(error)
        : '';
      setStatus(
        error.message || (destination === 'copy' ? 'Copy failed' : 'Capture failed'),
        'error',
        boundaryDetail
          || clipboardDetail
          || 'No artifact was created. Try again or choose another page.'
      );
      setSourceActions({
        enabled: !boundaryDetail,
        copyAvailable: canCopyArtifact(),
      });
    }
  }

  screenshotButton.addEventListener('click', async () => {
    await captureAndDeliver('save');
  });

  copyButton.addEventListener('click', async () => {
    await captureAndDeliver('copy');
  });
});
