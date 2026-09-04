(() => {
  const CONTENT_SCRIPT_VERSION = '2026-09-04-clipboard-popup-v1';

  // Prevent duplicate listeners for the same script version while allowing upgrades.
  if (window.__longformContentScriptVersion === CONTENT_SCRIPT_VERSION) {
    return;
  }

  window.__longformContentScriptVersion = CONTENT_SCRIPT_VERSION;

  const CAPTURE_MESSAGE_TYPE = 'captureViewport';
  const FULL_PAGE_MESSAGE_TYPE = 'captureFullPage:v4';
  const CAPTURE_DELAY_MS = 600;
  const CAPTURE_OVERLAP_CSS_PX = 160;
  const MAX_CANVAS_DIMENSION = 32767;
  const MAX_CANVAS_AREA = 268435456;
  const PARTIAL_CAPTURE_TOLERANCE_CSS_PX = 2;

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitForPaint = () => new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(resolve);
    });
  });

  function getRenderedDocumentBounds() {
    let width = 0;
    let height = 0;

    for (const element of document.querySelectorAll('body, body *')) {
      const style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') {
        continue;
      }

      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        continue;
      }

      const marginRight = Number.parseFloat(style.marginRight) || 0;
      const marginBottom = Number.parseFloat(style.marginBottom) || 0;

      width = Math.max(width, rect.right + window.scrollX + marginRight);
      height = Math.max(height, rect.bottom + window.scrollY + marginBottom);
    }

    return { width: Math.ceil(width), height: Math.ceil(height) };
  }

  function forceInstantScroll() {
    const targets = [document.documentElement, document.body].filter(Boolean);
    const previousValues = targets.map((element) => ({
      element,
      scrollBehavior: element.style.scrollBehavior,
    }));

    for (const element of targets) {
      element.style.scrollBehavior = 'auto';
    }

    return () => {
      for (const { element, scrollBehavior } of previousValues) {
        element.style.scrollBehavior = scrollBehavior;
      }
    };
  }

  async function probeScrollLimits() {
    const originalScrollX = window.scrollX;
    const originalScrollY = window.scrollY;
    const restoreScrollBehavior = forceInstantScroll();

    try {
      window.scrollTo(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
      await waitForPaint();
      await delay(50);

      const maxScrollX = window.scrollX;
      const maxScrollY = window.scrollY;

      window.scrollTo(originalScrollX, originalScrollY);
      await waitForPaint();

      return {
        maxScrollX,
        maxScrollY,
        scrollExtentWidth: Math.ceil(maxScrollX + window.innerWidth),
        scrollExtentHeight: Math.ceil(maxScrollY + window.innerHeight),
      };
    } finally {
      restoreScrollBehavior();
    }
  }

  // Measure the full document and the current viewport.
  async function getPageMetrics() {
    const { body, documentElement } = document;
    const scrollLimits = await probeScrollLimits();
    const renderedBounds = getRenderedDocumentBounds();
    const documentMetrics = {
      bodyScrollWidth: body?.scrollWidth || 0,
      bodyOffsetWidth: body?.offsetWidth || 0,
      documentScrollWidth: documentElement.scrollWidth,
      documentOffsetWidth: documentElement.offsetWidth,
      documentClientWidth: documentElement.clientWidth,
      bodyScrollHeight: body?.scrollHeight || 0,
      bodyOffsetHeight: body?.offsetHeight || 0,
      documentScrollHeight: documentElement.scrollHeight,
      documentOffsetHeight: documentElement.offsetHeight,
      documentClientHeight: documentElement.clientHeight,
    };
    const scrollableDocumentWidth = Math.max(
      documentMetrics.bodyScrollWidth,
      documentMetrics.bodyOffsetWidth,
      documentMetrics.documentScrollWidth,
      documentMetrics.documentOffsetWidth,
      documentMetrics.documentClientWidth,
      scrollLimits.scrollExtentWidth
    );
    const pageWidth = Math.max(
      scrollableDocumentWidth,
      scrollLimits.maxScrollX > PARTIAL_CAPTURE_TOLERANCE_CSS_PX
        ? renderedBounds.width
        : 0
    );
    const pageHeight = Math.max(
      documentMetrics.bodyScrollHeight,
      documentMetrics.bodyOffsetHeight,
      documentMetrics.documentScrollHeight,
      documentMetrics.documentOffsetHeight,
      documentMetrics.documentClientHeight,
      renderedBounds.height,
      scrollLimits.scrollExtentHeight
    );

    return {
      pageWidth,
      pageHeight,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      pixelRatio: window.devicePixelRatio || 1,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      documentMetrics,
      renderedBounds,
      scrollLimits,
    };
  }

  // Build scroll offsets so the last capture lands exactly on the page edge.
  function getCapturePositions(fullSize, viewportSize, actualMaxScroll = 0) {
    if (viewportSize >= fullSize) {
      return Array.from(new Set([0, Math.max(0, Math.round(actualMaxScroll))]))
        .sort((left, right) => left - right);
    }

    const positions = [];
    const maxScroll = fullSize - viewportSize;
    const step = Math.max(1, viewportSize - CAPTURE_OVERLAP_CSS_PX);

    for (let current = 0; current < maxScroll; current += step) {
      positions.push(current);
    }

    if (positions[positions.length - 1] !== maxScroll) {
      positions.push(maxScroll);
    }

    positions.push(actualMaxScroll);
    return Array.from(new Set(
      positions
        .map((position) => Math.max(0, Math.round(position)))
        .sort((left, right) => left - right)
    ));
  }

  // Hide fixed/sticky UI so headers and floating widgets are not duplicated.
  function hideStickyElements() {
    const hiddenElements = [];

    for (const element of document.querySelectorAll('*')) {
      const position = window.getComputedStyle(element).position;
      if (position !== 'fixed' && position !== 'sticky') {
        continue;
      }

      hiddenElements.push({
        element,
        visibility: element.style.visibility,
      });
      element.style.visibility = 'hidden';
    }

    return () => {
      for (const { element, visibility } of hiddenElements) {
        if (element?.style) {
          element.style.visibility = visibility;
        }
      }
    };
  }

  function hideScrollbars() {
    const style = document.createElement('style');
    style.textContent = `
      html::-webkit-scrollbar,
      body::-webkit-scrollbar {
        display: none !important;
      }
    `;

    (document.head || document.documentElement).append(style);

    return () => {
      style.remove();
    };
  }

  // Ask the background worker for a screenshot of the visible viewport.
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

  function getCanvasSize(metrics) {
    const width = Math.round(metrics.pageWidth * metrics.pixelRatio);
    const height = Math.round(metrics.pageHeight * metrics.pixelRatio);

    if (width <= 0 || height <= 0) {
      throw new Error('This page does not have a captureable area');
    }

    if (
      width > MAX_CANVAS_DIMENSION ||
      height > MAX_CANVAS_DIMENSION ||
      width * height > MAX_CANVAS_AREA
    ) {
      throw new Error(
        'This page is too large to capture as a single PNG in Chromium'
      );
    }

    return { width, height };
  }

  function getPageBackgroundColor() {
    const { body, documentElement } = document;
    const candidates = [body, documentElement].filter(Boolean);

    for (const element of candidates) {
      const color = window.getComputedStyle(element).backgroundColor;
      if (color && color !== 'transparent' && !/rgba?\(0,\s*0,\s*0,\s*0\)/i.test(color)) {
        return color;
      }
    }

    return '#ffffff';
  }

  // Draw one viewport capture into the correct canvas position.
  function drawCapture(context, bitmap, metrics, scrollX, scrollY) {
    const sourceCssX = 0;
    const sourceCssY = 0;
    const captureCssWidth = Math.min(
      metrics.viewportWidth,
      metrics.pageWidth - scrollX
    );
    const captureCssHeight = Math.min(
      metrics.viewportHeight,
      metrics.pageHeight - scrollY
    );

    if (captureCssWidth <= 0 || captureCssHeight <= 0) {
      return;
    }

    const sourceX = Math.floor(sourceCssX * metrics.pixelRatio);
    const sourceY = Math.floor(sourceCssY * metrics.pixelRatio);
    const destinationX = Math.floor(scrollX * metrics.pixelRatio);
    const destinationY = Math.floor(scrollY * metrics.pixelRatio);
    const destinationRight = Math.min(
      Math.ceil((scrollX + captureCssWidth) * metrics.pixelRatio) + 1,
      context.canvas.width
    );
    const destinationBottom = Math.min(
      Math.ceil((scrollY + captureCssHeight) * metrics.pixelRatio) + 1,
      context.canvas.height
    );
    const captureWidth = Math.min(
      destinationRight - destinationX,
      bitmap.width - sourceX
    );
    const captureHeight = Math.min(
      destinationBottom - destinationY,
      bitmap.height - sourceY
    );

    if (captureWidth <= 0 || captureHeight <= 0) {
      return;
    }

    context.drawImage(
      bitmap,
      sourceX,
      sourceY,
      captureWidth,
      captureHeight,
      destinationX,
      destinationY,
      captureWidth,
      captureHeight
    );
  }

  // Scroll across the page, capture each tile, and stitch everything into one PNG.
  async function captureFullPage(options = {}) {
    const metrics = await getPageMetrics();
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

    context.fillStyle = getPageBackgroundColor();
    context.fillRect(0, 0, canvas.width, canvas.height);

    const scrollingElement = document.scrollingElement || document.documentElement;
    const previousScrollBehavior = scrollingElement.style.scrollBehavior;
    const restoreStickyElements = hideStickyElements();
    const restoreScrollbars = hideScrollbars();
    const capturedPositions = new Set();

    scrollingElement.style.scrollBehavior = 'auto';

    try {
      // Capture row by row to keep the flow simple and predictable.
      for (const y of yPositions) {
        for (const x of xPositions) {
          window.scrollTo(x, y);
          await waitForPaint();
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

      // Return PNG bytes to the popup. Clipboard write must happen in the
      // extension page (clipboardWrite + user-gesture ClipboardItem), not here.
      if (options.delivery === 'clipboard') {
        const clipboardBuffer = await blob.arrayBuffer();

        return {
          artifact,
          diagnostics,
          clipboardBuffer,
          clipboardType: blob.type || 'image/png',
        };
      }

      if (options.delivery === 'download') {
        triggerBlobDownload(blob, options.filename);

        return { artifact, diagnostics };
      }

      return { artifact, diagnostics };
    } finally {
      // Always restore page state, even if capture fails partway through.
      restoreScrollbars();
      restoreStickyElements();
      scrollingElement.style.scrollBehavior = previousScrollBehavior;
      window.scrollTo(metrics.scrollX, metrics.scrollY);
    }
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request?.type !== FULL_PAGE_MESSAGE_TYPE) {
      return false;
    }

    captureFullPage({
      delivery: request?.delivery,
      filename: request?.filename,
    })
      .then(({ artifact, diagnostics, clipboardBuffer, clipboardType }) => sendResponse({
        success: true,
        artifact,
        diagnostics,
        clipboardBuffer,
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
