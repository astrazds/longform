import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';

export async function runPopupChecks({ browserContext, serviceWorker, baseUrl, userDataDir, artifactsDir }) {
  const target = await browserContext.newPage();
  await target.goto(`${baseUrl}/tests/fixtures/sticky-elements.html`);
  await target.evaluate(() => window.scrollTo(0, 240));
  const originalState = await pageState(target);
  const [port] = (await readFile(path.join(userDataDir, 'DevToolsActivePort'), 'utf8')).split('\n');
  const results = [];
  let savedDimensions;

  for (const destination of ['save', 'copy']) {
    await target.bringToFront();
    await serviceWorker.evaluate(() => chrome.action.openPopup());
    // Chromium exposes toolbar popups as separate targets after they open.
    const attached = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const popup = attached.contexts()[0].pages().find((page) => page.url().endsWith('/popup.html'));
    assert.ok(popup, 'The actual toolbar popup opened');
    await popup.waitForFunction(() => document.getElementById('status').textContent === 'Ready');
    assert.equal(await popup.locator('#tabTitle').textContent(), await target.title());
    if (destination === 'save') {
      await popup.screenshot({ path: path.join(artifactsDir, 'popup-ready.png'), animations: 'disabled' });
    }

    const attachedTarget = attached.contexts()[0].pages().find((page) => page.url() === target.url());
    const downloadPromise = destination === 'save' ? attachedTarget.waitForEvent('download') : null;
    await popup.locator(destination === 'save' ? '#screenshotBtn' : '#copyBtn').click();
    await popup.waitForFunction(() => /Artifact (saved|copied)\.|error/.test(
      document.getElementById('status').textContent + document.getElementById('status').className
    ), null, { timeout: 45000 });
    const status = await popup.locator('#status').textContent();
    assert.equal(status, destination === 'save' ? 'Artifact saved.' : 'Artifact copied.');
    assert.equal(await popup.locator('#screenshotBtn').isEnabled(), true);
    assert.equal(await popup.locator('#copyBtn').isEnabled(), true);
    assert.deepEqual(await pageState(target), originalState, 'Capture restores scroll and inline styles');

    if (downloadPromise) {
      const download = await downloadPromise;
      assert.match(download.suggestedFilename(), /^longform-capture-.*\.png$/);
      const destinationPath = path.join(artifactsDir, 'popup-saved.png');
      await download.saveAs(destinationPath);
      const bytes = await readFile(destinationPath);
      assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      savedDimensions = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    } else {
      await popup.context().grantPermissions(['clipboard-read']);
      const copiedDimensions = await popup.evaluate(async () => {
        const items = await navigator.clipboard.read();
        const png = await items.find((item) => item.types.includes('image/png')).getType('image/png');
        const bitmap = await createImageBitmap(png);
        const dimensions = { width: bitmap.width, height: bitmap.height };
        bitmap.close();
        return dimensions;
      });
      assert.deepEqual(copiedDimensions, savedDimensions, 'Clipboard contains the complete captured PNG');
    }
    results.push({ destination, status, restored: true });
    await popup.close();
    await attached.close();
  }

  await target.bringToFront();
  await serviceWorker.evaluate(() => {
    globalThis.originalCaptureVisibleTab = chrome.tabs.captureVisibleTab;
    chrome.tabs.captureVisibleTab = async () => { throw new Error('Capture unavailable for restoration test'); };
  });
  let failureConnection;
  try {
    await serviceWorker.evaluate(() => chrome.action.openPopup());
    failureConnection = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const popup = failureConnection.contexts()[0].pages().find((page) => page.url().endsWith('/popup.html'));
    await popup.waitForFunction(() => document.getElementById('status').textContent === 'Ready');
    await popup.locator('#screenshotBtn').click();
    await popup.waitForFunction(() => document.getElementById('status').classList.contains('error'));
    assert.equal(await popup.locator('#status').textContent(), 'Capture unavailable for restoration test');
    assert.deepEqual(await pageState(target), originalState, 'Failed capture restores page state');
    assert.equal(await popup.locator('#screenshotBtn').isEnabled(), true);
    results.push({ destination: 'failure', restored: true });
    await popup.close();
  } finally {
    await serviceWorker.evaluate(() => {
      chrome.tabs.captureVisibleTab = globalThis.originalCaptureVisibleTab;
      delete globalThis.originalCaptureVisibleTab;
    });
    await failureConnection?.close();
  }
  await target.close();
  return results;
}

async function pageState(page) {
  return page.evaluate(() => ({
    x: window.scrollX,
    y: window.scrollY,
    styles: [...document.querySelectorAll('*')].map((element) => element.getAttribute('style') || ''),
  }));
}
