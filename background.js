// Service worker: captures the currently visible tab area on demand.
const CAPTURE_MESSAGE_TYPE = 'captureViewport';

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request?.type !== CAPTURE_MESSAGE_TYPE) {
    return false;
  }

  (async () => {
    if (Number.isInteger(sender.tab?.id)) {
      await chrome.tabs.update(sender.tab.id, { active: true });
    }

    const dataUrl = await chrome.tabs.captureVisibleTab(sender.tab?.windowId, {
      format: 'png',
    });
    sendResponse({ success: true, data: dataUrl });
  })().catch((error) => {
    sendResponse({
      success: false,
      error: error.message || 'Failed to prepare the target tab for capture',
    });
  });

  return true;
});
