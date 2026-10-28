import { contentFiles, extensionFiles, iconFiles } from './extension-files.mjs';
import assert from 'node:assert/strict';
import { runPopupChecks } from './popup-checks.mjs';
import { reliabilityWorldScript, runReliabilityChecks } from './reliability-checks.mjs';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { accessSync, constants, createReadStream } from 'node:fs';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const artifactsDir = path.join(repoRoot, 'artifacts', 'smoke');
const downloadsDir = path.join(artifactsDir, 'downloads');
const reportPath = path.join(artifactsDir, 'longform-smoke.json');
const releaseReportPath = path.join(artifactsDir, 'longform-release-smoke.json');
if (process.env.LONGFORM_RELIABILITY_CASE && !process.argv.some((arg) => ['--reliability', '--popup-reliability'].includes(arg))) {
  throw new Error('LONGFORM_RELIABILITY_CASE is for focused reliability runs only; unset it for the full gate.');
}
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};
const smokeHarnessHtml = '<!doctype html><meta charset="utf-8"><title>Longform smoke</title><script src="protocol.js"></script><script src="capture-transfer.js"></script><script src="capture-delivery.js"></script><script src="clipboard.js"></script><script src="popup.js"></script><script src="smoke.js"></script>';
const smokeHarnessScript = `
const params = new URL(location.href).searchParams;
const targetUrl = params.get('targetUrl') || '';
const filename = params.get('filename') || 'longform-capture-smoke.png';
const setState = (patch) => { window.__longformSmoke = { ...(window.__longformSmoke || {}), ...patch, at: new Date().toISOString() }; };
(async () => {
  const started = performance.now();
  setState({ status: 'booting', targetUrl });
  const tabs = await chrome.tabs.query({});
  const tab = tabs.find((candidate) => candidate.url === targetUrl);
  if (!tab?.id) throw new Error('Smoke target tab not found');
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: Longform.protocol.contentFiles });
  const client = await Longform.popup.connectSession(tab.id);
  await client.start('download');
  await new Promise((resolve, reject) => {
    let unsubscribe;
    const check = (state) => {
      if (state.phase === 'ready-to-deliver') { unsubscribe?.(); resolve(); }
      else if (['failed','expired','cancelled'].includes(state.phase)) { unsubscribe?.(); reject(Object.assign(new Error(state.errorCode || state.phase), { code: state.errorCode })); }
    };
    unsubscribe = client.subscribe(check);
    if (['ready-to-deliver','failed','expired','cancelled'].includes(client.snapshot().phase)) unsubscribe();
  });
  const { blob, transferId } = await client.artifact();
  const [memory] = await chrome.scripting.executeScript({ target: { tabId: tab.id },
    args: [blob.size], func: (pngBytes) => {
      const metrics = Longform.page.measure();
      const canvas = Longform.geometry.getCanvasSize(metrics);
      const canvasPixels = canvas.width * canvas.height;
      const tilePixels = Math.ceil(metrics.viewportWidth * metrics.pixelRatio) * Math.ceil(metrics.viewportHeight * metrics.pixelRatio);
      const pngReserveBytes = Longform.capture.estimatePngBytes(canvasPixels, canvas.height);
      return { captureWorkingBytes: Longform.capture.estimateWorkingBytes({ canvasPixels, tilePixels, pngBytes: pngReserveBytes }),
        encodedCaptureWorkingBytes: Longform.capture.estimateWorkingBytes({ canvasPixels, tilePixels, pngBytes }),
        transferWorkingBytes: Longform.transfer.estimateWorkingBytes(pngBytes, canvasPixels), canvasPixels, tilePixels, pngBytes, pngReserveBytes };
    } });
  await client.commit(transferId);
  Longform.delivery.save(blob, filename);
  await client.result(transferId, 'success');
  setState({ durationMs: Math.round(performance.now() - started), estimatedMemory: memory.result, artifact: { byteSize: blob.size, delivery: 'download' }, filename, status: 'success', success: true, targetTabId: tab.id, targetWindowId: tab.windowId });
  client.disconnect();
})().catch((error) => setState({ error: error.message || 'Smoke capture failed', errorCode: error.code, status: 'error', success: false }));
`;
function recordCheckpoint(checkpoints, name, payload = {}) {
  checkpoints.push({
    name,
    at: new Date().toISOString(),
    ...payload,
  });
}

