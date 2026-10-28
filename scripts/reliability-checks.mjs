import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// This file is injected only into the disposable test bundle's isolated world.
// Faults are at platform/geometry boundaries; the real session, transaction,
// observer, capture, PNG encoder, broker and transfer modules still execute.
export const reliabilityWorldScript = `
(() => {
  const config = {}; const events = []; const draws = []; let coverageResult;
  let clockOffset = 0; let captureCalls = 0; let releaseTile; let tileHeld = false;
  let releaseDigest; let digestHeld = false; const ports = new Set();
  let releaseBitmap; let bitmapHeld = false;
  chrome.runtime.onConnect.addListener((port) => ports.add(port));
  const geometry = Longform.geometry;
  Longform.geometry = Object.freeze({ ...geometry,
    drawCapture(...args) { const rectangle = geometry.drawCapture(...args); draws.push(rectangle); return rectangle; },
    createCoverage(size) {
      const coverage = geometry.createCoverage(size);
      return { add(rect) {
        if (!config.gap || !rect || rect.right <= 780 || rect.left >= 820 || rect.bottom <= 750 || rect.top >= 850) return coverage.add(rect);
        // Subtract a strictly interior40x100 pixel rectangle from every real
        // draw receipt. All four outer edges remain covered in two dimensions.
        const top = Math.max(rect.top, 750), bottom = Math.min(rect.bottom, 850);
        coverage.add({ ...rect, bottom: top }); coverage.add({ ...rect, top: bottom });
        coverage.add({ ...rect, top, bottom, right: 780 });
        coverage.add({ ...rect, top, bottom, left: 820 });
      }, result() { coverageResult = coverage.result(); return coverageResult; } };
    },
  });
  const sendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
  chrome.runtime.sendMessage = async (...args) => {
    if (args[0]?.type === 'CAPTURE_TILE') {
      captureCalls++;
      if (config.holdSecondTile && captureCalls === 2) {
        tileHeld = true; await new Promise((resolve) => { releaseTile = resolve; });
      }
    }
    if (config.holdDigest && args[0]?.type === 'DIGEST_BEGIN') {
      digestHeld = true; await new Promise((resolve) => { releaseDigest = resolve; });
    }
    return sendMessage(...args);
  };
  const owner = Longform.sessions.install({ run: (ctx) => Longform.capture.run(ctx), now: () => Date.now() + clockOffset });
  const nativeScroll = window.scrollTo.bind(window);
  window.scrollTo = (...args) => {
    if (config.ineffectiveRestore && owner.snapshot().phase === 'restoring') return;
    return nativeScroll(...args);
  };
  const nativeBitmap = globalThis.createImageBitmap.bind(globalThis);
  const nativeToBlob = HTMLCanvasElement.prototype.toBlob, canvases = [], encodings = [], bitmapClosures = [];
  const nativeBitmapClose = ImageBitmap.prototype.close;
  ImageBitmap.prototype.close = function(...args) {
    const result = nativeBitmapClose.apply(this, args);
    bitmapClosures.push({ canvasAllocations: canvases.length }); return result;
  };
  const nativeCreateElement = document.createElement.bind(document);
  document.createElement = (...args) => {
    const element = nativeCreateElement(...args);
    if (String(args[0]).toLowerCase() === 'canvas') canvases.push(element);
    return element;
  };
  HTMLCanvasElement.prototype.toBlob = function(callback, ...args) {
    const size = { width: this.width, height: this.height };
    return nativeToBlob.call(this, (blob) => { encodings.push({ ...size, bytes: blob?.size || 0 }); callback(blob); }, ...args);
  };
  globalThis.createImageBitmap = async (...args) => {
    const bitmap = await nativeBitmap(...args);
    if (config.holdBitmap && !bitmapHeld) {
      bitmapHeld = true; await new Promise((resolve) => { releaseBitmap = resolve; });
    }
    return bitmap;
  };
  const nativeSetProperty = CSSStyleDeclaration.prototype.setProperty;
  const nativeRemoveProperty = CSSStyleDeclaration.prototype.removeProperty;
  let writes = 0; let cleanupFaulted = false;
  CSSStyleDeclaration.prototype.setProperty = function(...args) {
    if (config.failPrepare && ++writes === 3) throw new Error('Injected preparation write failure');
    return nativeSetProperty.apply(this, args);
  };
  CSSStyleDeclaration.prototype.removeProperty = function(...args) {
    if (config.failCleanup && !cleanupFaulted && owner.snapshot().phase === 'restoring' && args[0] === 'overflow-anchor') {
      cleanupFaulted = true; throw new Error('Injected cleanup write failure');
    }
    return nativeRemoveProperty.apply(this, args);
  };
  owner.subscribe((state) => {
    events.push(state);
    if (config.undoSuppressionOnRetry && state.phase === 'preparing' && state.attempt === 2) {
      document.getElementById('fixed').style.setProperty('visibility', 'visible', 'important');
    }
    if (state.phase === 'capturing' && state.section === 0) {
      const phaseAttempt = state.attempt;
      if (config.shrink && phaseAttempt === 1) document.querySelector('main').style.height = '1100px';
      if (config.retry === 'always' || (config.retry === 'once' && phaseAttempt === 1)) {
        document.body.dataset.reliabilityChange = String(phaseAttempt);
      }
      if (config.changePreparationStyle) {
        const style = [...document.querySelectorAll('style')].find((node) => node.textContent.includes('animation-play-state: paused'));
        if (config.changePreparationStyle === 'remove') style.remove();
        else if (config.changePreparationStyle === 'text') style.textContent += 'html { scroll-behavior: smooth; }';
        else if (config.changePreparationStyle === 'disabled') style.sheet.disabled = true;
        else if (config.changePreparationStyle === 'media') style.sheet.media.appendMedium('print');
        else style.sheet.deleteRule(0);
      }
    }
    if (config.cancelPhase === state.phase && state.canCancel) owner.cancel(state.sessionId);
    if (config.disconnectAtCommit && state.phase === 'delivering') for (const port of ports) port.disconnect();
  });
  window.LongformReliability = Object.freeze({
    configure(next) { Object.assign(config, next); },
    snapshot: () => owner.snapshot(),
    events: () => events,
    stats: () => {
      const metrics = Longform.page.measure(), size = Longform.geometry.getCanvasSize(metrics);
      const canvasPixels = size.width * size.height;
      const tilePixels = Math.ceil(metrics.viewportWidth * metrics.pixelRatio) * Math.ceil(metrics.viewportHeight * metrics.pixelRatio);
      const pngReserveBytes = Longform.capture.estimatePngBytes(canvasPixels, size.height);
      return { captureCalls, draws, tileHeld, digestHeld, bitmapHeld, coverageResult, encodings, bitmapClosures,
        canvasAllocations: canvases.length,
        liveCanvases: canvases.filter((canvas) => canvas.width && canvas.height).length,
        memory: { canvasPixels, tilePixels, pngReserveBytes,
          capturePeakBytes: Longform.capture.estimateWorkingBytes({ canvasPixels, tilePixels, pngBytes: pngReserveBytes }) } };
    },
    releaseTile() { releaseTile?.(); },
    releaseDigest() { releaseDigest?.(); },
    releaseBitmap() { releaseBitmap?.(); },
    advance(ms) { clockOffset += ms; return owner.snapshot(); },
    cancel() { owner.cancel(owner.snapshot().sessionId); },
  });
})();
`;

