(() => {
  const PARTIAL_CAPTURE_TOLERANCE_CSS_PX = Longform.geometry.partialCaptureTolerance;
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitForPaint = () => new Promise((resolve) => {
    // Hidden documents may stop producing frames. The timer also bounds the
    // legacy measurement path; cleanup itself never waits for paint.
    const timeout = setTimeout(resolve, 100);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      clearTimeout(timeout);
      resolve();
    }));
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

  /**
   * @typedef {{ok: boolean, conflicts: readonly string[], failures: readonly string[]}} CleanupResult
   * @param {object} ctx Session context; cleanup deliberately never checkpoints.
   * @returns {{prepare(): Promise<void>, scrollTo(x: number, y: number): Promise<void>,
   *   restore(): Promise<CleanupResult>, restoreSync(): CleanupResult}}
   */
  function beginTransaction(ctx) {
    return createTransaction(ctx, { left: window.scrollX, top: window.scrollY });
  }

  function createTransaction(ctx, originalPosition) {
    const attempt = ctx.attempt;
    const journal = [];
    let prepared = false;
    let closed = false;
    let result;

    function checkpoint() {
      if (closed) throw Object.assign(new Error('Page transaction restored'), { code: 'page-restored' });
      ctx.checkpoint(attempt);
    }

    function installProperty(element, property, value, policy = false) {
      checkpoint();
      const { style } = element;
      const previous = {
        present: Array.from({ length: style.length }, (_, index) => style.item(index)).includes(property),
        value: style.getPropertyValue(property),
        priority: style.getPropertyPriority(property),
      };
      style.setProperty(property, value, 'important');
      // Journal immediately after each successful mutation, before any further
      // page access can throw or cause reentrant cancellation.
      const entry = { style, property, previous, policy, value, priority: 'important' };
      journal.push(entry);
      entry.value = style.getPropertyValue(property);
      entry.priority = style.getPropertyPriority(property);
    }

    function restoreSync() {
      if (closed) return result;
      // Fence all pending callbacks before the first inverse action, including
      // pagehide/BFCache where neither promises nor animation frames may run.
      closed = true;
      const conflicts = [];
      const failures = [];
      const record = (list, identifier) => { if (!list.includes(identifier)) list.push(identifier); };
      const inverse = (entry) => {
        try {
          if (entry.node) {
            entry.node.remove();
          } else if (entry.style.getPropertyValue(entry.property) !== entry.value
            || entry.style.getPropertyPriority(entry.property) !== entry.priority) {
            record(conflicts, entry.property);
          } else if (entry.previous.present) {
            entry.style.setProperty(entry.property, entry.previous.value, entry.previous.priority);
          } else {
            entry.style.removeProperty(entry.property);
          }
        } catch {
          record(failures, entry.property || 'owned-style');
        }
      };
      for (const entry of [...journal].reverse()) if (!entry.policy) inverse(entry);
      try {
        window.scrollTo({ ...originalPosition, behavior: 'instant' });
      } catch {
        record(failures, 'scroll-position');
      }
      // Coordinates are restored with smooth scrolling and snapping still
      // suppressed. Newer page-owned declarations survive the comparison.
      for (const entry of [...journal].reverse()) if (entry.policy) inverse(entry);
      try {
        window.removeEventListener('pagehide', restoreSync);
      } catch {
        record(failures, 'pagehide-listener');
      }
      result = Object.freeze({ ok: failures.length === 0,
        conflicts: Object.freeze(conflicts), failures: Object.freeze(failures) });
      return result;
    }

    window.addEventListener('pagehide', restoreSync);

    return Object.freeze({
      async prepare() {
        checkpoint();
        if (prepared) return;
        prepared = true;
        const targets = new Set([document.documentElement, document.body, document.scrollingElement].filter(Boolean));
        for (const element of targets) {
          installProperty(element, 'scroll-behavior', 'auto', true);
          installProperty(element, 'scroll-snap-type', 'none', true);
          installProperty(element, 'overflow-anchor', 'none', true);
        }
        const style = document.createElement('style');
        style.textContent = `
          html::-webkit-scrollbar, body::-webkit-scrollbar { display: none !important; }
          *, *::before, *::after {
            animation-play-state: paused !important;
            transition: none !important;
            caret-color: transparent !important;
          }
        `;
        checkpoint();
        (document.head || document.documentElement).append(style);
        journal.push({ node: style });
        for (const element of document.querySelectorAll('*')) {
          checkpoint();
          const position = window.getComputedStyle(element).position;
          if (position === 'fixed' || position === 'sticky') installProperty(element, 'visibility', 'hidden');
        }
        await waitForPaint();
        checkpoint();
      },
      async scrollTo(x, y) {
        checkpoint();
        window.scrollTo({ left: x, top: y, behavior: 'instant' });
        await waitForPaint();
        checkpoint();
      },
      async restore() { return restoreSync(); },
      restoreSync,
    });
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
    const transaction = createTransaction({ checkpoint() {} }, { left: metrics.scrollX, top: metrics.scrollY });
    try {
      await transaction.prepare();
      return await capture({ scrollTo: transaction.scrollTo });
    } finally {
      const cleanup = await transaction.restore();
      if (!cleanup.ok) throw Object.assign(new Error('Page restoration failed'), { code: 'cleanup-failed' });
    }
  }

  Longform.page = Object.freeze({
    measure: getPageMetrics,
    backgroundColor: getPageBackgroundColor,
    beginTransaction,
    withPreparedState,
  });
})();