function getChromiumExecutable() {
  const configuredExecutable = process.env.CHROMIUM_EXECUTABLE?.trim();
  if (configuredExecutable) {
    return configuredExecutable;
  }

  const browserNames = process.platform === 'win32'
    ? ['chrome.exe', 'chromium.exe']
    : ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'];
  const searchDirectories = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  let systemExecutable = '';

  for (const directory of searchDirectories) {
    for (const browserName of browserNames) {
      const candidate = path.join(directory, browserName);

      try {
        accessSync(candidate, constants.X_OK);
        systemExecutable = candidate;
        break;
      } catch {
      }
    }

    if (systemExecutable) {
      break;
    }
  }

  const executable = systemExecutable || chromium.executablePath();

  if (!executable) {
    throw new Error(
      'Chromium executable not found. Set CHROMIUM_EXECUTABLE or run `mise run browser:install`.'
    );
  }

  return executable;
}

async function resetArtifactsDirectory() {
  await rm(artifactsDir, { force: true, recursive: true });
  await mkdir(downloadsDir, { recursive: true });
}

async function buildSmokeExtensionBundle(sourceDir) {
  const extensionDir = await mkdtemp(path.join(tmpdir(), 'longform-extension-'));

  for (const file of extensionFiles) {
    await copyFile(path.join(sourceDir, file), path.join(extensionDir, file));
  }

  await mkdir(path.join(extensionDir, 'icons'));
  for (const icon of iconFiles) {
    await copyFile(path.join(sourceDir, 'icons', icon), path.join(extensionDir, 'icons', icon));
  }

  const manifestPath = path.join(extensionDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.host_permissions = ['<all_urls>'];
  manifest.permissions = Array.from(new Set([...(manifest.permissions || []), 'tabs']));
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(extensionDir, 'smoke.html'), smokeHarnessHtml);
  await writeFile(path.join(extensionDir, 'smoke.js'), smokeHarnessScript);
  await writeFile(path.join(extensionDir, 'reliability-world.js'), reliabilityWorldScript);

  return extensionDir;
}

function createStaticServer(rootDir) {
  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
      const relativePath = decodeURIComponent(requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname);
      const resolvedPath = path.resolve(rootDir, `.${relativePath}`);

      if (!resolvedPath.startsWith(rootDir)) {
        response.writeHead(403);
        response.end('Forbidden');
        return;
      }

      const fileInfo = await stat(resolvedPath);
      if (!fileInfo.isFile()) {
        response.writeHead(404);
        response.end('Not found');
        return;
      }

      const fileExtension = path.extname(resolvedPath);
      response.writeHead(200, {
        'Content-Type': mimeTypes[fileExtension] || 'application/octet-stream',
      });
      createReadStream(resolvedPath).pipe(response);
    } catch (error) {
      response.writeHead(error?.code === 'ENOENT' ? 404 : 500);
      response.end(error?.code === 'ENOENT' ? 'Not found' : 'Server error');
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Could not determine local smoke server port'));
        return;
      }

      resolve({
        server,
        baseUrl: `http://127.0.0.1:${address.port}`,
      });
    });
  });
}

async function writeReport(payload, targetPath = reportPath) {
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(targetPath, `${JSON.stringify(payload, null, 2)}\n`);
}

