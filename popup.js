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
    };
  }

  async function createCaptureArtifact(destination) {
    const tab = await getActiveTab();
    updateTabSummary(tab);
    validateTab(tab);
    await injectContentScript(tab.id);
    const filename = destination === 'save' ? getCaptureFilename() : undefined;
    const { artifact, diagnostics } = await requestLongformCapture(tab.id, {
      delivery: destination === 'save' ? 'download' : 'clipboard',
      filename,
    });

    return { artifact, diagnostics, filename, tab };
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
      setStatus(destination === 'save' ? 'Preparing capture...' : 'Copying artifact...');
      const artifactRecord = await createCaptureArtifact(destination);

      if (destination === 'save') {
        setStatus('Artifact saved.', 'success', artifactRecord.filename);
        await refreshPopupState({ preserveStatus: true });
        return;
      }

      setStatus('Artifact copied.', 'success', 'Paste it into your review thread.');
      await refreshPopupState({ preserveStatus: true });
    } catch (error) {
      console.error(error);
      const boundaryDetail = getBoundaryDetail(error.message || '');
      setStatus(
        error.message || 'Capture failed',
        'error',
        boundaryDetail || 'No artifact was created. Try again or choose another page.'
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
