(() => {
  if (Longform.page) return;
  const sampleDelayMs = 150;
  const stableSamplesRequired = 2;
  const operationTimeoutMs = 10000;
  // Transaction ownership stays private; no page attributes or global markers.
  const transactions = new WeakMap();
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitForPaint = () => new Promise((resolve) => {
    // Hidden documents may stop producing frames. The timer also bounds the
    // preparation path; cleanup itself never waits for paint.
    const timeout = setTimeout(resolve, 100);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      clearTimeout(timeout);
      resolve();
    }));
  });

  function getPageMetrics() {
    const { body, documentElement } = document;
    const root = document.scrollingElement || documentElement;
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
    // The root scroll surface already accounts for clipping and overflow. A
    // descendant rectangle maximum incorrectly includes clipped/hidden content.
    const pageWidth = Math.max(root.scrollWidth, root.clientWidth, window.innerWidth);
    const pageHeight = Math.max(root.scrollHeight, root.clientHeight, window.innerHeight);
    const renderedBounds = { width: pageWidth, height: pageHeight };
    const scrollLimits = {
      maxScrollX: Math.max(0, pageWidth - window.innerWidth),
      maxScrollY: Math.max(0, pageHeight - window.innerHeight),
      scrollExtentWidth: pageWidth, scrollExtentHeight: pageHeight,
    };

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

  const codedError = (code) => Object.assign(new Error(code), { code });

  /**
   * @typedef {{pageWidth: number, pageHeight: number, viewportWidth: number,
   *   viewportHeight: number, pixelRatio: number, scrollX: number, scrollY: number,
   *   documentMetrics: object, renderedBounds: object, scrollLimits: object}} Metrics
   * @typedef {Metrics & {generation: number, visibleResourcesReady: boolean,
   *   resourceCount: number}} LayoutSample
   * @typedef {{measure(): Metrics, sample(): LayoutSample,
   *   settleVisible(): Promise<LayoutSample>, dispose(): void}} PageObserver
   * @returns {PageObserver}
   *
   * Observe one finite root document after preparation. Samples retain all
   * Metrics fields, plus generation, visibleResourcesReady and resourceCount.
   * Canvas/video pixels and closed shadow/iframe interiors cannot be observed
   * atomically; this observer makes no atomic-snapshot guarantee for them.
   */
  function observeLayout(transaction, ctx) {
    const owner = transactions.get(transaction);
    if (!owner) throw codedError('invalid-transaction');
    let disposed = false;
    let generation = 0;
    let previousGeometry;
    const images = new WeakMap();
    const backgrounds = new Map();
    const checkpoint = (attempt = ctx.attempt) => {
      if (disposed) throw codedError('observer-disposed');
      owner.checkpoint(attempt);
      ctx.checkpoint(attempt);
    };
    const changed = (records) => { if (!disposed && records.length) generation++; };
    const mutations = new MutationObserver(changed);
    mutations.observe(document.documentElement, {
      subtree: true, childList: true, characterData: true, attributes: true,
    });
    // Process queued page edits before owned writes; after the write, discard
    // only its exact target/attribute or exact owned-node insertion/removal.
    const drain = (owned) => {
      const records = mutations.takeRecords();
      const matches = owned ? records.filter(owned) : [];
      // More than one matching record means page code may have touched the
      // same attribute synchronously. Conservatively retain that generation.
      changed(matches.length === 1 ? records.filter((record) => record !== matches[0]) : records);
    };
    owner.subscribers.add(drain);
    const onResource = (event) => {
      const image = event.target;
      if (disposed || image?.tagName !== 'IMG') return;
      // A new request may complete between samples with the same source URL.
      // Forget its old decode even when it is currently outside the viewport.
      images.delete(image);
      try {
        if (visible(image, window.getComputedStyle(image), getPageMetrics())) generation++;
      } catch {
        // Sampling reports unreadable visible resources with its safe code.
      }
    };
    document.addEventListener('load', onResource, true);
    document.addEventListener('error', onResource, true);

    function measure() {
      checkpoint();
      return getPageMetrics();
    }

    function visible(element, style, metrics) {
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
      const rect = element.getBoundingClientRect();
      let left = Math.max(0, rect.left), top = Math.max(0, rect.top);
      let right = Math.min(metrics.viewportWidth, rect.right), bottom = Math.min(metrics.viewportHeight, rect.bottom);
      if (rect.width <= 0 || rect.height <= 0 || right <= left || bottom <= top) return false;
      for (let parent = element.parentElement; parent && parent !== document.documentElement; parent = parent.parentElement) {
        const parentStyle = window.getComputedStyle(parent);
        if (parentStyle.display === 'none' || parentStyle.visibility === 'hidden') return false;
        const clips = (value) => /^(hidden|clip|scroll|auto)$/.test(value);
        const box = parent.getBoundingClientRect();
        if (clips(parentStyle.overflowX || parentStyle.overflow)) {
          left = Math.max(left, box.left); right = Math.min(right, box.right);
        }
        if (clips(parentStyle.overflowY || parentStyle.overflow)) {
          top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom);
        }
        if (right <= left || bottom <= top) return false;
      }
      return true;
    }

    function resource(image, source, cache, key) {
      let record = cache.get(key);
      const complete = image.complete;
      if (!record || record.source !== source || record.attempt !== ctx.attempt
        || (!complete && (record.status !== 'pending' || record.decoding))) {
        record = { image, source, status: 'pending', decoding: false, attempt: ctx.attempt };
        cache.set(key, record);
      }
      // Read current browser readiness before trusting any cached decode. A
      // same-URL reload can reset completion without changing source/attempt.
      if (!complete) return false;
      if (!(image.naturalWidth > 0)) record.status = 'failed';
      if (record.status === 'pending') {
        if (!record.decoding) {
          record.decoding = true;
          if (typeof image.decode !== 'function') record.status = 'ready';
          else {
            const currentRequest = () => !disposed && !ctx.signal.aborted
              && ctx.attempt === record.attempt && cache.get(key) === record
              && image.complete && image.naturalWidth > 0
              && (image.currentSrc || image.src) === source;
            Promise.resolve().then(() => {
              checkpoint(record.attempt);
              if (!currentRequest()) throw codedError('resource-stale');
              return image.decode();
            }).then(() => {
              if (currentRequest()) record.status = 'ready';
            }, () => {
              if (currentRequest()) record.status = 'failed';
            });
          }
        }
      }
      if (record.status === 'failed') throw codedError('resource-failed');
      return record.status === 'ready';
    }

    function resources(metrics) {
      let ready = true;
      let count = 0;
      try {
        for (const element of document.querySelectorAll('*')) {
          const style = window.getComputedStyle(element);
          if (!visible(element, style, metrics)) continue;
          if (element.tagName === 'IMG') {
            count++;
            ready = resource(element, element.currentSrc || element.src, images, element) && ready;
          }
          const background = style.backgroundImage || '';
          const urls = background.matchAll(/url\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^)]*))\s*\)/g);
          for (const match of urls) {
            const url = (match[1] ?? match[2] ?? match[3]).trim();
            if (!url) continue;
            let record = backgrounds.get(url);
            if (!record) {
              const image = new Image();
              image.src = url;
              record = { image, source: url, status: 'pending', decoding: false, attempt: ctx.attempt };
              backgrounds.set(url, record);
            }
            count++;
            ready = resource(record.image, url, backgrounds, url) && ready;
          }
        }
      } catch (error) {
        if (error?.code === 'resource-failed') throw error;
        throw codedError('resource-unreadable');
      }
      return { visibleResourcesReady: ready, resourceCount: count };
    }

    function sample() {
      checkpoint();
      drain();
      const metrics = measure();
      const geometry = JSON.stringify([metrics.pageWidth, metrics.pageHeight, metrics.viewportWidth,
        metrics.viewportHeight, metrics.pixelRatio]);
      if (previousGeometry !== undefined && geometry !== previousGeometry) generation++;
      previousGeometry = geometry;
      return Object.freeze({ ...metrics, ...resources(metrics), generation });
    }

    async function settleVisible() {
      const attempt = ctx.attempt;
      checkpoint(attempt);
      const deadline = Date.now() + operationTimeoutMs;
      let previous;
      let stable = 0;
      for (;;) {
        checkpoint(attempt);
        const current = sample();
        const signature = JSON.stringify([current.pageWidth, current.pageHeight, current.viewportWidth,
          current.viewportHeight, current.pixelRatio, current.scrollX, current.scrollY,
          current.generation, current.visibleResourcesReady, current.resourceCount]);
        stable = current.visibleResourcesReady ? (signature === previous ? stable + 1 : 1) : 0;
        if (stable >= stableSamplesRequired) return current;
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw codedError(current.visibleResourcesReady ? 'layout-unstable' : 'resource-timeout');
        previous = signature;
        await ctx.external(() => delay(Math.min(sampleDelayMs, remaining)), 'resource-timeout');
      }
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      mutations.disconnect();
      owner.subscribers.delete(drain);
      document.removeEventListener('load', onResource, true);
      document.removeEventListener('error', onResource, true);
      backgrounds.clear();
    }
    return Object.freeze({ measure, sample, settleVisible, dispose });
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
    const journal = [];
    const properties = new WeakMap();
    const subscribers = new Set();
    let prepared = false;
    let closed = false;
    let result;

    function checkpoint(attempt = ctx.attempt) {
      if (closed) throw Object.assign(new Error('Page transaction restored'), { code: 'page-restored' });
      ctx.checkpoint(attempt);
    }

    function ownedMutation(operation, matches) {
      for (const subscriber of subscribers) subscriber();
      try { return operation(); }
      finally { for (const subscriber of subscribers) subscriber(matches); }
    }

    const styleMutation = (element, operation) => ownedMutation(operation,
      (record) => record.type === 'attributes' && record.target === element && record.attributeName === 'style');
    const nodeMutation = (node, operation) => ownedMutation(operation,
      (record) => record.type === 'childList'
        && [...record.addedNodes, ...record.removedNodes].length === 1
        && [...record.addedNodes, ...record.removedNodes][0] === node);

    function installProperty(element, property, value, policy = false) {
      checkpoint();
      if (properties.get(element)?.has(property)) return;
      const { style } = element;
      const previous = {
        present: Array.from({ length: style.length }, (_, index) => style.item(index)).includes(property),
        value: style.getPropertyValue(property),
        priority: style.getPropertyPriority(property),
      };
      styleMutation(element, () => style.setProperty(property, value, 'important'));
      // Journal immediately after each successful mutation, before any further
      // page access can throw or cause reentrant cancellation.
      const entry = { element, style, property, previous, policy, value, priority: 'important' };
      journal.push(entry);
      if (!properties.has(element)) properties.set(element, new Set());
      properties.get(element).add(property);
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
            nodeMutation(entry.node, () => entry.node.remove());
          } else if (entry.style.getPropertyValue(entry.property) !== entry.value
            || entry.style.getPropertyPriority(entry.property) !== entry.priority) {
            record(conflicts, entry.property);
          } else if (entry.previous.present) {
            styleMutation(entry.element, () => entry.style.setProperty(entry.property, entry.previous.value, entry.previous.priority));
          } else {
            styleMutation(entry.element, () => entry.style.removeProperty(entry.property));
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

    const transaction = Object.freeze({
      async prepare() {
        const attempt = ctx.attempt;
        checkpoint(attempt);
        if (!prepared) {
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
          nodeMutation(style, () => (document.head || document.documentElement).append(style));
          journal.push({ node: style });
        }
        for (const element of document.querySelectorAll('*')) {
          checkpoint();
          const position = window.getComputedStyle(element).position;
          if (position === 'fixed' || position === 'sticky') installProperty(element, 'visibility', 'hidden');
        }
        await waitForPaint();
        checkpoint(attempt);
      },
      async scrollTo(x, y) {
        const attempt = ctx.attempt;
        checkpoint(attempt);
        window.scrollTo({ left: x, top: y, behavior: 'instant' });
        await waitForPaint();
        checkpoint(attempt);
      },
      async restore() { return restoreSync(); },
      restoreSync,
    });
    transactions.set(transaction, { checkpoint, subscribers });
    return transaction;
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

  Longform.page = Object.freeze({
    measure: getPageMetrics,
    backgroundColor: getPageBackgroundColor,
    beginTransaction,
    observeLayout,
    sampleDelayMs,
    stableSamplesRequired,
  });
})();