async function compareBaseline(captureResults) {
  if (!captureResults.length) return null;
  let baseline;
  try { baseline = JSON.parse(await readFile(path.join(repoRoot, 'artifacts/baseline/chrome-baseline.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { available: false, reason: 'Supply the preserved baseline report at artifacts/baseline/chrome-baseline.json for a local comparison.' }; throw error; }
  return { available: true,
    method: 'Load-to-success wall time; same conservative current memory model applied to baseline dimensions/PNG bytes. Estimates are not browser RSS measurements.',
    tradeoff: 'The new path adds finite-content preparation with two stable samples 150ms apart, exact coverage validation, restoration before encoding, and verified chunk transfer. Most fixtures take longer because of that work. Both paths include browser scheduling and cold-start variation; single-run speedups cannot be attributed to one mechanism. Estimates compare output geometry under the same current model, not historical browser RSS.',
    fixtures: captureResults.map((current) => {
      const previous = baseline.captureResults.find((result) => result.label === current.label);
      assert.ok(previous, `Baseline contains ${current.label}`);
      const elapsed = (report, label) => Date.parse(report.checkpoints.find((event) => event.name === `${label}.capture.succeeded`).at)
        - Date.parse(report.checkpoints.find((event) => event.name === `${label}.loaded`).at);
      const baselineDurationMs = elapsed(baseline, current.label);
      const durationMs = Date.parse(checkpoints.find((event) => event.name === `${current.label}.capture.succeeded`).at)
        - Date.parse(checkpoints.find((event) => event.name === `${current.label}.loaded`).at);
      const diagnostics = previous.smokeResult.captureDiagnostics;
      const canvasPixels = diagnostics.canvas.width * diagnostics.canvas.height;
      const tilePixels = Math.ceil(diagnostics.metrics.viewportWidth * diagnostics.metrics.pixelRatio)
        * Math.ceil(diagnostics.metrics.viewportHeight * diagnostics.metrics.pixelRatio);
      const raw = canvasPixels * 4 + diagnostics.canvas.height;
      const pngReserveBytes = raw + Math.ceil(raw / 16383) * 5 + Math.ceil(raw / 32768) * 12 + 1024;
      const baselineEstimatedCaptureBytes = Math.max(8 * canvasPixels + 32 * tilePixels, 12 * canvasPixels + 2 * pngReserveBytes) + 16 * 1024 * 1024;
      return { label: current.label, baselineDurationMs, durationMs, durationRatio: Number((durationMs / baselineDurationMs).toFixed(3)),
        baselineEstimatedCaptureBytes, estimatedMemory: current.smokeResult.estimatedMemory };
    }) };
}

const checkpoints = [];
const harnessDiagnostics = [];

async function inspectCapture(browserContext, pngPath, { checkRightEdge = false, pixelRegions = [] } = {}) {
  const data = await readFile(pngPath);
  const dataUrl = `data:image/png;base64,${data.toString('base64')}`;
  const page = await browserContext.newPage();

  try {
    return await page.evaluate(async ({ source, checkRightEdge: shouldCheckRightEdge, pixelRegions }) => {
      const image = new Image();
      image.src = source;
      await image.decode();

      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;

      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);

      const startY = Math.floor(canvas.height * 0.75);
      const sampleStep = 4;
      let sampledPixels = 0;
      let markerPixels = 0;
      let rightEdgeRatio = null;

      for (let y = startY; y < canvas.height; y += sampleStep) {
        const row = context.getImageData(0, y, canvas.width, 1).data;

        for (let x = 0; x < canvas.width; x += sampleStep) {
          const offset = x * 4;
          const red = row[offset];
          const green = row[offset + 1];
          const blue = row[offset + 2];

          sampledPixels += 1;
          if (red > 230 && green < 90 && blue > 110) {
            markerPixels += 1;
          }
        }
      }

      if (shouldCheckRightEdge) {
        const stripWidth = Math.min(14, canvas.width);
        const endY = Math.floor(canvas.height * 0.82);
        let edgePixels = 0;
        let pageBackgroundPixels = 0;

        for (let y = 0; y < endY; y += 8) {
          const row = context.getImageData(canvas.width - stripWidth, y, stripWidth, 1).data;

          for (let offset = 0; offset < row.length; offset += 4) {
            const red = row[offset];
            const green = row[offset + 1];
            const blue = row[offset + 2];

            edgePixels += 1;
            if (red < 45 && green > 165 && blue > 85 && blue < 165) {
              pageBackgroundPixels += 1;
            }
          }
        }

        rightEdgeRatio = edgePixels ? pageBackgroundPixels / edgePixels : 0;
      }

      return {
        width: canvas.width,
        height: canvas.height,
        sampledPixels,
        markerPixels,
        markerRatio: sampledPixels ? markerPixels / sampledPixels : 0,
        rightEdgeRatio,
        pixelRegions: pixelRegions.map((region) => {
          const left = Math.max(0, Math.floor(region.left)); const top = Math.max(0, Math.floor(region.top));
          const width = Math.min(canvas.width - left, Math.ceil(region.width));
          const height = Math.min(canvas.height - top, Math.ceil(region.height));
          const pixels = context.getImageData(left, top, width, height).data;
          let matchingPixels = 0;
          for (let i = 0; i < pixels.length; i += 4) if (region.color.every((channel, index) => Math.abs(channel - pixels[i + index]) <= 8)) matchingPixels++;
          return { ...region, matchingPixels };
        }),
      };
    }, { source: dataUrl, checkRightEdge, pixelRegions });
  } finally {
    await page.close();
  }
}

async function runCaptureTarget({
  baseUrl,
  browserContext,
  extensionId,
  label,
  route,
  checkRightEdge = false,
  requireFooterMarker = false,
}) {
  const targetUrl = new URL(route, baseUrl).href;
  const targetPage = await browserContext.newPage();
  await targetPage.goto(targetUrl, { waitUntil: 'networkidle' });

  const pageMetrics = await targetPage.evaluate(() => {
    const marker = document.querySelector('[data-longform-end-marker]');
    const markerRect = marker?.getBoundingClientRect();

    return {
      pageHeight: document.documentElement.scrollHeight,
      pageWidth: document.documentElement.scrollWidth,
      title: document.title,
      url: window.location.href,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      marker: markerRect
        ? {
            bottom: markerRect.bottom + window.scrollY,
            top: markerRect.top + window.scrollY,
          }
        : null,
      pixelRegions: [...document.querySelectorAll('h1, h2')].map((element) => {
        const rect = element.getBoundingClientRect();
        const color = getComputedStyle(element).color.match(/[\d.]+/g).slice(0, 3).map(Number);
        return { left: rect.left + scrollX, top: rect.top + scrollY, width: rect.width, height: rect.height, color };
      }),
    };
  });

  recordCheckpoint(checkpoints, `${label}.loaded`, pageMetrics);

  const harnessPage = await browserContext.newPage();
  harnessPage.on('console', (message) => {
    harnessDiagnostics.push({
      label,
      text: message.text(),
      type: message.type(),
    });
  });
  harnessPage.on('pageerror', (error) => {
    harnessDiagnostics.push({
      label,
      text: error.message,
      type: 'pageerror',
    });
  });

  const requestedFilename = `longform-capture-smoke-${label}.png`;
  let downloadObserved = false;
  const originalState = await targetPage.evaluate(() => ({ x: scrollX, y: scrollY, styles: [...document.querySelectorAll('*')].map((node) => node.getAttribute('style')) }));
  const downloadPromise = harnessPage.waitForEvent('download', { timeout: 45000 }).then((download) => { downloadObserved = true; return download; });
  downloadPromise.catch(() => {});
  const harnessUrl = `chrome-extension://${extensionId}/smoke.html?targetUrl=${encodeURIComponent(targetUrl)}&filename=${encodeURIComponent(requestedFilename)}`;
  await harnessPage.goto(harnessUrl, { waitUntil: 'domcontentloaded' });
  await harnessPage.waitForFunction(
    () => {
      const state = window.__longformSmoke;
      return state?.success === true || state?.status === 'error';
    },
    null,
    { timeout: 45000 }
  );

  const smokeResult = await harnessPage.evaluate(() => window.__longformSmoke);
  if (!smokeResult?.success) {
    downloadPromise.catch(() => {});
    recordCheckpoint(checkpoints, `${label}.capture.failed`, {
      smokeResult,
    });
    if (label === 'near-limit' && smokeResult?.errorCode === 'page-too-large') {
      assert.equal(downloadObserved, false, 'Memory rejection produces no output');
      assert.deepEqual(await targetPage.evaluate(() => ({ x: scrollX, y: scrollY, styles: [...document.querySelectorAll('*')].map((node) => node.getAttribute('style')) })), originalState, 'Memory rejection restores page');
      await harnessPage.close(); await targetPage.close();
      return { label, pageMetrics, smokeResult, safelyRejected: true, output: false, restored: true };
    }
    throw new Error(
      `Capture failed for ${label}: ${smokeResult?.error || 'Unknown smoke failure'}`
    );
  }

  recordCheckpoint(checkpoints, `${label}.capture.succeeded`, {
    artifactByteSize: smokeResult?.artifact?.byteSize,
    artifactDelivery: smokeResult?.artifact?.delivery,
    captureDiagnostics: smokeResult?.captureDiagnostics,
    requestedFilename,
  });

  const download = await downloadPromise;
  const artifactCopyPath = path.join(
    artifactsDir,
    download.suggestedFilename() || requestedFilename
  );
  await download.saveAs(artifactCopyPath);
  const downloadedPngInfo = await stat(artifactCopyPath);

  const footerMarker = await inspectCapture(browserContext, artifactCopyPath, { checkRightEdge, pixelRegions: pageMetrics.pixelRegions });
  const pngDimensions = {
    height: footerMarker.height,
    width: footerMarker.width,
  };

  if (requireFooterMarker && footerMarker.markerPixels < 100) {
    throw new Error(`Footer marker was not found in ${label} capture`);
  }

  if (checkRightEdge && footerMarker.rightEdgeRatio < 0.9) {
    throw new Error(`Scrollbar edge was visible in ${label} capture`);
  }
  for (const region of footerMarker.pixelRegions) assert.ok(region.matchingPixels >= 10,
    `${label} contains expected text-color pixels in interior region at ${region.top}`);

  recordCheckpoint(checkpoints, `${label}.artifact.saved`, {
    artifactPath: artifactCopyPath,
    bytes: downloadedPngInfo.size,
    footerMarker,
    pngDimensions,
  });

  await harnessPage.close();
  await targetPage.close();

  return {
    artifactPath: artifactCopyPath,
    footerMarker,
    label,
    pageMetrics,
    pngDimensions,
    smokeResult,
  };
}

async function runReleaseSmoke() {
  let releaseBrowserContext;
  let releaseUserDataDir;

  try {
    const stdout = execFileSync('npm', ['run', 'package:release'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    const packageResult = JSON.parse(stdout.slice(stdout.indexOf('{')));
    const releaseDir = packageResult.releaseDir;
    const zipEntries = execFileSync('unzip', ['-Z1', packageResult.zipPath], { encoding: 'utf8' })
      .trim().split('\n').filter((entry) => !entry.endsWith('/')).sort();
    assert.deepEqual(zipEntries, [...extensionFiles, ...iconFiles.map((icon) => `icons/${icon}`)].sort());
    for (const file of zipEntries) {
      const archived = execFileSync('unzip', ['-p', packageResult.zipPath, file]);
      assert.deepEqual(archived, await readFile(path.join(repoRoot, file)), `Archive bytes match ${file}`);
      assert.deepEqual(await readFile(path.join(releaseDir, file)), archived, `Unpacked bytes match ${file}`);
    }

    releaseUserDataDir = await mkdtemp(path.join(tmpdir(), 'longform-release-smoke-'));
    releaseBrowserContext = await chromium.launchPersistentContext(releaseUserDataDir, {
      executablePath: getChromiumExecutable(),
      headless: true,
      args: [
        `--disable-extensions-except=${releaseDir}`,
        `--load-extension=${releaseDir}`,
      ],
    });

    let [serviceWorker] = releaseBrowserContext.serviceWorkers();
    if (!serviceWorker) {
      serviceWorker = await releaseBrowserContext.waitForEvent('serviceworker', { timeout: 15000 });
    }

    assert.deepEqual(await serviceWorker.evaluate(() => Longform.protocol.contentFiles), contentFiles);
    const extensionId = new URL(serviceWorker.url()).host;
    const popupPage = await releaseBrowserContext.newPage();
    await popupPage.goto(`chrome-extension://${extensionId}/popup.html`, {
      waitUntil: 'domcontentloaded',
    });
    await popupPage.waitForFunction(() => (
      document.querySelector('h1')?.textContent === 'Full-page screenshot'
      && document.getElementById('screenshotBtn')?.textContent?.trim() === 'Save'
      && document.getElementById('copyBtn')?.textContent?.trim() === 'Copy'
    ));

    const popupState = await popupPage.evaluate(() => ({
      copyLabel: document.getElementById('copyBtn')?.getAttribute('aria-label'),
      copyText: document.getElementById('copyBtn')?.textContent?.trim(),
      heading: document.querySelector('h1')?.textContent,
      oldMetadataPresent: Boolean(document.querySelector('#tabTitle, #tabUrl, #tabFavicon, #statusDetail')),
      screenshotLabel: document.getElementById('screenshotBtn')?.getAttribute('aria-label'),
      screenshotText: document.getElementById('screenshotBtn')?.textContent?.trim(),
      statusAtomic: document.getElementById('status')?.getAttribute('aria-atomic'),
      statusLive: document.getElementById('status')?.getAttribute('aria-live'),
      statusRole: document.getElementById('status')?.getAttribute('role'),
      title: document.title,
    }));

    assert.equal(popupState.title, 'Longform');
    assert.equal(popupState.heading, 'Full-page screenshot');
    assert.equal(popupState.copyText, 'Copy');
    assert.equal(popupState.screenshotText, 'Save');
    assert.equal(popupState.copyLabel, 'Copy full-page screenshot as PNG');
    assert.equal(popupState.screenshotLabel, 'Save full-page screenshot as PNG');
    assert.equal(popupState.statusRole, 'status');
    assert.equal(popupState.statusLive, 'polite');
    assert.equal(popupState.statusAtomic, 'true');
    assert.equal(popupState.oldMetadataPresent, false);
    await popupPage.waitForFunction(() => (
      document.getElementById('status').textContent === 'Open a regular web page, then try again.'
    ));
    assert.equal(await popupPage.locator('#status').getAttribute('class'), 'status error');
    assert.equal(await popupPage.locator('#screenshotBtn').isDisabled(), true);
    assert.equal(await popupPage.locator('#copyBtn').isDisabled(), true);

    const report = {
      ok: true,
      extensionId,
      packageResult,
      popupState,
      releaseDir,
      reportPath: releaseReportPath,
      serviceWorkerUrl: serviceWorker.url(),
    };

    await writeReport(report, releaseReportPath);
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    const report = {
      ok: false,
      error: error.message,
      reportPath: releaseReportPath,
    };

    await writeReport(report, releaseReportPath);
    console.error(JSON.stringify(report, null, 2));
    process.exitCode = 1;
  } finally {
    if (releaseBrowserContext) {
      await releaseBrowserContext.close();
    }

    if (releaseUserDataDir) {
      await rm(releaseUserDataDir, { force: true, recursive: true });
    }
  }
}

if (process.argv.includes('--release')) {
  await runReleaseSmoke();
} else {
  let browserContext;
  let localServer;
  let userDataDir;
  let smokeExtensionDir;

try {
  await resetArtifactsDirectory();
  const chromiumExecutable = getChromiumExecutable();
  const serverState = await createStaticServer(repoRoot);
  localServer = serverState.server;
  const { baseUrl } = serverState;
  userDataDir = await mkdtemp(path.join(tmpdir(), 'longform-smoke-'));
  smokeExtensionDir = await buildSmokeExtensionBundle(repoRoot);

  browserContext = await chromium.launchPersistentContext(userDataDir, {
    executablePath: chromiumExecutable,
    headless: true,
    acceptDownloads: true,
    downloadsPath: downloadsDir,
    viewport: { width: 1280, height: 720 },
    // Playwright disables BFCache by default. Reliability tests must observe
    // the browser's genuine history lifecycle rather than force a reload.
    ignoreDefaultArgs: ['--disable-back-forward-cache'],
    args: [
      `--disable-extensions-except=${smokeExtensionDir}`,
      `--load-extension=${smokeExtensionDir}`,
      '--remote-debugging-port=0',
    ],
  });

  let [serviceWorker] = browserContext.serviceWorkers();
  if (!serviceWorker) {
    serviceWorker = await browserContext.waitForEvent('serviceworker', { timeout: 15000 });
  }

  const extensionId = new URL(serviceWorker.url()).host;
  assert.deepEqual(await serviceWorker.evaluate(() => Longform.protocol.contentFiles), contentFiles);
  recordCheckpoint(checkpoints, 'extension.loaded', {
    extensionId,
    serviceWorkerUrl: serviceWorker.url(),
  });

  const landingPage = await browserContext.newPage();
  await landingPage.goto(baseUrl, { waitUntil: 'networkidle' });

  const landingMetrics = await landingPage.evaluate(() => ({
    pageHeight: document.documentElement.scrollHeight,
    pageWidth: document.documentElement.scrollWidth,
    title: document.title,
    url: window.location.href,
    viewportHeight: window.innerHeight,
    viewportWidth: window.innerWidth,
  }));

  recordCheckpoint(checkpoints, 'landing.loaded', landingMetrics);
  await landingPage.close();

  const captureTargets = [
    ['dark-footer', '/tests/fixtures/dark-footer.html'],
    ['no-scrollbar', '/tests/fixtures/no-scrollbar.html'],
    ['nested-long-page', '/tests/fixtures/nested-long-page.html'],
    ['sticky-elements', '/tests/fixtures/sticky-elements.html'],
    ['background-mismatch', '/tests/fixtures/background-mismatch.html'],
    ['horizontal-overflow', '/tests/fixtures/horizontal-overflow.html'],
    ['near-limit', '/tests/fixtures/near-limit.html'],
    ['smooth-marquee', '/tests/fixtures/smooth-marquee.html'],
  ];
  const captureResults = [];

  for (const [label, route] of process.argv.some((arg) => ['--popup', '--reliability', '--popup-reliability'].includes(arg)) ? [] : captureTargets) {
    captureResults.push(await runCaptureTarget({
      baseUrl,
      browserContext,
      extensionId,
      label,
      checkRightEdge: label === 'no-scrollbar',
      requireFooterMarker: true,
      route,
    }));
  }

  const popupChecks = process.argv.some((arg) => ['--reliability', '--fixtures'].includes(arg)) ? [] : await runPopupChecks({ browserContext, serviceWorker, baseUrl, userDataDir, artifactsDir });
  const reliabilityChecks = process.argv.some((arg) => ['--popup', '--fixtures'].includes(arg)) ? null : await runReliabilityChecks({ browserContext, serviceWorker, baseUrl, artifactsDir });
  const performanceComparison = await compareBaseline(captureResults);

  const report = {
    ok: true,
    baseUrl,
    smokeExtensionPath: smokeExtensionDir,
    captureResults,
    popupChecks,
    reliabilityChecks,
    performanceComparison,
    manualAcceptance: { productionToolbar: 'unverified by this harness in Chrome and Edge', screenReaderSpeech: 'manual check required', releaseReady: false },
    extensionPath: repoRoot,
    artifactPath: captureResults[0]?.artifactPath,
    reportPath,
    checkpoints,
    harnessDiagnostics,
  };

  await writeReport(report);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  const report = {
    ok: false,
    error: error.message,
    smokeExtensionPath: smokeExtensionDir,
    extensionPath: repoRoot,
    reportPath,
    harnessDiagnostics,
    checkpoints,
  };

  await writeReport(report);
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  if (browserContext) {
    await browserContext.close();
  }

  if (localServer) {
    await new Promise((resolve, reject) => {
      localServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  if (userDataDir) {
    await rm(userDataDir, { force: true, recursive: true });
  }

  if (smokeExtensionDir) {
    await rm(smokeExtensionDir, { force: true, recursive: true });
  }
}
}
