importScripts('protocol.js', 'capture-broker.js');
const CAPTURE_MESSAGE_TYPE = Longform.protocol.viewportMessage;
const broker = Longform.broker.create({ tabs: chrome.tabs, runtimeId: chrome.runtime.id });

chrome.tabs.onActivated.addListener(({ windowId }) => broker.invalidate({ windowId }));
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'loading' || change.url) broker.invalidate({ tabId });
});
chrome.tabs.onRemoved.addListener((tabId) => broker.invalidate({ tabId }));
chrome.tabs.onDetached.addListener((tabId) => broker.invalidate({ tabId }));

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!Longform.protocol.brokerMessages.includes(request?.type)) return false;
  Promise.resolve().then(() => request.type === 'BROKER_HELLO' ? broker.hello(sender)
    : request.type === 'CAPTURE_TILE' ? broker.capture(request, sender)
      : broker.digestMessage(request, sender))
    .then((reply) => sendResponse({ success: true, ...reply }))
    .catch((error) => sendResponse({ success: false, errorCode: error.code || 'capture-failed' }));
  return true;
});

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
