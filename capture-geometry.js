(() => {
  const CAPTURE_OVERLAP_CSS_PX = 160;
  const MAX_CANVAS_DIMENSION = 32767;
  const MAX_CANVAS_AREA = 268435456;

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

  Longform.geometry = Object.freeze({
    getCapturePositions,
    getCanvasSize,
    drawCapture,
    partialCaptureTolerance: 2,
  });
})();
