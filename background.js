importScripts('protocol.js', 'capture-broker.js');
const broker = Longform.broker.create({ tabs: chrome.tabs, runtimeId: chrome.runtime.id });

chrome.tabs.onActivated.addListener(({ windowId, tabId }) => {
  const notifications = broker.invalidate({ windowId, activeTabId: tabId });
  for (const target of notifications) {
    // IDs come exclusively from authenticated browser sender bindings.
    void chrome.tabs.sendMessage(target.tabId, target.message,
      { documentId: target.browserDocumentId, frameId: 0 }).catch(() => {});
  }
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'loading' || change.url) broker.invalidate({ tabId });
});
chrome.tabs.onRemoved.addListener((tabId) => broker.invalidate({ tabId }));
chrome.tabs.onDetached.addListener((tabId) => broker.invalidate({ tabId }));

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!Longform.protocol.brokerMessages.includes(request?.type)) return false;
  Promise.resolve().then(() => request.type === 'BROKER_HELLO' ? (request.sessionId ? broker.register(request, sender) : broker.hello(sender))
    : request.type === 'BROKER_RELEASE' ? broker.unregister(request, sender)
    : request.type === 'CAPTURE_TILE' ? broker.capture(request, sender)
      : broker.digestMessage(request, sender))
    .then((reply) => sendResponse({ success: true, ...reply }))
    .catch((error) => sendResponse({ success: false, errorCode: error.code || 'capture-failed' }));
  return true;
});
