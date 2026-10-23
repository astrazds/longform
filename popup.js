document.addEventListener('DOMContentLoaded', async () => {
  const screenshotButton = document.getElementById('screenshotBtn');
  const copyButton = document.getElementById('copyBtn');
  const statusElement = document.getElementById('status');
  const heading = document.querySelector('h1');
  const FULL_PAGE_MESSAGE_TYPE = Longform.protocol.fullPageMessage;
  const { canCopyArtifact, phrases, copyDuringGesture } = Longform.clipboard;
  const SUPPORTED_TAB_PROTOCOL = /^https?:/i;
  const BOUNDARY_PHRASES = new Set(['page-too-large', 'incomplete', 'blocked']);
  let uiState = {
    phrase: 'blocked',
    copyAvailable: canCopyArtifact(),
  };

  const applyLabels = () => {
    heading.textContent = phrases.labels.heading;
    screenshotButton.textContent = phrases.labels.save;
    copyButton.textContent = phrases.labels.copy;
    screenshotButton.setAttribute('aria-label', phrases.labels.saveAria);
    copyButton.setAttribute('aria-label', phrases.labels.copyAria);
  };

  const renderUi = () => {
    const view = phrases[uiState.phrase];
    const busy = view.phase === 'saving' || view.phase === 'copying';
    const blocked = view.phase === 'blocked';
    const tone = view.phase === 'saved' || view.phase === 'copied'
      ? 'success'
      : view.phase === 'blocked' || view.phase === 'error'
        ? 'error'
        : '';
    const message = view.phase === 'ready' && !uiState.copyAvailable
      ? phrases.readyCopyUnavailable.text
      : view.text;

    applyLabels();
    screenshotButton.disabled = busy || blocked;
    copyButton.disabled = busy || blocked || !uiState.copyAvailable;
    statusElement.textContent = message;
    statusElement.className = `status${tone ? ` ${tone}` : ''}`;
  };

  const transitionTo = (phrase) => {
    uiState = {
      phrase,
      copyAvailable: canCopyArtifact(),
    };
    renderUi();
  };

  const saveFailurePhrase = (code) => (
    BOUNDARY_PHRASES.has(code) ? code : 'save-failed'
  );

  function throwCoded(code, message) {
    const error = new Error(message);
    error.code = code;
    throw error;
  }

  async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab?.id) {
      throwCoded('blocked', 'No active tab found');
    }

    return tab;
  }

  function validateTab(tab) {
    if (!SUPPORTED_TAB_PROTOCOL.test(tab.url || '')) {
      throwCoded('blocked', 'This page cannot be captured');
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
      error.code = response?.errorCode || 'failed';
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
      transitionTo('blocked');
    }
  }

  applyLabels();
  await refreshPopupState();

  async function captureAndDeliver(destination) {
    transitionTo(destination === 'save' ? 'saving' : 'copying');

    try {
      if (destination === 'save') {
        await createCaptureArtifact('save');
        transitionTo('saved');
        return;
      }

      const outcome = await copyDuringGesture(() => createCaptureArtifact('copy'));
      transitionTo(outcome.phrase === 'no-area' ? 'copy-failed' : outcome.phrase);
    } catch (error) {
      console.error(error);
      transitionTo(destination === 'copy' ? 'copy-failed' : saveFailurePhrase(error.code));
    }
  }

  screenshotButton.addEventListener('click', () => {
    captureAndDeliver('save');
  });

  copyButton.addEventListener('click', () => {
    captureAndDeliver('copy');
  });
});