export async function runReliabilityChecks({ browserContext, serviceWorker, baseUrl, artifactsDir }) {
  const results = [];
  let worker = serviceWorker;
  const extensionId = new URL(worker.url()).host;
  const terminal = new Set(['ready-to-deliver', 'failed', 'cancelled', 'expired']);
  async function isolated(tabId, operation, argument) {
    const [value] = await worker.evaluate(async ({ tabId, operation, argument }) => chrome.scripting.executeScript({
      target: { tabId },
      func: ({ operation, argument }) => LongformReliability[operation](argument),
      args: [{ operation, argument }],
    }), { tabId, operation, argument });
    return value.result;
  }
  async function readState(page) {
    return page.evaluate(() => ({ x: scrollX, y: scrollY,
      styles: [...document.querySelectorAll('*:not(style)')].map((element) => [element.tagName, element.style.cssText]),
      ownedStyles: [...document.querySelectorAll('style')].filter((element) => element.textContent.includes('animation-play-state: paused')).length,
    }));
  }
  async function setup(route = 'capture-interruption.html', config = {}) {
    const target = await browserContext.newPage();
    await target.goto(`${baseUrl}/tests/fixtures/${route}`);
    await target.evaluate(() => scrollTo({ top: 120, behavior: 'instant' }));
    const expectedRestoredState = await readState(target);
    const [tab] = await worker.evaluate(async (url) => (await chrome.tabs.query({})).filter((tab) => tab.url === url), target.url());
    await worker.evaluate(async (tabId) => {
      const files = Longform.protocol.contentFiles;
      await chrome.scripting.executeScript({ target: { tabId }, files: [...files.slice(0, -2), 'reliability-world.js'] });
    }, tab.id);
    await isolated(tab.id, 'configure', config);
    await worker.evaluate(async (tabId) => chrome.scripting.executeScript({ target: { tabId }, files: ['capture.js', 'content.js'] }), tab.id);
    const clientPage = await browserContext.newPage();
    await clientPage.goto(`chrome-extension://${extensionId}/popup.html`);
    await clientPage.evaluate(async (tabId) => { window.reliabilityClient = await Longform.popup.connectSession(tabId); }, tab.id);
    await target.bringToFront();
    return { target, tabId: tab.id, clientPage, expectedRestoredState,
      livePageState: () => readState(target),
      snapshot: () => isolated(tab.id, 'snapshot'),
      async start() { await clientPage.evaluate(() => reliabilityClient.start('download')); },
      async wait() {
        for (let count = 0; count < 600; count++) {
          const state = await this.snapshot();
          if (terminal.has(state.phase)) return state;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error(`Reliability timeout: ${JSON.stringify(await this.snapshot())}`);
      },
      async close() { await clientPage.close(); await target.close(); },
    };
  }
  async function restored(test, expected = test.expectedRestoredState) {
    const livePageState = test.livePageState;
    const expectedRestoredState = expected;
    assert.deepEqual(await livePageState(), expectedRestoredState);
  }
  async function scenario(name, action) {
    if (process.env.LONGFORM_RELIABILITY_CASE && !new RegExp(process.env.LONGFORM_RELIABILITY_CASE).test(name)) return;
    const started = performance.now();
    try {
      const detail = await action();
      results.push({ name, passed: true, durationMs: Math.round(performance.now() - started), ...detail });
      await writeFile(path.join(artifactsDir, 'reliability.json'), JSON.stringify({ results }, null, 2));
    } catch (error) {
      results.push({ name, passed: false, error: error.message });
      await writeFile(path.join(artifactsDir, 'reliability.json'), JSON.stringify({ results }, null, 2));
      throw new Error(`Reliability ${name}: ${error.message}`, { cause: error });
    }
  }
  async function pixels(clientPage) {
    return clientPage.evaluate(async () => {
      const { blob, transferId } = await reliabilityClient.artifact();
      window.reliabilityArtifact = { blob, transferId };
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0); bitmap.close();
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let interiorMissingPixels = 0; let wrongTabPixels = 0;
      for (let y = 1; y < canvas.height - 1; y++) for (let x = 1; x < canvas.width - 1; x++) {
        const index = (y * canvas.width + x) * 4;
        if (data[index] !== 24 || data[index + 1] !== 164 || data[index + 2] !== 96 || data[index + 3] !== 255) interiorMissingPixels++;
        if (data[index] === 255 && data[index + 1] === 0 && data[index + 2] === 255) wrongTabPixels++;
      }
      return { width: canvas.width, height: canvas.height, interiorMissingPixels, wrongTabPixels, bytes: blob.size };
    });
  }

  await scenario('hidpi-normal-window-full-resolution-save', async () => {
    const test = await setup('dark-footer.html');
    const cdp = await browserContext.newCDPSession(test.target);
    try {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1621, height: 1378, deviceScaleFactor: 1.5, mobile: false });
      const metrics = await test.target.evaluate(() => ({ width: innerWidth, height: innerHeight, ratio: devicePixelRatio,
        pageHeight: document.scrollingElement.scrollHeight,
        marker: (() => { const rect = document.querySelector('[data-longform-end-marker]').getBoundingClientRect();
          return { left: rect.left, top: rect.top + scrollY, right: rect.right, bottom: rect.bottom + scrollY }; })() }));
      assert.deepEqual([metrics.width, metrics.height, metrics.ratio, metrics.pageHeight], [1621, 1378, 1.5, 4200]);
      await test.start(); const state = await test.wait();
      assert.equal(state.phase, 'ready-to-deliver'); await restored(test);
      const download = test.clientPage.waitForEvent('download');
      const artifactBytes = await test.clientPage.evaluate(async () => {
        const { blob, transferId } = await reliabilityClient.artifact();
        await reliabilityClient.commit(transferId);
        Longform.delivery.save(blob, 'reliability-hidpi-dark-footer.png');
        await reliabilityClient.result(transferId, 'success');
        return blob.size;
      });
      const saved = path.join(artifactsDir, 'reliability-hidpi-dark-footer.png');
      await (await download).saveAs(saved);
      const bytes = await readFile(saved);
      assert.equal(bytes.length, artifactBytes);
      const image = await test.clientPage.evaluate(async ({ bytes, marker }) => {
        const bitmap = await createImageBitmap(new Blob([Uint8Array.from(bytes)], { type: 'image/png' }));
        const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
        const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0); bitmap.close();
        const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let transparentPixels = 0, missingBackgroundPixels = 0, missingFooterPixels = 0;
        for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
          const i = (y * canvas.width + x) * 4;
          if (data[i + 3] !== 255) transparentPixels++;
          // Every row includes untextured interior background, away from scrollbar.
          if (x >= 20 && x < 40 && (data[i] !== 17 || data[i + 1] !== 24 || data[i + 2] !== 32)) missingBackgroundPixels++;
          // A broad untextured strip inside the footer must survive full-height stitching.
          if (x > (marker.left + 4) * 1.5 && x < (marker.right - 4) * 1.5
              && y > (marker.top + 4) * 1.5 && y < (marker.top + 10) * 1.5
              && (data[i] !== 255 || data[i + 1] !== 59 || data[i + 2] !== 138)) missingFooterPixels++;
        }
        return { width: canvas.width, height: canvas.height, transparentPixels, missingBackgroundPixels, missingFooterPixels };
      }, { bytes: [...bytes], marker: metrics.marker });
      assert.deepEqual(image, { width: 2432, height: 6300, transparentPixels: 0, missingBackgroundPixels: 0, missingFooterPixels: 0 });
      const stats = await isolated(test.tabId, 'stats');
      assert.equal(stats.coverageResult.complete, true);
      assert.equal(stats.liveCanvases, 0);
      assert.ok(stats.memory.capturePeakBytes < 512 * 1024 * 1024);
      return { metrics, ...image, artifactBytes, memory: stats.memory, coverageResult: stats.coverageResult, restored: true, savedAndDecoded: true };
    } finally { await cdp.detach(); await test.close(); }
  });

  for (const interruption of ['none', 'activity']) await scenario(interruption === 'none'
    ? 'hidpi-cancelled-bitmap-replacement-waits-for-close' : 'hidpi-cancelled-bitmap-replacement-activity-loss', async () => {
    const test = await setup('dark-footer.html', { holdBitmap: true });
    const cdp = await browserContext.newCDPSession(test.target);
    let other;
    try {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1621, height: 1378, deviceScaleFactor: 1.5, mobile: false });
      await test.start();
      let stats;
      for (let i = 0; i < 200; i++) {
        stats = await isolated(test.tabId, 'stats'); if (stats.bitmapHeld) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(stats.bitmapHeld, true);
      const first = await test.snapshot();
      await isolated(test.tabId, 'cancel'); assert.equal((await test.wait()).phase, 'cancelled'); await restored(test);
      await test.start(); const replacement = await test.snapshot();
      assert.notEqual(replacement.sessionId, first.sessionId);
      assert.equal(replacement.phase, 'preparing');
      stats = await isolated(test.tabId, 'stats');
      assert.equal(stats.canvasAllocations, 1); assert.equal(stats.liveCanvases, 0);
      assert.equal(stats.bitmapClosures.length, 0); assert.equal(stats.encodings.length, 0);
      if (interruption === 'activity') {
        other = await browserContext.newPage(); await other.goto('data:text/html,<title>Other tab</title>'); await other.bringToFront();
        const inactive = await worker.evaluate((tabId) => chrome.tabs.get(tabId), test.tabId);
        assert.equal(inactive.active, false);
        const stopped = await test.wait();
        assert.equal(stopped.phase, 'failed'); assert.equal(stopped.errorCode, 'target-changed'); await restored(test);
        await test.target.bringToFront();
        await isolated(test.tabId, 'releaseBitmap');
        for (let i = 0; i < 200; i++) {
          stats = await isolated(test.tabId, 'stats'); if (stats.bitmapClosures.length) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.equal(stats.bitmapClosures.length, 1); assert.equal(stats.canvasAllocations, 1);
        assert.equal(stats.captureCalls, 1); assert.equal(stats.encodings.length, 0);
        assert.equal((await test.snapshot()).errorCode, 'target-changed');
        await assert.rejects(() => test.clientPage.evaluate(() => reliabilityClient.artifact()));
        return { errorCode: stopped.errorCode, nativeActivityLost: true, replacementWaited: true,
          staleNativeWorkDidNotResume: true, canvasAllocations: stats.canvasAllocations, captureCalls: stats.captureCalls, restored: true };
      }
      await isolated(test.tabId, 'releaseBitmap');
      assert.equal((await test.wait()).phase, 'ready-to-deliver'); await restored(test);
      stats = await isolated(test.tabId, 'stats');
      assert.equal(stats.bitmapClosures[0].canvasAllocations, 1);
      assert.equal(stats.canvasAllocations, 2); assert.equal(stats.liveCanvases, 0);
      assert.equal(stats.encodings.length, 1);
      assert.deepEqual([stats.encodings[0].width, stats.encodings[0].height], [2432, 6300]);
      return { replacementWaited: true, oldBitmapClosedBeforeReplacementAllocation: true,
        encodings: stats.encodings, canvasAllocations: stats.canvasAllocations, liveCanvases: stats.liveCanvases, restored: true };
    } finally { await other?.close(); await cdp.detach(); await test.close(); }
  });

  for (const kind of ['over-budget', 'incompressible']) await scenario(`hidpi-${kind}-rejection-and-cleanup`, async () => {
    const test = await setup('dark-footer.html');
    const cdp = await browserContext.newCDPSession(test.target);
    try {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1621, height: 1378, deviceScaleFactor: 1.5, mobile: false });
      await test.target.evaluate((kind) => {
        if (kind === 'over-budget') { document.body.style.width = '5000px'; document.body.style.height = '5000px'; return; }
        const canvas = document.createElement('canvas'); canvas.width = 2432; canvas.height = 6300;
        canvas.style.cssText = 'display:block;width:100%;height:4200px';
        const context = canvas.getContext('2d'), image = context.createImageData(canvas.width, canvas.height);
        let seed = 0x12345678;
        for (let i = 0; i < image.data.length; i += 4) {
          seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
          image.data[i] = seed & 255; image.data[i + 1] = (seed >>> 8) & 255; image.data[i + 2] = (seed >>> 16) & 255; image.data[i + 3] = 255;
        }
        context.putImageData(image, 0, 0); document.body.replaceChildren(canvas);
      }, kind);
      test.expectedRestoredState = await test.livePageState();
      await test.start(); const state = await test.wait();
      assert.equal(state.phase, 'failed'); assert.equal(state.errorCode, 'page-too-large'); await restored(test);
      const stats = await isolated(test.tabId, 'stats');
      assert.equal(stats.liveCanvases, 0);
      if (kind === 'over-budget') { assert.equal(stats.captureCalls, 0); assert.equal(stats.encodings.length, 0); assert.ok(stats.memory.capturePeakBytes > 512 * 1024 * 1024); }
      else { assert.ok(stats.captureCalls > 0); assert.equal(stats.coverageResult.complete, true); assert.ok(stats.encodings[0].bytes > 32 * 1024 * 1024); }
      await assert.rejects(() => test.clientPage.evaluate(() => reliabilityClient.artifact()));
      return { errorCode: state.errorCode, captureCalls: stats.captureCalls, memory: stats.memory, encodings: stats.encodings,
        liveCanvases: stats.liveCanvases, restored: true, output: false };
    } finally { await cdp.detach(); await test.close(); }
  });

  await scenario('hostile-page-secure-save-and-complete-interior', async () => {
    const test = await setup('hostile-download.html');
    try {
      await test.start(); assert.equal((await test.wait()).phase, 'ready-to-deliver'); await restored(test);
      const { interiorMissingPixels, wrongTabPixels, ...image } = await pixels(test.clientPage);
      assert.equal(interiorMissingPixels, 0);
      assert.equal(wrongTabPixels, 0);
      const downloads = []; test.clientPage.on('download', (download) => downloads.push(download));
      const downloaded = test.clientPage.waitForEvent('download');
      await test.clientPage.evaluate(async () => {
        const { blob, transferId } = reliabilityArtifact;
        await reliabilityClient.commit(transferId);
        Longform.delivery.save(blob, 'reliability-hostile.png');
        await reliabilityClient.result(transferId, 'success');
      });
      await (await downloaded).saveAs(path.join(artifactsDir, 'reliability-hostile.png'));
      const { pageObservedScreenshotUrls, pageReadScreenshotBytes } = await test.target.evaluate(() => ({ pageObservedScreenshotUrls, pageReadScreenshotBytes }));
      assert.equal(pageObservedScreenshotUrls.length, 0);
      assert.equal(pageReadScreenshotBytes, false);
      assert.equal(downloads.length, 1);
      return { ...image, interiorMissingPixels, wrongTabPixels, downloads: downloads.length, pageObservedScreenshotUrls, pageReadScreenshotBytes };
    } finally { await test.close(); }
  });
  await scenario('two-dimensional-fractional-grid-and-clipped-descendant', async () => {
    const test = await setup('coverage-gaps.html');
    const cdp = await browserContext.newCDPSession(test.target);
    try {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1.25, mobile: false });
      await test.start(); assert.equal((await test.wait()).phase, 'ready-to-deliver'); await restored(test);
      const image = await pixels(test.clientPage);
      const { interiorMissingPixels, wrongTabPixels } = image;
      assert.equal(interiorMissingPixels, 0); assert.equal(wrongTabPixels, 0);
      assert.equal(image.width, 2250); assert.equal(image.height, 2000);
      const downloaded = test.clientPage.waitForEvent('download');
      await test.clientPage.evaluate(() => Longform.delivery.save(reliabilityArtifact.blob, 'reliability-grid.png'));
      await (await downloaded).saveAs(path.join(artifactsDir, 'reliability-grid.png'));
      return image;
    } finally { await cdp.detach(); await test.close(); }
  });
  await scenario('coverage-hole-is-rejected', async () => {
    const test = await setup('coverage-gaps.html', { gap: true });
    try {
      await test.start(); const state = await test.wait();
      assert.equal(state.phase, 'failed'); assert.equal(state.errorCode, 'incomplete-coverage');
      assert.equal(state.attempt, 1); await restored(test);
      await assert.rejects(() => test.clientPage.evaluate(() => reliabilityClient.artifact()));
      const stats = await isolated(test.tabId, 'stats');
      assert.equal(stats.coverageResult.uncoveredArea, 4000);
      assert.ok(stats.coverageResult.gaps.every((gap) => gap.left > 0 && gap.top > 0 && gap.right < 1800 && gap.bottom < 1600));
      return { errorCode: state.errorCode, actualDraws: stats.draws.length, coverageResult: stats.coverageResult, artifactRejected: true };
    } finally { await test.close(); }
  });

  for (const [name, config, expected] of [
    ['one-bounded-retry', { retry: 'once' }, 'ready-to-deliver'],
    ['retry-exhaustion', { retry: 'always' }, 'failed'],
    ['shrinking-page', { shrink: true }, 'ready-to-deliver'],
  ]) await scenario(name, async () => {
    const test = await setup('capture-interruption.html', config);
    try {
      await test.start(); const state = await test.wait();
      assert.equal(state.phase, expected); assert.equal(state.attempt, 2);
      if (expected === 'failed') assert.equal(state.errorCode, 'unstable-page');
      const expectedState = structuredClone(test.expectedRestoredState);
      if (config.shrink) expectedState.styles.find(([tag]) => tag === 'MAIN')[1] = 'height: 1100px;';
      await restored(test, expectedState);
      return { attempt: state.attempt, phase: state.phase, errorCode: state.errorCode };
    } finally { await test.close(); }
  });

  for (const change of ['suppression', 'remove', 'text', 'rules', 'disabled', 'media']) await scenario(`preparation-integrity-${change}`, async () => {
    const test = await setup('capture-interruption.html', change === 'suppression'
      ? { retry: 'once', undoSuppressionOnRetry: true } : { changePreparationStyle: change });
    try {
      await test.start(); const state = await test.wait();
      assert.equal(state.phase, 'failed'); assert.equal(state.errorCode, 'preparation-changed');
      assert.equal(state.attempt, change === 'suppression' ? 2 : 1);
      await restored(test); // newer visible!important equals the fixture's original declaration
      await assert.rejects(() => test.clientPage.evaluate(() => reliabilityClient.artifact()));
      return { errorCode: state.errorCode, attempt: state.attempt, output: false, restored: true };
    } finally { await test.close(); }
  });

  await scenario('ineffective-scroll-restoration-blocks-output-and-reuse', async () => {
    const test = await setup('capture-interruption.html', { ineffectiveRestore: true });
    try {
      await test.start(); const state = await test.wait();
      assert.equal(state.phase, 'failed'); assert.equal(state.errorCode, 'cleanup-failed');
      const live = await test.livePageState();
      assert.notEqual(live.y, test.expectedRestoredState.y);
      assert.equal(live.ownedStyles, 0); assert.deepEqual(live.styles, test.expectedRestoredState.styles);
      await assert.rejects(() => test.clientPage.evaluate(() => reliabilityClient.artifact()));
      await assert.rejects(() => test.clientPage.evaluate(() => reliabilityClient.start('download')));
      return { errorCode: state.errorCode, output: false, reuseBlocked: true, inversesAttempted: true };
    } finally { await test.close(); }
  });

  for (const stage of ['preparation', 'between-requests']) await scenario(`visibility-away-back-${stage}`, async () => {
    const test = await setup('capture-interruption.html', { holdBitmap: stage === 'between-requests' });
    let other, pendingRoute;
    const resourceUrl = `${baseUrl}/tests/fixtures/visibility-pending.png`;
    const intercept = (route) => { pendingRoute = route; };
    try {
      if (stage === 'preparation') {
        await browserContext.route(resourceUrl, intercept);
        await test.target.evaluate((url) => {
          const image = document.createElement('img'); image.width = 30; image.height = 30;
          image.style.cssText = 'position:absolute;top:0;left:0'; image.src = url; document.body.append(image);
        }, resourceUrl);
        test.expectedRestoredState = await test.livePageState();
      }
      await test.start();
      let stats;
      for (let i = 0; i < 200; i++) {
        stats = await isolated(test.tabId, 'stats');
        if (stage === 'preparation' ? pendingRoute : stats.bitmapHeld) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(stage === 'preparation' ? pendingRoute : stats.bitmapHeld, 'suspended at the intended boundary');
      const callsBeforeSwitch = stats.captureCalls;
      assert.equal(callsBeforeSwitch, stage === 'preparation' ? 0 : 1);
      other = await browserContext.newPage(); await other.goto('data:text/html,<body style="background:rgb(255,0,255)">Other tab</body>');
      await other.bringToFront();
      const [otherTab] = await worker.evaluate(async (url) => (await chrome.tabs.query({})).filter((tab) => tab.url === url), other.url());
      if (otherTab) await worker.evaluate((tabId) => chrome.tabs.update(tabId, { active: true }), otherTab.id);
      const activeTabs = await worker.evaluate(async () => (await chrome.tabs.query({})).map(({ id, active }) => ({ id, active })));
      assert.equal(activeTabs.find(({ id }) => id === test.tabId).active, false);
      const observedVisibilityAtLoss = await test.target.evaluate(() => document.visibilityState);
      // Headless Chromium may report visible for an inactive tab. The native
      // activation notification must stop capture without relying on that hint.
      const state = await test.wait(); assert.equal(state.errorCode, 'target-changed');
      await restored(test);
      await worker.evaluate((tabId) => chrome.tabs.update(tabId, { active: true }), test.tabId);
      await test.target.bringToFront(); await isolated(test.tabId, 'releaseBitmap');
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal((await isolated(test.tabId, 'stats')).captureCalls, callsBeforeSwitch);
      assert.equal((await test.snapshot()).phase, 'failed');
      await assert.rejects(() => test.clientPage.evaluate(() => reliabilityClient.artifact()));
      return { errorCode: state.errorCode, captureCalls: callsBeforeSwitch, restoredWhileInactive: true, observedVisibilityAtLoss, resumedCalls: 0 };
    } finally {
      await pendingRoute?.abort().catch(() => {}); await browserContext.unroute(resourceUrl, intercept);
      await isolated(test.tabId, 'releaseBitmap').catch(() => {}); await other?.close(); await test.close();
    }
  });

  // A held native screenshot lets each interruption happen at an exact boundary.
  async function delayScreenshot() {
    await worker.evaluate(() => {
      globalThis.reliabilityNativeCapture = chrome.tabs.captureVisibleTab;
      globalThis.reliabilityCaptureCalls = 0;
      chrome.tabs.captureVisibleTab = async (...args) => {
        reliabilityCaptureCalls++;
        const png = await reliabilityNativeCapture.apply(chrome.tabs, args);
        globalThis.reliabilityScreenshotStarted = true;
        await new Promise((resolve) => { globalThis.reliabilityReleaseScreenshot = resolve; });
        return png;
      };
    });
  }
  async function screenshotStarted() {
    for (let i = 0; i < 400; i++) {
      if (await worker.evaluate(() => Boolean(globalThis.reliabilityScreenshotStarted))) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('Native screenshot did not start');
  }
  async function releaseScreenshot() {
    await worker.evaluate(() => {
      chrome.tabs.captureVisibleTab = globalThis.reliabilityNativeCapture;
      globalThis.reliabilityReleaseScreenshot?.();
      delete globalThis.reliabilityScreenshotStarted;
    });
  }
  for (const name of ['switch-away-and-back', 'user-scroll', 'viewport-change', 'zoom-change', 'pagehide-suspended-callback', 'newer-important-style', 'cancel-delayed-screenshot']) {
    await scenario(name, async () => {
      const test = await setup(); let other;
      try {
        await delayScreenshot(); await test.start(); await screenshotStarted();
        assert.equal(await test.target.locator('#animated').evaluate((node) => getComputedStyle(node).animationPlayState), 'paused');
        const expectedState = structuredClone(test.expectedRestoredState);
        if (name === 'switch-away-and-back') {
          other = await browserContext.newPage(); await other.setContent('<body style="background:rgb(255,0,255)">Other tab</body>');
          await other.bringToFront();
          await test.target.bringToFront();
        } else if (name === 'user-scroll') await test.target.mouse.wheel(0, 200);
        else if (name === 'viewport-change') await test.target.setViewportSize({ width: 1100, height: 700 });
        else if (name === 'zoom-change') await worker.evaluate((tabId) => chrome.tabs.setZoom(tabId, 1.1), test.tabId);
        else if (name === 'pagehide-suspended-callback') {
          await test.target.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
          await restored(test);
          await test.target.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
        } else if (name === 'newer-important-style') {
          await test.target.evaluate(() => document.getElementById('fixed').style.setProperty('visibility', 'collapse', 'important'));
          expectedState.styles.find(([tag, style]) => tag === 'DIV' && style.includes('visibility'))[1] = 'visibility: collapse !important;';
          await isolated(test.tabId, 'cancel');
        } else {
          const requestedAt = performance.now();
          await isolated(test.tabId, 'cancel');
          // The native callback is still suspended; cleanup must not await it.
          await restored(test);
          assert.ok(performance.now() - requestedAt < 250, 'Responsive-page Cancel restores within 250ms');
        }
        const callsBeforeResume = (await isolated(test.tabId, 'stats')).captureCalls;
        await releaseScreenshot(); const state = await test.wait();
        if (['viewport-change', 'zoom-change'].includes(name)) {
          assert.equal(state.attempt, 2); assert.equal(state.phase, 'ready-to-deliver');
        } else {
          assert.ok(['failed', 'cancelled'].includes(state.phase), JSON.stringify(state));
          const expectedCode = { 'switch-away-and-back': 'target-changed', 'user-scroll': 'user-interrupted' }[name];
          if (expectedCode) assert.equal(state.errorCode, expectedCode);
          await assert.rejects(() => test.clientPage.evaluate(() => reliabilityClient.artifact()));
        }
        if (name === 'pagehide-suspended-callback') {
          const bfcacheResumedCaptureCalls = (await isolated(test.tabId, 'stats')).captureCalls - callsBeforeResume;
          assert.equal(bfcacheResumedCaptureCalls, 0);
        }
        await restored(test, expectedState);
        return { phase: state.phase, errorCode: state.errorCode, attempt: state.attempt, restored: true,
          lifecycleEvent: name === 'pagehide-suspended-callback' ? 'synthetic persisted pagehide/pageshow; real BFCache navigation checked separately' : undefined };
      } finally { await releaseScreenshot(); await other?.close(); await test.close(); }
    });
  }

  for (const name of ['screenshot-timeout', 'total-work-deadline']) await scenario(name, async () => {
    const test = await setup();
    try {
      await delayScreenshot(); await test.start(); await screenshotStarted();
      if (name === 'total-work-deadline') await isolated(test.tabId, 'advance', 120001);
      const state = await test.wait(); assert.equal(state.phase, 'failed');
      assert.equal(state.errorCode, name === 'screenshot-timeout' ? 'external-timeout' : 'work-timeout');
      await restored(test);
      const beforeRelease = await isolated(test.tabId, 'stats');
      await releaseScreenshot();
      await test.target.waitForTimeout(100);
      assert.deepEqual(await isolated(test.tabId, 'stats'), beforeRelease, 'A late native result has no draws or new requests');
      return { errorCode: state.errorCode, lateResultDiscarded: true, restoredBeforeRelease: true };
    } finally { await releaseScreenshot(); await test.close(); }
  });

  await scenario('delivery-commit-disconnect-is-unknown', async () => {
    const test = await setup('hostile-download.html', { disconnectAtCommit: true });
    try {
      await test.start(); await test.wait(); await pixels(test.clientPage);
      await assert.rejects(() => test.clientPage.evaluate(() => reliabilityClient.commit(reliabilityArtifact.transferId)), 'Disconnect during commit loses its acknowledgement');
      for (let i = 0; i < 100 && (await test.snapshot()).phase !== 'failed'; i++) await new Promise((resolve) => setTimeout(resolve, 20));
      const state = await test.snapshot(); assert.equal(state.deliveryOutcome, 'unknown'); assert.equal(state.errorCode, 'delivery-unknown');
      const captureCalls = (await isolated(test.tabId, 'stats')).captureCalls;
      await test.clientPage.evaluate(async (tabId) => { window.reliabilityClient = await Longform.popup.connectSession(tabId); }, test.tabId);
      assert.equal((await test.snapshot()).deliveryOutcome, 'unknown');
      assert.equal((await isolated(test.tabId, 'stats')).captureCalls, captureCalls);
      return { outcome: state.deliveryOutcome, automaticRecapture: false };
    } finally { await test.close(); }
  });
  for (const when of ['reconnect', 'transferring']) await scenario(`expiry-during-${when}`, async () => {
    const test = await setup('hostile-download.html', { holdDigest: when === 'transferring' });
    try {
      await test.start(); await test.wait();
      const expiresAt = (await test.snapshot()).expiresAt;
      if (when === 'transferring') {
        await test.clientPage.evaluate(() => {
          window.pendingArtifact = reliabilityClient.artifact().then(() => 'unexpected artifact', (error) => error.code || error.message);
        });
        for (let i = 0; i < 200 && !(await isolated(test.tabId, 'stats')).digestHeld; i++) await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal((await isolated(test.tabId, 'stats')).digestHeld, true, 'A real transfer is suspended in its broker digest');
      }
      else await test.clientPage.evaluate(() => reliabilityClient.disconnect());
      const expired = await isolated(test.tabId, 'advance', 120001);
      assert.equal(expired.phase, 'expired'); assert.equal(expired.expiresAt, expiresAt);
      if (when === 'transferring') {
        await isolated(test.tabId, 'releaseDigest');
        assert.notEqual(await test.clientPage.evaluate(() => pendingArtifact), 'unexpected artifact');
        assert.equal((await test.snapshot()).phase, 'expired');
      }
      else {
        await test.clientPage.evaluate(async (tabId) => { window.reliabilityClient = await Longform.popup.connectSession(tabId); }, test.tabId);
        await assert.rejects(() => test.clientPage.evaluate(() => reliabilityClient.artifact()));
      }
      await restored(test); return { errorCode: expired.errorCode, expiresAtUnchanged: true, staleDeliveryRejected: true };
    } finally { await test.close(); }
  });
  for (const phase of ['preparing', 'capturing', 'validating', 'restoring', 'encoding', 'ready-to-deliver', 'transferring']) {
    await scenario(`cancel-in-${phase}`, async () => {
      const test = await setup('hostile-download.html', { cancelPhase: phase });
      try {
        await test.start();
        if (phase === 'transferring') {
          assert.equal((await test.wait()).phase, 'ready-to-deliver');
          await assert.rejects(() => test.clientPage.evaluate(() => reliabilityClient.artifact()));
        }
        const state = await test.wait(); assert.equal(state.phase, 'cancelled');
        await isolated(test.tabId, 'cancel'); assert.equal((await test.snapshot()).phase, 'cancelled');
        await restored(test); return { phase: state.phase, repeatedCancel: 'idempotent' };
      } finally { await test.close(); }
    });
  }
  await scenario('reinjection-and-double-start-share-one-owner', async () => {
    const test = await setup();
    try {
      await test.start(); const first = await test.snapshot();
      await worker.evaluate(async (tabId) => chrome.scripting.executeScript({ target: { tabId }, files: Longform.protocol.contentFiles }), test.tabId);
      await test.clientPage.evaluate(() => reliabilityClient.start('download'));
      assert.equal((await test.snapshot()).sessionId, first.sessionId);
      assert.equal((await test.wait()).phase, 'ready-to-deliver'); await restored(test);
      const events = await isolated(test.tabId, 'events');
      assert.equal(new Set(events.filter((state) => state.sessionId).map((state) => state.sessionId)).size, 1);
      return { singleOwner: true, restored: true };
    } finally { await test.close(); }
  });
  for (const failure of ['Prepare', 'Cleanup']) await scenario(`partial-${failure.toLowerCase()}-failure`, async () => {
    const test = await setup('hostile-download.html', { [`fail${failure}`]: true });
    try {
      await test.start(); const state = await test.wait(); assert.equal(state.phase, 'failed');
      await assert.rejects(() => test.clientPage.evaluate(() => reliabilityClient.artifact()));
      if (failure === 'Prepare') await restored(test);
      else {
        assert.equal(state.errorCode, 'cleanup-failed');
        assert.equal((await test.livePageState()).ownedStyles, 0);
        assert.equal((await test.livePageState()).y, test.expectedRestoredState.y);
        await assert.rejects(() => test.clientPage.evaluate(() => reliabilityClient.start('download')));
      }
      return { errorCode: state.errorCode, output: false, reuseBlocked: failure === 'Cleanup' };
    } finally { await test.close(); }
  });
  for (const stalled of [false, true]) await scenario(stalled ? 'visible-resource-timeout' : 'visible-lazy-resource-and-finite-growth', async () => {
    const test = await setup('hostile-download.html');
    const resourceUrl = `${baseUrl}/tests/fixtures/reliability-resource.png`;
    let pendingRoute;
    const intercept = (route) => { pendingRoute = route; };
    await browserContext.route(resourceUrl, intercept);
    try {
      const greenPng = await test.target.evaluate(() => {
        const canvas = document.createElement('canvas'); canvas.width = 30; canvas.height = 30;
        const ctx = canvas.getContext('2d'); ctx.fillStyle = 'rgb(24,164,96)'; ctx.fillRect(0, 0, 30, 30);
        return canvas.toDataURL().split(',')[1];
      });
      await test.target.evaluate((url) => {
        const image = document.createElement('img'); image.width = 30; image.height = 30; image.loading = 'lazy';
        image.style.cssText = 'position:absolute;top:1000px;left:0'; document.body.append(image);
        addEventListener('scroll', function load() {
          if (scrollY < 400) return;
          image.src = url; document.body.style.height = '1800px'; removeEventListener('scroll', load);
        });
      }, resourceUrl);
      const expectedResourceState = await test.livePageState();
      expectedResourceState.styles.find(([tag]) => tag === 'BODY')[1] = 'height: 1800px;';
      await test.start();
      for (let i = 0; i < 200 && !pendingRoute; i++) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.ok(pendingRoute, 'Traversal starts a real local visible image request');
      assert.equal((await isolated(test.tabId, 'stats')).captureCalls, 0, 'No screenshot before resource decode');
      if (!stalled) await pendingRoute.fulfill({ contentType: 'image/png', body: Buffer.from(greenPng, 'base64') });
      const state = await test.wait();
      assert.equal(state.phase, stalled ? 'failed' : 'ready-to-deliver');
      if (stalled) assert.equal(state.errorCode, 'resource-timeout');
      else {
        assert.equal(await test.target.locator('img').evaluate((image) => image.complete && image.naturalWidth === 30), true);
        const { interiorMissingPixels } = await pixels(test.clientPage); assert.equal(interiorMissingPixels, 0);
      }
      await restored(test, expectedResourceState);
      return { phase: state.phase, errorCode: state.errorCode, localResource: true, screenshotsBeforeDecode: 0 };
    } finally { await pendingRoute?.abort().catch(() => {}); await browserContext.unroute(resourceUrl, intercept); await test.close(); }
  });
  await scenario('endless-layout-growth-is-bounded', async () => {
    const test = await setup('hostile-download.html');
    try {
      await test.target.evaluate(() => {
        window.growthTimer = setInterval(() => { document.body.style.height = `${document.body.offsetHeight + 1}px`; }, 75);
      });
      await test.start(); const state = await test.wait();
      await test.target.evaluate(() => clearInterval(growthTimer));
      assert.equal(state.phase, 'failed'); assert.equal(state.errorCode, 'unstable-page'); assert.equal(state.attempt, 2);
      assert.equal((await isolated(test.tabId, 'stats')).captureCalls, 0);
      assert.equal((await test.livePageState()).ownedStyles, 0);
      assert.equal((await test.livePageState()).y, test.expectedRestoredState.y);
      return { errorCode: state.errorCode, attempts: state.attempt, output: false, restoredOwnedStyles: true };
    } finally { await test.close(); }
  });
  await scenario('navigation-restores-before-suspended-callback', async () => {
    const test = await setup();
    try {
      await delayScreenshot(); await test.start(); await screenshotStarted();
      const callsBeforeNavigation = await worker.evaluate(() => globalThis.reliabilityCaptureCalls);
      await test.target.goto(`${baseUrl}/tests/fixtures/coverage-gaps.html`);
      await releaseScreenshot();
      // BFCache resumes without another load event.
      await test.target.goBack({ waitUntil: 'commit' });
      await test.target.waitForFunction(() => scrollY === 120, null, { timeout: 2000 }).catch(() => {});
      const lifecycle = await test.target.evaluate(() => window.lifecycle);
      const bfcacheRestored = lifecycle.some((event) => event.type === 'pageshow' && event.persisted);
      assert.equal(bfcacheRestored, true, 'This acceptance case must exercise a genuine BFCache restore');
      assert.deepEqual(await test.livePageState(), test.expectedRestoredState, `History restoration lifecycle: ${JSON.stringify(lifecycle)}`);
      // Compare with the suspended operation before navigating, so a callback
      // that resumes during pageshow cannot evade the assertion.
      await test.target.waitForTimeout(200);
      const bfcacheResumedCaptureCalls = await worker.evaluate(() => globalThis.reliabilityCaptureCalls) - callsBeforeNavigation;
      assert.equal(bfcacheResumedCaptureCalls, 0);
      return { bfcacheRestored, lifecycle, bfcacheResumedCaptureCalls, restored: true };
    } finally { await releaseScreenshot(); await test.close(); }
  });
  await scenario('worker-termination-rejects-old-generation', async () => {
    const test = await setup('hostile-download.html', { holdSecondTile: true });
    const cdp = await browserContext.newCDPSession(test.clientPage);
    try {
      const versions = [];
      cdp.on('ServiceWorker.workerVersionUpdated', ({ versions: next }) => versions.push(...next));
      await cdp.send('ServiceWorker.enable');
      await test.start();
      for (let i = 0; i < 400 && !(await isolated(test.tabId, 'stats')).tileHeld; i++) await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal((await isolated(test.tabId, 'stats')).tileHeld, true);
      const version = versions.findLast((entry) => entry.scriptURL === worker.url() && entry.runningStatus === 'running');
      assert.ok(version, 'CDP reports the actual extension worker');
      await cdp.send('ServiceWorker.stopWorker', { versionId: version.versionId });
      // A fresh extension-page request wakes a new native worker generation.
      await test.clientPage.evaluate(() => chrome.runtime.sendMessage({ type: 'BROKER_HELLO' }).catch(() => {}));
      worker = browserContext.serviceWorkers().find((entry) => entry.url() === serviceWorker.url())
        || await browserContext.waitForEvent('serviceworker');
      await isolated(test.tabId, 'releaseTile');
      const state = await test.wait();
      assert.equal(state.phase, 'failed'); assert.equal(state.errorCode, 'worker-interrupted'); await restored(test);
      return { actualWorkerStopped: true, errorCode: state.errorCode, restored: true };
    } finally { await cdp.detach(); await test.close(); }
  });
  return { ok: true, selectedCase: process.env.LONGFORM_RELIABILITY_CASE || null, permissionScope: 'test-only host grants; not production toolbar proof', results };
}
