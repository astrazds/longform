document.addEventListener('DOMContentLoaded', async () => {
  const screenshotButton = document.getElementById('screenshotBtn');
  const copyButton = document.getElementById('copyBtn');
  const statusElement = document.getElementById('status');
  const FULL_PAGE_MESSAGE_TYPE = Longform.protocol.fullPageMessage;
  const { canCopyArtifact, pngBase64ToBlob, copyPngBlobPromiseToClipboard } = Longform.clipboard;
  const SUPPORTED_TAB_PROTOCOL = /^https?:/i;
  const PHASE_VIEW = Object.freeze({
    ready: { message: '', tone: '' },
    saving: { message: 'Saving...', tone: '' },
    copying: { message: 'Copying...', tone: '' },
    saved: { message: 'Saved.', tone: 'success' },
    copied: { message: 'Copied.', tone: 'success' },
    blocked: { message: '', tone: 'error' },
    error: { message: '', tone: 'error' },
  });
  let uiState = {
    phase: 'blocked',
    copyAvailable: canCopyArtifact(),
    message: '',
  };

  const renderUi = () => {
    const view = PHASE_VIEW[uiState.phase];
    const busy = uiState.phase === 'saving' || uiState.phase === 'copying';
    const blocked = uiState.phase === 'blocked';
    const copyUnavailableMessage = uiState.phase === 'ready' && !uiState.copyAvailable
      ? 'Copy is unavailable in this browser. You can still save the screenshot.'
      : '';
    const message = uiState.message || view.message || copyUnavailableMessage;

    screenshotButton.textContent = 'Save';
    copyButton.textContent = 'Copy';
    screenshotButton.disabled = busy || blocked;
    copyButton.disabled = busy || blocked || !uiState.copyAvailable;
    statusElement.textContent = message;
    statusElement.className = `status${view.tone ? ` ${view.tone}` : ''}`;
  };

  const transitionTo = (phase, message = '') => {
    uiState = {
      phase,
      copyAvailable: canCopyArtifact(),
      message,
    };
    renderUi();
  };

  const getBoundaryMessage = (message) => {
    if (/too large/i.test(message)) {
      return 'This page is too large for one PNG. Try another page.';
    }

    if (/fully scrolled/i.test(message)) {
      return 'This page could not be captured completely. Try another page.';
    }

    if (/cannot be captured|no active tab/i.test(message)) {
      return 'Open a regular web page, then try again.';
    }

    return '';
  };

  const getClipboardErrorMessage = (error) => {
    const message = error?.message || '';

    if (/not supported/i.test(message)) {
      return 'Copy is unavailable in this browser. Save the screenshot instead.';
    }

    if (/notallowed|permission|denied|document is not focused|clipboarditem presentation/i.test(message)) {
      return 'Clipboard access was blocked. Try again, or save the screenshot.';
    }

    if (/message length|QuotaExceeded|too large to copy|Array buffer/i.test(message)) {
      return 'This PNG is too large to copy. Save it instead.';
    }

    if (/did not return image data|invalid png|empty png/i.test(message)) {
      return 'The screenshot could not be copied. Save it instead.';
    }

    if (/decode|ClipboardItemData|clipboard item/i.test(message)) {
      return 'The screenshot could not be copied. Try again, or save it instead.';
    }

    return 'Could not copy this page. Try again, or save the screenshot.';
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

  function getCaptureFilename() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    return `longform-capture-${timestamp}.png`;
  }

  async function createCaptureArtifact(destination) {
    const tab = await getActiveTab();
    validateTab(tab);
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: Longform.protocol.contentFiles,
    });
    const filename = destination === 'save' ? getCaptureFilename() : undefined;
    const response = await chrome.tabs.sendMessage(tab.id, {
      delivery: destination === 'save' ? 'download' : 'clipboard',
      filename,
      type: FULL_PAGE_MESSAGE_TYPE,
    });

    if (!response?.success) {
      const error = new Error(response?.error || 'Capture failed');
      error.captureDiagnostics = response?.diagnostics;
      throw error;
    }

    return { filename, clipboardPngBase64: response.clipboardPngBase64 };
  }

  async function refreshPopupState() {
    try {
      const tab = await getActiveTab();
      validateTab(tab);
      transitionTo('ready');
    } catch (error) {
      console.error(error);
      transitionTo('blocked', 'Open a regular web page, then try again.');
    }
  }

  await refreshPopupState();

  async function captureAndDeliver(destination) {
    transitionTo(destination === 'save' ? 'saving' : 'copying');
    let copyBlobPromise;

    try {
      if (destination === 'save') {
        await createCaptureArtifact('save');
        transitionTo('saved');
        return;
      }

      copyBlobPromise = createCaptureArtifact('copy').then((record) => (
        pngBase64ToBlob(record.clipboardPngBase64)
      ));

      await copyPngBlobPromiseToClipboard(copyBlobPromise);
      transitionTo('copied');
    } catch (error) {
      console.error(error);
      let captureError;

      if (copyBlobPromise) {
        try {
          await copyBlobPromise;
        } catch (pendingCaptureError) {
          captureError = pendingCaptureError;
        }
      }

      const boundaryMessage = getBoundaryMessage(
        (captureError || (destination === 'save' ? error : undefined))?.message || ''
      );

      if (boundaryMessage) {
        transitionTo('blocked', boundaryMessage);
        return;
      }

      const message = destination === 'copy'
        ? getClipboardErrorMessage(error)
        : 'Could not save this page. Try again or choose another page.';
      transitionTo('error', message);
    }
  }

  screenshotButton.addEventListener('click', () => {
    captureAndDeliver('save');
  });

  copyButton.addEventListener('click', () => {
    captureAndDeliver('copy');
  });
});
