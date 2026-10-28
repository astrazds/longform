(() => {
  if (Longform.geometry) return;
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
      const error = new Error('This page does not have a captureable area');
      error.code = 'no-area';
      throw error;
    }

    if (
      width > MAX_CANVAS_DIMENSION ||
      height > MAX_CANVAS_DIMENSION ||
      width * height > MAX_CANVAS_AREA
    ) {
      const error = new Error(
        'This page is too large to capture as a single PNG in Chromium'
      );
      error.code = 'page-too-large';
      throw error;
    }

    return { width, height };
  }

  /** @typedef {{left:number, top:number, right:number, bottom:number}} Rect
   * Integer output-pixel, half-open bounds.
   */

  /** @returns {Rect|null} Exact clipped destination bounds, after a successful draw. */
  function drawCapture(context, bitmap, metrics, scrollX, scrollY) {
    function axis(scroll, viewport, page, sourceSize, canvasSize) {
      if (viewport <= 0 || sourceSize <= 0) return null;
      const start = Math.max(0, scroll);
      const end = Math.min(page, scroll + viewport);
      // Outward rounding shares each CSS boundary without an interior hole.
      const destinationStart = Math.max(0, Math.floor(start * metrics.pixelRatio));
      const destinationEnd = Math.min(canvasSize, Math.ceil(end * metrics.pixelRatio));
      // A bitmap represents the whole viewport. Its rounded physical dimensions
      // can differ from the destination span by one pixel at fractional scales.
      const sourceStart = Math.max(0, Math.floor((start - scroll) * sourceSize / viewport));
      const sourceEnd = Math.min(sourceSize, Math.ceil((end - scroll) * sourceSize / viewport));
      if (end <= start || destinationEnd <= destinationStart || sourceEnd <= sourceStart) return null;
      return { destinationStart, destinationEnd, sourceStart, sourceEnd };
    }

    const x = axis(scrollX, metrics.viewportWidth, metrics.pageWidth, bitmap.width, context.canvas.width);
    const y = axis(scrollY, metrics.viewportHeight, metrics.pageHeight, bitmap.height, context.canvas.height);
    if (!x || !y) return null;
    context.drawImage(
      bitmap,
      x.sourceStart,
      y.sourceStart,
      x.sourceEnd - x.sourceStart,
      y.sourceEnd - y.sourceStart,
      x.destinationStart,
      y.destinationStart,
      x.destinationEnd - x.destinationStart,
      y.destinationEnd - y.destinationStart
    );
    return {
      left: x.destinationStart, top: y.destinationStart,
      right: x.destinationEnd, bottom: y.destinationEnd,
    };
  }

  /** Accumulates integer Rects; diagnostics are bounded, area accounting is exact. */
  function createCoverage({ width, height }) {
    const rectangles = [];
    const MAX_GAPS = 64;
    function add(rect) {
      if (!rect) return;
      const clipped = {
        left: Math.max(0, rect.left), top: Math.max(0, rect.top),
        right: Math.min(width, rect.right), bottom: Math.min(height, rect.bottom),
      };
      if (clipped.right > clipped.left && clipped.bottom > clipped.top) rectangles.push(clipped);
    }
    function result() {
      const boundaries = [...new Set([0, height, ...rectangles.flatMap((r) => [r.top, r.bottom])])]
        .sort((a, b) => a - b);
      const gaps = [];
      let uncoveredArea = 0;
      for (let index = 1; index < boundaries.length; index += 1) {
        const top = boundaries[index - 1];
        const bottom = boundaries[index];
        const intervals = rectangles.filter((r) => r.top <= top && r.bottom >= bottom)
          .sort((a, b) => a.left - b.left);
        let right = 0;
        function gap(left, end) {
          uncoveredArea += (end - left) * (bottom - top);
          if (gaps.length < MAX_GAPS) gaps.push({ left, top, right: end, bottom });
        }
        for (const interval of intervals) {
          if (interval.left > right) gap(right, interval.left);
          right = Math.max(right, interval.right);
        }
        if (right < width) gap(right, width);
      }
      return { complete: uncoveredArea === 0, uncoveredArea, gaps };
    }
    return Object.freeze({ add, result });
  }

  Longform.geometry = Object.freeze({
    getCapturePositions,
    getCanvasSize,
    drawCapture,
    createCoverage,
  });
})();
