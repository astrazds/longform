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
    await popup.waitForFunction(() => (
      document.getElementById('status').textContent === ''
      && !document.getElementById('screenshotBtn').disabled
      && !document.getElementById('copyBtn').disabled
    ));

    if (destination === 'save') {
      await popup.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
      const idleState = await popup.evaluate(() => {
        const saveButton = document.getElementById('screenshotBtn');
        const copyButton = document.getElementById('copyBtn');
        const status = document.getElementById('status');
        const bodyBounds = document.body.getBoundingClientRect();

        return {
          bodyHeight: bodyBounds.height,
          bodyWidth: bodyBounds.width,
          copyHeight: copyButton.getBoundingClientRect().height,
          copyLabel: copyButton.getAttribute('aria-label'),
          copyText: copyButton.textContent.trim(),
          heading: document.querySelector('h1')?.textContent,
          oldMetadataPresent: Boolean(document.querySelector('#tabTitle, #tabUrl, #tabFavicon, #statusDetail')),
          saveHeight: saveButton.getBoundingClientRect().height,
          saveLabel: saveButton.getAttribute('aria-label'),
          saveText: saveButton.textContent.trim(),
          statusAtomic: status.getAttribute('aria-atomic'),
          statusDisplay: getComputedStyle(status).display,
          statusHeight: status.getBoundingClientRect().height,
          statusLive: status.getAttribute('aria-live'),
          statusRole: status.getAttribute('role'),
          statusText: status.textContent,
        };
      });

      assert.equal(idleState.heading, 'Full-page screenshot');
      assert.equal(idleState.saveText, 'Save');
      assert.equal(idleState.copyText, 'Copy');
      assert.equal(idleState.saveLabel, 'Save full-page screenshot as PNG');
      assert.equal(idleState.copyLabel, 'Copy full-page screenshot as PNG');
      assert.equal(idleState.statusRole, 'status');
      assert.equal(idleState.statusLive, 'polite');
      assert.equal(idleState.statusAtomic, 'true');
      assert.equal(idleState.statusText, '');
      assert.notEqual(idleState.statusDisplay, 'none', 'The empty live region stays mounted');
      assert.equal(idleState.statusHeight, 0, 'The empty live region adds no idle height');
      assert.equal(idleState.oldMetadataPresent, false);
      assert.equal(idleState.bodyWidth, 300);
      assert.ok(idleState.bodyHeight >= 115 && idleState.bodyHeight <= 130, 'Idle popup stays compact');
      assert.ok(idleState.saveHeight >= 44, 'Save target is at least 44px high');
      assert.ok(idleState.copyHeight >= 44, 'Copy target is at least 44px high');

      await popup.screenshot({ path: path.join(artifactsDir, 'popup-idle-light.png'), animations: 'disabled' });
      const lightBackground = await popup.evaluate(() => getComputedStyle(document.body).backgroundColor);
      await popup.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
      const darkState = await popup.evaluate(() => ({
        background: getComputedStyle(document.body).backgroundColor,
        transitionDuration: getComputedStyle(document.getElementById('screenshotBtn')).transitionDuration,
      }));
      assert.notEqual(darkState.background, lightBackground, 'Dark mode changes the popup palette');
      assert.equal(darkState.transitionDuration, '0s', 'Reduced motion removes button transitions');
      await popup.screenshot({ path: path.join(artifactsDir, 'popup-idle-dark.png'), animations: 'disabled' });
      await popup.locator('#screenshotBtn').focus();
      await popup.keyboard.press('Tab');
      assert.equal(await popup.locator('#copyBtn').evaluate((button) => button === document.activeElement), true);
      assert.equal(await popup.locator('#copyBtn').evaluate((button) => (
        button.matches(':focus-visible') && getComputedStyle(button).outlineStyle === 'solid'
      )), true, 'Keyboard navigation has a visible focus outline');
      await popup.screenshot({ path: path.join(artifactsDir, 'popup-focus-dark.png'), animations: 'disabled' });
      await popup.keyboard.press('Shift+Tab');
      assert.equal(await popup.locator('#screenshotBtn').evaluate((button) => button === document.activeElement), true);
      await popup.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
    }

    const attachedTarget = attached.contexts()[0].pages().find((page) => page.url() === target.url());
    const downloadPromise = destination === 'save' ? attachedTarget.waitForEvent('download') : null;
    await popup.locator(destination === 'save' ? '#screenshotBtn' : '#copyBtn').click();
    const busyStatus = destination === 'save' ? 'Saving...' : 'Copying...';
    await popup.waitForFunction((expected) => (
      document.getElementById('status').textContent === expected
    ), busyStatus);
    assert.equal(await popup.locator('#screenshotBtn').isDisabled(), true);
    assert.equal(await popup.locator('#copyBtn').isDisabled(), true);
    if (destination === 'save') {
      await popup.screenshot({ path: path.join(artifactsDir, 'popup-saving.png'), animations: 'disabled' });
    }

    const expectedStatus = destination === 'save' ? 'Saved.' : 'Copied.';
    await popup.waitForFunction((expected) => (
      document.getElementById('status').textContent === expected
      || document.getElementById('status').classList.contains('error')
    ), expectedStatus, { timeout: 45000 });
    const status = await popup.locator('#status').textContent();
    assert.equal(status, expectedStatus);
    assert.equal(await popup.locator('#status').getAttribute('class'), 'status success');
    assert.equal(await popup.locator('#screenshotBtn').isEnabled(), true);
    assert.equal(await popup.locator('#copyBtn').isEnabled(), true);
    assert.deepEqual(await pageState(target), originalState, 'Capture restores scroll and inline styles');
    await popup.screenshot({
      path: path.join(artifactsDir, destination === 'save' ? 'popup-saved.png' : 'popup-copied.png'),
      animations: 'disabled',
    });

    if (downloadPromise) {
      const download = await downloadPromise;
      assert.match(download.suggestedFilename(), /^longform-capture-.*\.png$/);
      const destinationPath = path.join(artifactsDir, 'popup-capture.png');
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
  await serviceWorker.evaluate(() => chrome.action.openPopup());
  let clipboardFailureConnection;
  try {
    clipboardFailureConnection = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const popup = clipboardFailureConnection.contexts()[0].pages()
      .find((page) => page.url().endsWith('/popup.html'));
    assert.ok(popup, 'The toolbar popup opened for clipboard failure coverage');
    await popup.waitForFunction(() => (
      document.getElementById('status').textContent === ''
      && !document.getElementById('copyBtn').disabled
    ));
    await popup.evaluate(() => {
      Object.defineProperty(navigator.clipboard, 'write', {
        configurable: true,
        value: () => {
          document.documentElement.dataset.clipboardWriteRejected = 'true';
          return Promise.reject(new Error('PNG too large to copy'));
        },
      });
    });
    await popup.locator('#copyBtn').click();
    await popup.waitForFunction(() => document.documentElement.dataset.clipboardWriteRejected === 'true');
    assert.equal(await popup.locator('#status').textContent(), 'Copying...');
    assert.equal(await popup.locator('#screenshotBtn').isDisabled(), true);
    assert.equal(await popup.locator('#copyBtn').isDisabled(), true);
    await popup.waitForFunction(() => document.getElementById('status').classList.contains('error'), null, {
      timeout: 45000,
    });
    assert.equal(await popup.locator('#status').textContent(), 'This PNG is too large to copy. Save it instead.');
    assert.equal(await popup.locator('#screenshotBtn').isEnabled(), true);
    assert.equal(await popup.locator('#copyBtn').isEnabled(), true);
    assert.deepEqual(
      await pageState(target),
      originalState,
      'Early clipboard rejection still waits for capture to restore page state'
    );
    await popup.screenshot({ path: path.join(artifactsDir, 'popup-copy-error.png'), animations: 'disabled' });
    results.push({ destination: 'copy-failure', restored: true });
    await popup.close();
  } finally {
    await clipboardFailureConnection?.close();
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
    await popup.waitForFunction(() => (
      document.getElementById('status').textContent === ''
      && !document.getElementById('screenshotBtn').disabled
    ));
    await popup.locator('#screenshotBtn').click();
    await popup.waitForFunction(() => document.getElementById('status').classList.contains('error'));
    assert.equal(
      await popup.locator('#status').textContent(),
      'Could not save this page. Try again or choose another page.'
    );
    assert.deepEqual(await pageState(target), originalState, 'Failed capture restores page state');
    assert.equal(await popup.locator('#screenshotBtn').isEnabled(), true);
    assert.equal(await popup.locator('#copyBtn').isEnabled(), true);
    await popup.screenshot({ path: path.join(artifactsDir, 'popup-error.png'), animations: 'disabled' });
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
