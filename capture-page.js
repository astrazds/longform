(() => {
  const PARTIAL_CAPTURE_TOLERANCE_CSS_PX = Longform.geometry.partialCaptureTolerance;
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitForPaint = () => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
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

  async function withPreparedState(metrics, capture) {
    const scrollingElement = document.scrollingElement || document.documentElement;
    const previousScrollBehavior = scrollingElement.style.scrollBehavior;
    const restoreStickyElements = hideStickyElements();
    const restoreScrollbars = hideScrollbars();
    scrollingElement.style.scrollBehavior = 'auto';

    try {
      return await capture({
        async scrollTo(x, y) {
          window.scrollTo(x, y);
          await waitForPaint();
        },
      });
    } finally {
      restoreScrollbars();
      restoreStickyElements();
      scrollingElement.style.scrollBehavior = previousScrollBehavior;
      window.scrollTo(metrics.scrollX, metrics.scrollY);
    }
  }

  Longform.page = Object.freeze({
    measure: getPageMetrics,
    backgroundColor: getPageBackgroundColor,
    withPreparedState,
  });
})();
