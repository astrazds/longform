(() => {
  if (window.__longformContentScriptVersion === Longform.protocol.contentVersion) {
    return;
  }
  window.__longformContentScriptVersion = Longform.protocol.contentVersion;

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request?.type !== Longform.protocol.fullPageMessage) {
      return false;
    }

    Longform.captureFullPage({
      delivery: request?.delivery,
      filename: request?.filename,
    })
      .then(({ artifact, diagnostics, clipboardPngBase64, clipboardType }) => sendResponse({
        success: true,
        artifact,
        diagnostics,
        clipboardPngBase64,
        clipboardType,
      }))
      .catch((error) => sendResponse({
        success: false,
        error: error.message,
        diagnostics: error.captureDiagnostics,
      }));

    return true;
  });
})();
