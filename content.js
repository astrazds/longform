(() => {
  if (Longform.captureListener) {
    chrome.runtime.onMessage.removeListener(Longform.captureListener);
  }

  Longform.captureListener = (request, sender, sendResponse) => {
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
  };
  chrome.runtime.onMessage.addListener(Longform.captureListener);
})();
