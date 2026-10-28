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
    popup.on('pageerror', (error) => console.error('Popup page error:', error.message));
    await popup.waitForFunction(() => (
      ['', 'Download started.', 'Copied.'].includes(document.getElementById('status').textContent)
      && !document.getElementById('screenshotBtn').disabled
      && !document.getElementById('copyBtn').disabled
    )).catch(async (error) => { throw new Error(`${error.message}; initial popup: ${await popup.locator('body').innerText()}`); });

    if (destination === 'save') {
      await popup.evaluate(() => {
        window.sectionAnnouncements = [];
        new MutationObserver(() => {
          if (document.getElementById('status').textContent.startsWith('Capturing section')) window.sectionAnnouncements.push(Date.now());
        }).observe(document.getElementById('status'), { childList: true });
      });
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

    const downloadPromise = destination === 'save' ? popup.waitForEvent('download') : null;
    downloadPromise?.catch(() => {});
    await popup.locator(destination === 'save' ? '#screenshotBtn' : '#copyBtn').click();
    const busyStatus = 'Preparing page…';
    await popup.waitForFunction((expected) => (
      document.getElementById('status').textContent === expected
    ), busyStatus);
    assert.equal(await popup.locator('#screenshotBtn').isDisabled(), true);
    assert.equal(await popup.locator('#copyBtn').isDisabled(), true);
    assert.equal(await popup.locator('#cancelBtn').isVisible(), true);
    assert.equal(await popup.locator('#cancelBtn').evaluate((button) => button.getBoundingClientRect().height >= 44), true);
    assert.equal(await popup.locator('#progress').evaluate((element) => !element.hasAttribute('value')), true);
    assert.equal(await popup.locator('#screenshotBtn').textContent(), 'Save');
    assert.equal(await popup.locator('#copyBtn').textContent(), 'Copy');
    if (destination === 'save') {
      await popup.screenshot({ path: path.join(artifactsDir, 'popup-saving.png'), animations: 'disabled' });
    }

    const expectedStatus = destination === 'save' ? 'Download started.' : 'Copied.';
    await popup.waitForFunction((expected) => (
      document.getElementById('status').textContent === expected
      || document.getElementById('status').classList.contains('error')
    ), expectedStatus, { timeout: 45000 });
    const status = await popup.locator('#status').textContent();
    assert.equal(status, expectedStatus);
    assert.equal(await popup.locator('#status').getAttribute('class'), 'status success');
    assert.equal(await popup.locator('#screenshotBtn').isEnabled(), true);
    assert.equal(await popup.locator('#copyBtn').isEnabled(), true);
    const announcements = await popup.evaluate(() => window.sectionAnnouncements || []);
    for (let index = 1; index < announcements.length; index++) assert.ok(announcements[index] - announcements[index - 1] >= 990, 'Section announcements are at most once per second');
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
      !document.getElementById('copyBtn').disabled
    ));
    await popup.evaluate(() => {
      Object.defineProperty(navigator.clipboard, 'write', {
        configurable: true,
        value: () => {
          document.documentElement.dataset.clipboardWriteRejected = 'true';
          return Promise.reject(Object.assign(new Error('PNG too large to copy'), { code: 'copy-too-large' }));
        },
      });
    });
    await popup.locator('#copyBtn').click();
    await popup.waitForFunction(() => document.documentElement.dataset.clipboardWriteRejected === 'true');
    assert.equal(await popup.locator('#cancelBtn').isVisible(), true);
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
    // Retained PNG recovery must not call the capture broker again.
    await serviceWorker.evaluate(() => {
      globalThis.recoveryCapture = chrome.tabs.captureVisibleTab;
      chrome.tabs.captureVisibleTab = async () => { throw new Error('Recovery recaptured'); };
    });
    const recoveryDownload = popup.waitForEvent('download');
    recoveryDownload.catch(() => {});
    await popup.locator('#screenshotBtn').click();
    await popup.waitForFunction(() => document.getElementById('status').textContent === 'Download started.');
    await recoveryDownload;
    await serviceWorker.evaluate(() => { chrome.tabs.captureVisibleTab = globalThis.recoveryCapture; delete globalThis.recoveryCapture; });
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
      !document.getElementById('screenshotBtn').disabled
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

  // Cancel leaves focus on an available action after cleanup.
  await target.bringToFront();
  await serviceWorker.evaluate(() => chrome.action.openPopup());
  const cancelConnection = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  let popup = cancelConnection.contexts()[0].pages().find((page) => page.url().endsWith('/popup.html'));
  await popup.waitForFunction(() => !document.getElementById('screenshotBtn').disabled);
  await popup.locator('#screenshotBtn').click();
  await popup.locator('#cancelBtn').click();
  await popup.waitForFunction(() => document.getElementById('status').textContent === 'Cancelled.').catch(async (error) => { throw new Error(`${error.message}; cancel state: ${await popup.locator('body').innerText()}`); });
  assert.equal(await popup.locator('#cancelBtn').isHidden(), true);
  assert.equal(await popup.locator('#screenshotBtn').evaluate((button) => document.activeElement === button), true);
  assert.deepEqual(await pageState(target), originalState, 'Cancel completes restoration');
  results.push({ destination: 'cancel', restored: true, focus: true });
  await popup.close(); await cancelConnection.close();

  // Closing a subscription cannot cancel or deliver; a reopened popup keeps
  // the same session and requires a fresh retained-image gesture.
  await target.bringToFront();
  await serviceWorker.evaluate(() => chrome.action.openPopup());
  const firstConnection = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  popup = firstConnection.contexts()[0].pages().find((page) => page.url().endsWith('/popup.html'));
  await popup.waitForFunction(() => !document.getElementById('screenshotBtn').disabled);
  await popup.locator('#screenshotBtn').click();
  const [targetTab] = await serviceWorker.evaluate(async (url) => chrome.tabs.query({}).then((tabs) => tabs.filter((tab) => tab.url === url)), target.url());
  const readSnapshot = () => serviceWorker.evaluate(async (tabId) => {
    const [result] = await chrome.scripting.executeScript({ target: { tabId }, func: () => Longform.sessions.install().snapshot() });
    return result.result;
  }, targetTab.id);
  const originalSession = await readSnapshot();
  await popup.close(); await firstConnection.close();
  await target.bringToFront(); await serviceWorker.evaluate(() => chrome.action.openPopup());
  const reopenedConnection = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  popup = reopenedConnection.contexts()[0].pages().find((page) => page.url().endsWith('/popup.html'));
  await popup.waitForFunction(() => document.getElementById('status').textContent === 'Capture ready. Choose Save or Copy.', null, { timeout: 45000 });
  assert.equal((await readSnapshot()).sessionId, originalSession.sessionId);
  await serviceWorker.evaluate(() => {
    globalThis.recoveryCapture = chrome.tabs.captureVisibleTab;
    chrome.tabs.captureVisibleTab = async () => { throw new Error('Reopen recovery recaptured'); };
  });
  const retainedDownload = popup.waitForEvent('download'); retainedDownload.catch(() => {});
  await popup.locator('#screenshotBtn').click();
  await popup.waitForFunction(() => document.getElementById('status').textContent === 'Download started.');
  await retainedDownload;
  await serviceWorker.evaluate(() => { chrome.tabs.captureVisibleTab = globalThis.recoveryCapture; delete globalThis.recoveryCapture; });
  results.push({ destination: 'reopen', sameSession: true, restored: true, recaptured: false });
  await popup.close(); await reopenedConnection.close();
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
