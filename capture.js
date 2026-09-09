(() => {
  const { getCapturePositions, getCanvasSize, drawCapture } = Longform.geometry;
  const PARTIAL_CAPTURE_TOLERANCE_CSS_PX = Longform.geometry.partialCaptureTolerance;
  const CONTENT_SCRIPT_VERSION = Longform.protocol.contentVersion;
  const CAPTURE_MESSAGE_TYPE = Longform.protocol.viewportMessage;
  const CAPTURE_DELAY_MS = 600;
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function captureViewport() {
    const response = await chrome.runtime.sendMessage({
      type: CAPTURE_MESSAGE_TYPE,
    });

    if (!response?.success) {
      throw new Error(response?.error || 'Failed to capture viewport');
    }

    return response.data;
  }

  async function createBitmap(dataUrl) {
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    return createImageBitmap(blob);
  }

  function canvasToPngBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error('Could not encode the capture as PNG'));
          return;
        }

        resolve(blob);
      }, 'image/png');
    });
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    let binary = '';

    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const chunk = bytes.subarray(offset, offset + chunkSize);
      binary += String.fromCharCode.apply(null, chunk);
    }

    return btoa(binary);
  }

  function triggerBlobDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename || 'longform-capture.png';
    anchor.rel = 'noopener';
    anchor.style.display = 'none';

    (document.body || document.documentElement).append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 10 * 60 * 1000);
  }

  async function captureFullPage(options = {}) {
    const metrics = await Longform.page.measure();
    const xPositions = getCapturePositions(
      metrics.pageWidth,
      metrics.viewportWidth,
      metrics.scrollLimits.maxScrollX
    );
    const yPositions = getCapturePositions(
      metrics.pageHeight,
      metrics.viewportHeight,
      metrics.scrollLimits.maxScrollY
    );
    const canvasSize = getCanvasSize(metrics);
    const canvas = document.createElement('canvas');
    const diagnostics = {
      contentScriptVersion: CONTENT_SCRIPT_VERSION,
      metrics,
      canvas: canvasSize,
      requestedPositions: {
        xCount: xPositions.length,
        yCount: yPositions.length,
      },
      capturedPositions: [],
      skippedDuplicatePositions: 0,
      coverage: {
        right: 0,
        bottom: 0,
      },
    };

    canvas.width = canvasSize.width;
    canvas.height = canvasSize.height;

    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Canvas is not available on this page');
    }

    context.fillStyle = Longform.page.backgroundColor();
    context.fillRect(0, 0, canvas.width, canvas.height);

    return Longform.page.withPreparedState(metrics, async (page) => {
      const capturedPositions = new Set();
      for (const y of yPositions) {
        for (const x of xPositions) {
          await page.scrollTo(x, y);
          await delay(CAPTURE_DELAY_MS);

          const actualScrollX = window.scrollX;
          const actualScrollY = window.scrollY;
          const positionKey = `${Math.round(actualScrollX)}:${Math.round(actualScrollY)}`;
          if (capturedPositions.has(positionKey)) {
            diagnostics.skippedDuplicatePositions += 1;
            continue;
          }
          capturedPositions.add(positionKey);
          diagnostics.capturedPositions.push({
            x: Math.round(actualScrollX),
            y: Math.round(actualScrollY),
          });
          diagnostics.coverage.right = Math.max(
            diagnostics.coverage.right,
            Math.min(metrics.pageWidth, actualScrollX + metrics.viewportWidth)
          );
          diagnostics.coverage.bottom = Math.max(
            diagnostics.coverage.bottom,
            Math.min(metrics.pageHeight, actualScrollY + metrics.viewportHeight)
          );

          const bitmap = await createBitmap(await captureViewport());
          drawCapture(context, bitmap, metrics, actualScrollX, actualScrollY);
          bitmap.close();
        }
      }

      diagnostics.coverage.uncoveredRight = Math.max(
        0,
        Math.ceil(metrics.pageWidth - diagnostics.coverage.right)
      );
      diagnostics.coverage.uncoveredBottom = Math.max(
        0,
        Math.ceil(metrics.pageHeight - diagnostics.coverage.bottom)
      );

      if (
        diagnostics.coverage.uncoveredRight > PARTIAL_CAPTURE_TOLERANCE_CSS_PX ||
        diagnostics.coverage.uncoveredBottom > PARTIAL_CAPTURE_TOLERANCE_CSS_PX
      ) {
        const error = new Error(
          'This page could not be fully scrolled, so no complete PNG was created'
        );
        error.captureDiagnostics = diagnostics;
        throw error;
      }

      const blob = await canvasToPngBlob(canvas);
      const artifact = {
        byteSize: blob.size,
        delivery: options.delivery || 'capture',
        type: blob.type || 'image/png',
      };
      diagnostics.artifact = artifact;

      // Return PNG as base64 to the popup. Raw ArrayBuffer/Blob over
      // chrome.tabs messaging often arrives unusable; ClipboardItem then fails
      // to decode image/png. Base64 strings survive messaging reliably.
      if (options.delivery === 'clipboard') {
        const clipboardPngBase64 = arrayBufferToBase64(await blob.arrayBuffer());

        return {
          artifact,
          diagnostics,
          clipboardPngBase64,
          clipboardType: blob.type || 'image/png',
        };
      }

      if (options.delivery === 'download') {
        triggerBlobDownload(blob, options.filename);

        return { artifact, diagnostics };
      }

      return { artifact, diagnostics };
    });
  }

  Longform.captureFullPage = captureFullPage;
})();
