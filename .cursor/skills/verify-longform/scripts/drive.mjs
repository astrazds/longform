#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { connect, createServer as createSocketServer } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

process.env.PW_CHROMIUM_ATTACH_TO_OTHER = '1';
const execFileAsync = promisify(execFile);
const skillRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const repoRoot = path.resolve(skillRoot, '../../..');
const runDir = path.join(skillRoot, 'run');
const sessionPath = path.join(runDir, 'session.json');
const toolsDir = path.join(skillRoot, '.tools');
const browsersPath = path.join(toolsDir, 'browsers');
const playwrightDir = path.join(toolsDir, 'playwright');
const playwrightEntry = path.join(playwrightDir, 'node_modules', 'playwright-core', 'index.mjs');
const playwrightCli = path.join(playwrightDir, 'node_modules', 'playwright-core', 'cli.js');
const fixturePath = path.join(skillRoot, 'fixtures', 'page.html');
const port = 8891;
const controlPort = 8892;
const display = ':97';
const evidenceNames = ['save', 'copy', 'cancel', 'restricted-page'];
const playwrightVersion = '1.65.1';
const slack = 8;
const saveName = 'Save full-page screenshot as PNG';
const copyName = 'Copy full-page screenshot as PNG';
const blockedStatus = 'Open a regular web page, then try again.';
const pageUrl = `http://127.0.0.1:${port}/page.html`;

let sessionContext = null;
let article = null;
let popup = null;
let popupConnection = null;
let extensionId = '';
let httpServer = null;
let xvfbProcess = null;
let browserPid = 0;
let shuttingDown = false;
let chromium = null;
let targetScroll = 0;
let markerColor = null;
let currentEvidence = '';
const logs = [];

function fail(message) {
  console.error(message);
  process.exit(1);
}

function cmdline(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ');
  } catch {
    return '';
  }
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function browserPidFor(profileDir) {
  const hits = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    const command = cmdline(pid);
    if (!command.includes(profileDir) || !command.includes('chrom') || command.includes('--type=')) continue;
    hits.push(pid);
  }
  return hits.length === 1 ? hits[0] : 0;
}

async function signal(pid, needle) {
  if (!alive(pid) || !cmdline(pid).includes(needle)) return;
  process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + 3000;
  while (alive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (alive(pid) && cmdline(pid).includes(needle)) process.kill(pid, 'SIGKILL');
}

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) fail(`unknown argument ${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) fail(`missing value for ${token}`);
    out[token.slice(2)] = value;
    index += 1;
  }
  return out;
}

function splitAction(action) {
  const index = action.indexOf(':');
  if (index === -1) return { name: action, args: '' };
  return { name: action.slice(0, index), args: action.slice(index + 1) };
}

function evidenceDir(input) {
  const resolved = path.resolve(input);
  const root = path.resolve(skillRoot, 'evidence');
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`evidence must be under ${root}`);
  }
  return resolved;
}

function distance(left, right) {
  return Math.abs(left[0] - right[0]) + Math.abs(left[1] - right[1]) + Math.abs(left[2] - right[2]);
}

function near(pixel, expected) {
  return pixel.length >= 3 && pixel.slice(0, 3).every((channel, index) => Math.abs(channel - expected[index]) <= slack);
}

async function assertPortFree(target) {
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(target, '127.0.0.1', () => probe.close(resolve));
  }).catch(() => fail(`port ${target} is already in use`));
}

async function ensureTools() {
  const started = Date.now();
  if (!existsSync(playwrightEntry)) {
    console.error(`installing playwright-core ${playwrightVersion}`);
    await mkdir(playwrightDir, { recursive: true });
    await writeFile(path.join(playwrightDir, 'package.json'), `${JSON.stringify({
      private: true,
      dependencies: { 'playwright-core': playwrightVersion },
    }, null, 2)}\n`);
    await execFileAsync('npm', ['install', '--ignore-scripts', '--no-fund', '--no-audit'], {
      cwd: playwrightDir,
    });
  }
  process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;
  const imported = await import(pathToFileURL(playwrightEntry).href);
  chromium = imported.chromium;
  let executable = '';
  try {
    executable = chromium.executablePath();
  } catch {
    executable = '';
  }
  if (!executable || !existsSync(executable)) {
    console.error('installing verification Chromium');
    await execFileAsync(process.execPath, [playwrightCli, 'install', 'chromium'], {
      cwd: playwrightDir,
      env: process.env,
    });
  }
  return Date.now() - started;
}

function attachLogs(page, label) {
  page.on('console', (message) => logs.push(`[${label}] ${message.type()} ${message.text()}`));
  page.on('pageerror', (error) => logs.push(`[${label}] ${error}`));
}

async function waitForWorker() {
  const pick = () => sessionContext.serviceWorkers().filter((worker) => worker.url().endsWith('/background.js'));
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const found = pick();
    if (found.length > 1) throw new Error(`expected one Longform service worker, found ${found.length}`);
    if (found.length === 1) return found[0];
    const remaining = Math.max(1, deadline - Date.now());
    const event = await sessionContext.waitForEvent('serviceworker', { timeout: remaining }).catch((error) => {
      if (String(error).includes('Timeout')) return null;
      throw error;
    });
    if (!event && pick().length === 0) break;
  }
  throw new Error(`expected one Longform service worker, found ${pick().length}`);
}

async function startFixtureServer(nonce) {
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url || '/', 'http://fixture.local').pathname;
    const headers = { 'x-longform-verify': nonce, 'cache-control': 'no-store' };
    if (pathname === '/favicon.ico') {
      response.writeHead(204, headers);
      response.end();
      return;
    }
    if (pathname !== '/page.html') {
      response.writeHead(404, headers);
      response.end('not found');
      return;
    }
    const body = await readFile(fixturePath);
    response.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8' });
    response.end(body);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}

async function readPage() {
  return article.evaluate(() => {
    const one = (id) => {
      const nodes = [...document.querySelectorAll(`#${id}`)];
      if (nodes.length !== 1) return { count: nodes.length };
      const element = nodes[0];
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return {
        count: 1,
        text: element.textContent.trim(),
        visibility: style.visibility,
        display: style.display,
        inlineVisibility: element.style.visibility,
        width: box.width,
        height: box.height,
      };
    };
    return {
      url: location.href,
      title: document.title,
      scrollY: window.scrollY,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      scrollHeight: document.documentElement.scrollHeight,
      top: one('longform-top'),
      sticky: one('longform-sticky'),
      bottom: one('longform-bottom'),
    };
  });
}

async function markerColors() {
  const colors = await article.evaluate(() => {
    const rgb = (id) => {
      const color = getComputedStyle(document.getElementById(id)).backgroundColor;
      const match = color.match(/rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)/);
      if (!match) return null;
      const alpha = match[4] === undefined ? 1 : Number(match[4]);
      if (alpha < 1) return null;
      return match.slice(1, 4).map(Number);
    };
    return { top: rgb('longform-top'), bottom: rgb('longform-bottom') };
  });
  if (!colors.top || !colors.bottom) throw new Error(`fixture colors were ${JSON.stringify(colors)}`);
  if (distance(colors.top, colors.bottom) < 200) {
    throw new Error(`fixture markers are too similar: ${JSON.stringify(colors)}`);
  }
  return colors;
}

async function samplePng(page, bytes) {
  return page.evaluate(async (image) => {
    const binary = atob(image);
    const pixels = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) pixels[index] = binary.charCodeAt(index);
    const bitmap = await createImageBitmap(new Blob([pixels], { type: 'image/png' }));
    try {
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(bitmap, 0, 0);
      const at = (x, y) => Array.from(context.getImageData(x, y, 1, 1).data.slice(0, 3));
      return {
        width: bitmap.width,
        height: bitmap.height,
        top: at(8, 8),
        bottom: at(8, bitmap.height - 8),
      };
    } finally {
      bitmap.close();
    }
  }, bytes.toString('base64'));
}

function requirePng(bytes) {
  if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('file is not a PNG');
  if (bytes.subarray(12, 16).toString() !== 'IHDR') throw new Error('PNG has no IHDR');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function requireFullPage(sample, ihdr, metrics, colors) {
  if (sample.width !== ihdr.width || sample.height !== ihdr.height) {
    throw new Error(`decoded PNG ${sample.width}x${sample.height} does not match IHDR ${ihdr.width}x${ihdr.height}`);
  }
  if (ihdr.height <= metrics.innerHeight) {
    throw new Error(`PNG height ${ihdr.height} is a viewport (${metrics.innerHeight}), not the page`);
  }
  if (ihdr.height < metrics.scrollHeight - 80) {
    throw new Error(`PNG height ${ihdr.height} is shorter than the page ${metrics.scrollHeight}`);
  }
  if (!near(sample.top, colors.top)) {
    throw new Error(`PNG top ${JSON.stringify(sample.top)} is not the page top ${JSON.stringify(colors.top)}`);
  }
  if (!near(sample.bottom, colors.bottom)) {
    throw new Error(`PNG bottom ${JSON.stringify(sample.bottom)} is not the page bottom ${JSON.stringify(colors.bottom)}`);
  }
  if (near(sample.top, colors.bottom) || near(sample.bottom, colors.top)) {
    throw new Error('PNG markers overlap. The top and bottom bands are not distinct.');
  }
}

async function button(name) {
  const locator = popup.getByRole('button', { name, exact: true });
  const count = await locator.count();
  if (count !== 1) throw new Error(`${name} matched ${count} elements`);
  return locator;
}

async function readPopup() {
  if (!popup || popup.isClosed()) throw new Error('popup is not open');
  const view = await popup.evaluate(() => {
    const status = document.getElementById('status');
    const save = document.getElementById('screenshotBtn');
    const copy = document.getElementById('copyBtn');
    const cancel = document.getElementById('cancelBtn');
    const heading = document.querySelector('h1');
    return {
      heading: heading ? heading.textContent : '',
      headings: document.querySelectorAll('h1').length,
      status: status ? status.textContent : null,
      statusClass: status ? status.className : '',
      saveText: save ? save.textContent : '',
      copyText: copy ? copy.textContent : '',
      saveDisabled: save ? save.disabled : null,
      copyDisabled: copy ? copy.disabled : null,
      cancelHidden: cancel ? cancel.hidden : null,
      cancelText: cancel ? cancel.textContent : '',
      saveCount: document.querySelectorAll('#screenshotBtn').length,
      copyCount: document.querySelectorAll('#copyBtn').length,
      cancelCount: document.querySelectorAll('#cancelBtn').length,
    };
  });
  if (view.headings !== 1 || view.saveCount !== 1 || view.copyCount !== 1 || view.cancelCount !== 1) {
    throw new Error(`popup controls are not unique: ${JSON.stringify(view)}`);
  }
  return view;
}

async function closePopup() {
  if (popup && !popup.isClosed()) await popup.close().catch(() => {});
  popup = null;
  if (popupConnection) {
    await popupConnection.close().catch(() => {});
    popupConnection = null;
  }
}

function popupFrom(pages) {
  return pages.filter((page) => !page.isClosed() && page.url().endsWith('/popup.html'));
}

async function findPopup() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const local = popupFrom(sessionContext.pages());
    if (local.length > 1) throw new Error(`expected one popup, found ${local.length}`);
    if (local.length === 1) return local[0];
    const profile = path.join(runDir, 'profile');
    const portFile = path.join(profile, 'DevToolsActivePort');
    if (!popupConnection && existsSync(portFile)) {
      const debugPort = (await readFile(portFile, 'utf8')).split('\n')[0];
      popupConnection = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
    }
    if (popupConnection) {
      const remote = popupFrom(popupConnection.contexts().flatMap((context) => context.pages()));
      if (remote.length > 1) throw new Error(`expected one popup, found ${remote.length}`);
      if (remote.length === 1) return remote[0];
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const profile = path.join(runDir, 'profile');
  const portFile = path.join(profile, 'DevToolsActivePort');
  const localUrls = sessionContext.pages().map((page) => page.url());
  const remoteUrls = popupConnection
    ? popupConnection.contexts().flatMap((context) => context.pages()).map((page) => page.url())
    : [];
  let targets = [];
  try {
    const browser = sessionContext.browser();
    const cdp = await browser.newBrowserCDPSession();
    const listed = await cdp.send('Target.getTargets');
    targets = (listed.targetInfos || []).filter((target) => String(target.url).endsWith('/popup.html'));
    await cdp.detach().catch(() => {});
  } catch (error) {
    targets = [String(error)];
  }
  throw new Error(`toolbar popup did not open local=${JSON.stringify(localUrls)} remote=${JSON.stringify(remoteUrls)} portFile=${existsSync(portFile)} targets=${JSON.stringify(targets)}`);
}

async function triggerAction() {
  const browser = sessionContext.browser();
  if (!browser) throw new Error('Chromium has no browser session for Extensions.triggerAction');
  const cdp = await browser.newBrowserCDPSession();
  try {
    const listed = await cdp.send('Extensions.getExtensions');
    const extensions = Array.isArray(listed.extensions) ? listed.extensions : [];
    const match = extensions.filter((item) => item.id === extensionId);
    if (match.length !== 1) {
      throw new Error(`expected one extension ${extensionId}, got ${JSON.stringify(listed)}`);
    }
    const pageUrlNow = article.url();
    const targets = await cdp.send('Target.getTargets', { filter: [{ type: 'tab' }] });
    const infos = (targets.targetInfos || []).filter((target) => target.type === 'tab' && target.url === pageUrlNow);
    if (infos.length !== 1) {
      const summary = (targets.targetInfos || []).map((target) => ({ type: target.type, url: target.url }));
      throw new Error(`expected one tab for ${pageUrlNow}, found ${infos.length}: ${JSON.stringify(summary)}`);
    }
    await cdp.send('Extensions.triggerAction', { id: extensionId, targetId: infos[0].targetId });
  } finally {
    await cdp.detach().catch(() => {});
  }
}

async function openPopup() {
  await closePopup();
  await triggerAction();
  popup = await findPopup();
  popup.setDefaultTimeout(20000);
  attachLogs(popup, 'popup');
  await popup.waitForFunction((blocked) => {
    const heading = document.querySelector('h1')?.textContent;
    const status = document.getElementById('status');
    const save = document.getElementById('screenshotBtn');
    if (heading !== 'Full-page screenshot' || !status || !save) return false;
    if (status.textContent === blocked) return true;
    if (status.classList.contains('error')) return true;
    return status.textContent === '' && !save.disabled;
  }, blockedStatus);
  return readPopup();
}

async function waitForMarkers() {
  const heading = article.getByRole('heading', { name: 'Longform fixture page', exact: true });
  if (await heading.count() !== 1) throw new Error(`fixture heading matched ${await heading.count()} elements`);
  for (const id of ['longform-top', 'longform-sticky', 'longform-bottom']) {
    const locator = article.locator(`#${id}`);
    await locator.waitFor({ state: 'visible' });
    if (await locator.count() !== 1) throw new Error(`#${id} matched ${await locator.count()} elements`);
  }
}

async function gotoPage() {
  await article.goto(pageUrl, { waitUntil: 'domcontentloaded' });
  await waitForMarkers();
  targetScroll = 0;
  markerColor = await markerColors();
  const view = await readPage();
  if (view.scrollY !== 0) throw new Error(`fixture opened at scroll ${view.scrollY}`);
  if (view.top.text !== 'LONGFORM-TOP' || view.bottom.text !== 'LONGFORM-BOTTOM' || view.sticky.text !== 'LONGFORM-STICKY') {
    throw new Error(`fixture text changed: ${JSON.stringify(view)}`);
  }
  return view;
}

async function gotoBlank() {
  await article.goto('about:blank');
  if (article.url() !== 'about:blank') throw new Error(`blank page is ${article.url()}`);
  targetScroll = 0;
  markerColor = null;
  return { url: article.url() };
}

async function scrollTo(args) {
  if (!markerColor) throw new Error('scroll needs the fixture page');
  if (!/^\d+$/.test(args)) throw new Error(`bad scroll target ${args}`);
  const y = Number(args);
  await article.evaluate((value) => window.scrollTo(0, value), y);
  await article.waitForFunction((value) => window.scrollY === value, y);
  targetScroll = y;
  const shot = await article.screenshot();
  const sample = await samplePng(article, shot);
  const topFar = distance(sample.top, markerColor.top) > 150 && distance(sample.top, markerColor.bottom) > 150;
  const bottomFar = distance(sample.bottom, markerColor.top) > 150 && distance(sample.bottom, markerColor.bottom) > 150;
  if (!topFar || !bottomFar) {
    throw new Error(`viewport still shows a marker top=${JSON.stringify(sample.top)} bottom=${JSON.stringify(sample.bottom)} colors=${JSON.stringify(markerColor)}`);
  }
  return { scrollY: y, viewportTop: sample.top, viewportBottom: sample.bottom, viewport: { width: sample.width, height: sample.height } };
}

async function assertReady() {
  const view = await readPopup();
  const problems = [];
  if (view.heading !== 'Full-page screenshot') problems.push(`heading ${JSON.stringify(view.heading)}`);
  if (view.status !== '') problems.push(`status ${JSON.stringify(view.status)}`);
  if (view.saveText !== 'Save' || view.copyText !== 'Copy' || view.cancelText !== 'Cancel') problems.push('labels changed');
  if (view.saveDisabled || view.copyDisabled) problems.push('Save or Copy is disabled');
  if (!view.cancelHidden) problems.push('Cancel is visible');
  if (article.url() !== pageUrl) problems.push(`page is ${article.url()}`);
  if (problems.length) throw new Error(problems.join('; '));
  await button(saveName);
  await button(copyName);
  return view;
}

async function assertBlocked() {
  const view = await readPopup();
  const problems = [];
  if (view.status !== blockedStatus) problems.push(`status ${JSON.stringify(view.status)}`);
  if (view.statusClass !== 'status error') problems.push(`class ${JSON.stringify(view.statusClass)}`);
  if (!view.saveDisabled || !view.copyDisabled) problems.push('Save or Copy is enabled');
  if (/^https?:/i.test(article.url())) problems.push(`page is a regular url ${article.url()}`);
  if (problems.length) throw new Error(problems.join('; '));
  const save = await button(saveName);
  const copy = await button(copyName);
  if (await save.isEnabled() || await copy.isEnabled()) throw new Error('blocked buttons are enabled');
  return view;
}

async function assertRestored() {
  const view = await readPage();
  const problems = [];
  if (view.scrollY !== targetScroll) problems.push(`scrollY ${view.scrollY} wanted ${targetScroll}`);
  if (view.sticky.visibility !== 'visible' || view.sticky.inlineVisibility !== '') {
    problems.push(`sticky visibility ${view.sticky.visibility} inline ${JSON.stringify(view.sticky.inlineVisibility)}`);
  }
  if (view.top.visibility !== 'visible' || view.bottom.visibility !== 'visible') problems.push('a marker is hidden');
  if (view.top.text !== 'LONGFORM-TOP' || view.bottom.text !== 'LONGFORM-BOTTOM') problems.push('marker text changed');
  if (view.top.count !== 1 || view.sticky.count !== 1 || view.bottom.count !== 1) problems.push('a marker is not unique');
  if (problems.length) throw new Error(problems.join('; '));
  return view;
}

async function traceFrom(origin) {
  if (!popup || popup.isClosed()) return [];
  const trace = await popup.evaluate((started) => (window.__longformTrace || []).map((entry) => ({
    ms: entry.t - started,
    text: entry.text,
    className: entry.className,
  })), origin);
  return trace.slice(0, 40);
}

async function watchStatus() {
  await popup.evaluate(() => {
    const status = document.getElementById('status');
    window.__longformTrace = [];
    const push = () => {
      const last = window.__longformTrace.at(-1);
      const text = status.textContent;
      if (last && last.text === text && last.className === status.className) return;
      window.__longformTrace.push({ t: Date.now(), text, className: status.className });
    };
    push();
    new MutationObserver(push).observe(status, {
      attributes: true,
      attributeFilter: ['class'],
      characterData: true,
      childList: true,
      subtree: true,
    });
  });
}

async function waitForTerminal(expected) {
  await popup.waitForFunction((success) => {
    const status = document.getElementById('status');
    return status.textContent === success || status.classList.contains('error') || status.textContent === 'Cancelled.';
  }, expected, { timeout: 90000 });
  return readPopup();
}

async function save() {
  if (!markerColor) throw new Error('save needs the fixture page');
  const metrics = await article.evaluate(() => ({
    scrollY: window.scrollY,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    scrollHeight: document.documentElement.scrollHeight,
  }));
  const saveButton = await button(saveName);
  if (!(await saveButton.isEnabled())) throw new Error('Save is disabled');
  await watchStatus();
  const started = Date.now();
  const downloadPromise = popup.waitForEvent('download', { timeout: 90000 });
  await saveButton.click();
  const view = await waitForTerminal('Download started.');
  const captureMs = Date.now() - started;
  if (view.status !== 'Download started.' || view.statusClass !== 'status success') {
    throw new Error(`Save finished as ${JSON.stringify(view.status)} class ${JSON.stringify(view.statusClass)}`);
  }
  const download = await downloadPromise;
  const filename = download.suggestedFilename();
  if (!/^longform-capture-.*\.png$/.test(filename)) throw new Error(`unexpected download name ${filename}`);
  const pngPath = path.join(currentEvidence, 'capture.png');
  await download.saveAs(pngPath);
  const bytes = await readFile(pngPath);
  const ihdr = requirePng(bytes);
  const sample = await samplePng(popup, bytes);
  requireFullPage(sample, ihdr, metrics, markerColor);
  return {
    status: view.status,
    statusClass: view.statusClass,
    filename,
    bytes: bytes.length,
    png: sample,
    page: metrics,
    captureMs,
    trace: await traceFrom(started),
  };
}

async function copyCapture() {
  if (!markerColor) throw new Error('copy needs the fixture page');
  const metrics = await article.evaluate(() => ({
    innerHeight: window.innerHeight,
    scrollHeight: document.documentElement.scrollHeight,
  }));
  const copyButton = await button(copyName);
  if (!(await copyButton.isEnabled())) throw new Error('Copy is disabled');
  await watchStatus();
  const started = Date.now();
  await copyButton.click();
  const view = await waitForTerminal('Copied.');
  const captureMs = Date.now() - started;
  if (view.status !== 'Copied.' || view.statusClass !== 'status success') {
    throw new Error(`Copy finished as ${JSON.stringify(view.status)} class ${JSON.stringify(view.statusClass)}`);
  }
  await popup.context().grantPermissions(['clipboard-read']);
  const encoded = await popup.evaluate(async () => {
    const items = await navigator.clipboard.read();
    const item = items.find((candidate) => candidate.types.includes('image/png'));
    if (!item) return '';
    const blob = await item.getType('image/png');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    return btoa(binary);
  });
  if (!encoded) throw new Error('clipboard has no PNG');
  const bytes = Buffer.from(encoded, 'base64');
  const pngPath = path.join(currentEvidence, 'clipboard.png');
  await writeFile(pngPath, bytes);
  const ihdr = requirePng(bytes);
  const sample = await samplePng(popup, bytes);
  requireFullPage(sample, ihdr, metrics, markerColor);
  return {
    status: view.status,
    statusClass: view.statusClass,
    bytes: bytes.length,
    png: sample,
    captureMs,
    trace: await traceFrom(started),
  };
}

async function cancel() {
  const saveButton = await button(saveName);
  if (!(await saveButton.isEnabled())) throw new Error('Save is disabled');
  let sawDownload = false;
  const onDownload = () => { sawDownload = true; };
  popup.once('download', onDownload);
  await watchStatus();
  const started = Date.now();
  await saveButton.click();
  const cancelButton = popup.locator('#cancelBtn');
  if (await cancelButton.count() !== 1) throw new Error(`Cancel matched ${await cancelButton.count()} elements`);
  await cancelButton.waitFor({ state: 'visible', timeout: 15000 });
  const visible = popup.getByRole('button', { name: 'Cancel', exact: true });
  if (await visible.count() !== 1) throw new Error(`visible Cancel matched ${await visible.count()} elements`);
  await visible.click();
  const view = await waitForTerminal('Cancelled.');
  popup.off('download', onDownload);
  if (view.status !== 'Cancelled.' || view.statusClass !== 'status') {
    throw new Error(`Cancel finished as ${JSON.stringify(view.status)} class ${JSON.stringify(view.statusClass)}`);
  }
  if (sawDownload) throw new Error('Cancel produced a download');
  return { status: view.status, statusClass: view.statusClass, captureMs: Date.now() - started, trace: await traceFrom(started) };
}

async function shot(kind, name) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`bad screenshot name ${name}`);
  const page = kind === 'page' ? article : popup;
  if (!page || page.isClosed()) throw new Error(`no ${kind} is open`);
  const png = path.join(currentEvidence, `${name}.png`);
  const aria = path.join(currentEvidence, `${name}.aria.txt`);
  if (kind === 'page') await page.screenshot({ path: png });
  else await page.locator('body').screenshot({ path: png });
  const snapshot = await page.locator('body').ariaSnapshot();
  await writeFile(aria, `${snapshot}\n`);
  return { png: path.basename(png), aria: path.basename(aria) };
}

async function perform(action) {
  const { name, args } = splitAction(action);
  if (name === 'goto-page') return gotoPage();
  if (name === 'goto-blank') return gotoBlank();
  if (name === 'scroll') return scrollTo(args);
  if (name === 'open-popup') return openPopup();
  if (name === 'close-popup') { await closePopup(); return { closed: true }; }
  if (name === 'assert-ready') return assertReady();
  if (name === 'assert-blocked') return assertBlocked();
  if (name === 'assert-restored') return assertRestored();
  if (name === 'save') return save();
  if (name === 'copy') return copyCapture();
  if (name === 'cancel') return cancel();
  if (name === 'shot-page') return shot('page', args);
  if (name === 'shot-popup') return shot('popup', args);
  throw new Error(`unknown action ${action}`);
}

async function writeState(dir, actions, steps, error) {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'state.json'), `${JSON.stringify({
    actions,
    steps,
    error: error ? String(error.stack || error) : null,
  }, null, 2)}\n`);
  await writeFile(path.join(dir, 'console.txt'), `${logs.join('\n')}\n`);
}

async function runActions(dir, actions) {
  currentEvidence = dir;
  logs.length = 0;
  const steps = [];
  try {
    for (const action of actions) {
      const result = await perform(action);
      steps.push({ action, ...result });
    }
  } catch (error) {
    await writeState(dir, actions, steps, error);
    throw error;
  }
  await writeState(dir, actions, steps, null);
  const captured = steps.find((step) => Number.isFinite(step.captureMs));
  return captured ? captured.captureMs : null;
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const profile = path.join(runDir, 'profile');
  const chromiumPid = browserPid || browserPidFor(profile);
  const xvfbPid = xvfbProcess?.pid;
  await closePopup();
  if (sessionContext) {
    await Promise.race([
      sessionContext.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
  }
  await signal(chromiumPid, 'chrom');
  await signal(xvfbPid, display);
  httpServer?.close();
  await rm(sessionPath, { force: true });
}

function call(message) {
  return new Promise((resolve, reject) => {
    const socket = connect(controlPort, '127.0.0.1');
    let buffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('drive socket timed out'));
    }, 180000);
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      clearTimeout(timer);
      socket.end();
      resolve(JSON.parse(buffer));
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.write(`${JSON.stringify(message)}\n`);
  });
}

async function launch() {
  const started = Date.now();
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 20) fail(`Node ${process.versions.node} is below 20. Run mise install and use that Node.`);
  if (existsSync(sessionPath)) fail(`a session already exists at ${sessionPath}`);
  if (existsSync(`/tmp/.X11-unix/X${display.slice(1)}`)) fail(`display ${display} is already in use`);
  if (!existsSync(fixturePath)) fail(`missing fixture ${fixturePath}`);
  if (!existsSync(path.join(repoRoot, 'manifest.json'))) fail(`missing ${path.join(repoRoot, 'manifest.json')}`);
  await assertPortFree(port);
  await assertPortFree(controlPort);
  const manifest = JSON.parse(await readFile(path.join(repoRoot, 'manifest.json'), 'utf8'));
  if (manifest.name !== 'Longform') fail(`manifest name is ${manifest.name}`);
  const permissions = [...(manifest.permissions || [])].sort();
  if (JSON.stringify(permissions) !== JSON.stringify(['activeTab', 'clipboardWrite', 'scripting'])) {
    fail(`manifest permissions are ${permissions.join(', ')}. Load the unpacked repo, not the smoke bundle.`);
  }
  if (manifest.host_permissions?.length) {
    fail(`manifest has host permissions. Load the unpacked repo, not the smoke bundle.`);
  }
  const toolsMs = await ensureTools();
  await rm(path.join(runDir, 'profile'), { recursive: true, force: true });
  await mkdir(path.join(runDir, 'profile'), { recursive: true });
  const nonce = randomBytes(8).toString('hex');
  const profile = path.join(runDir, 'profile');
  process.on('SIGINT', () => { shutdown().finally(() => process.exit(0)); });
  process.on('SIGTERM', () => { shutdown().finally(() => process.exit(0)); });
  try {
    xvfbProcess = spawn('Xvfb', [display, '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
    const displaySocket = `/tmp/.X11-unix/X${display.slice(1)}`;
    const displayDeadline = Date.now() + 5000;
    while (!existsSync(displaySocket)) {
      if (Date.now() > displayDeadline) throw new Error(`Xvfb did not create ${displaySocket}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    httpServer = await startFixtureServer(nonce);
    sessionContext = await chromium.launchPersistentContext(profile, {
      headless: false,
      viewport: { width: 1000, height: 640 },
      deviceScaleFactor: 1,
      acceptDownloads: true,
      env: { ...process.env, DISPLAY: display },
      ignoreDefaultArgs: ['--disable-extensions'],
      args: [
        `--disable-extensions-except=${repoRoot}`,
        `--load-extension=${repoRoot}`,
        '--remote-debugging-port=0',
        '--force-device-scale-factor=1',
        '--force-color-profile=srgb',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-component-update',
        '--disable-sync',
        '--no-proxy-server',
      ],
    });
    browserPid = browserPidFor(profile);
    if (!browserPid) throw new Error(`could not find the Chromium process for ${profile}`);
    const session = {
      pid: process.pid,
      browserPid,
      xvfbPid: xvfbProcess.pid,
      display,
      port,
      controlPort,
      nonce,
      extensionId: '',
      extensionDir: repoRoot,
      version: manifest.version,
      pageUrl,
      ready: false,
    };
    await writeFile(sessionPath, `${JSON.stringify(session, null, 2)}\n`);
    article = sessionContext.pages()[0] || await sessionContext.newPage();
    article.setDefaultTimeout(20000);
    attachLogs(article, 'page');
    const workerPromise = waitForWorker();
    await gotoPage();
    const worker = await workerPromise;
    extensionId = new URL(worker.url()).host;
    worker.on('console', (message) => logs.push(`[worker] ${message.type()} ${message.text()}`));
    session.extensionId = extensionId;
    session.browserPid = browserPid;
    await writeFile(sessionPath, `${JSON.stringify(session, null, 2)}\n`);
    const popupStarted = Date.now();
    const popupView = await openPopup();
    if (popupView.status === blockedStatus) {
      throw new Error('popup has no activeTab grant on the fixture. Extensions.triggerAction did not invoke the toolbar action.');
    }
    if (popupView.status !== '' || popupView.saveDisabled || popupView.heading !== 'Full-page screenshot') {
      throw new Error(`launch popup heading=${JSON.stringify(popupView.heading)} status=${JSON.stringify(popupView.status)} saveDisabled=${popupView.saveDisabled}`);
    }
    await closePopup();
    const popupMs = Date.now() - popupStarted;
    const socketServer = createSocketServer((socket) => {
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk;
        if (!buffer.includes('\n')) return;
        const message = JSON.parse(buffer);
        buffer = '';
        handle(message)
          .then((response) => {
            socket.write(`${JSON.stringify(response)}\n`);
            if (message.op === 'cleanup') setImmediate(() => shutdown().finally(() => process.exit(0)));
          })
          .catch((error) => {
            socket.end(`${JSON.stringify({ ok: false, error: String(error.stack || error) })}\n`);
          });
      });
    });
    await new Promise((resolve, reject) => {
      socketServer.once('error', reject);
      socketServer.listen(controlPort, '127.0.0.1', resolve);
    });
    session.ready = true;
    await writeFile(sessionPath, `${JSON.stringify(session, null, 2)}\n`);
    const setupMs = Date.now() - started;
    console.log(`ready url=${pageUrl} extension=${extensionId} version=${manifest.version} save=enabled status=idle setup_ms=${setupMs} tools_ms=${toolsMs} popup_ms=${popupMs}`);
    await new Promise(() => {});
  } catch (error) {
    console.error(String(error.stack || error));
    if (logs.length) console.error(logs.slice(-20).join('\n'));
    await shutdown();
    process.exit(1);
  }

  async function handle(message) {
    if (message.op === 'doctor') {
      const counts = {};
      for (const id of ['longform-top', 'longform-sticky', 'longform-bottom']) {
        counts[id] = await article.locator(`#${id}`).count();
      }
      const workers = sessionContext.serviceWorkers().filter((worker) => worker.url().endsWith('/background.js'));
      return { ok: true, counts, pageUrl: article.url(), extensionId, workers: workers.length };
    }
    if (message.op === 'run') {
      const dir = evidenceDir(message.evidence);
      const actions = String(message.actions || '').split(',').map((item) => item.trim()).filter(Boolean);
      if (!actions.length) throw new Error('run needs actions');
      await mkdir(dir, { recursive: true });
      const captureMs = await runActions(dir, actions);
      return { ok: true, evidence: dir, captureMs };
    }
    if (message.op === 'cleanup') return { ok: true };
    throw new Error(`unknown op ${message.op}`);
  }
}

async function doctor() {
  if (!existsSync(sessionPath)) fail('no session. Launch first.');
  const session = JSON.parse(await readFile(sessionPath, 'utf8'));
  if (!session.ready) fail('launch has not printed ready');
  if (!alive(session.pid) || !cmdline(session.pid).includes('drive.mjs')) {
    fail(`session pid ${session.pid} is not drive.mjs`);
  }
  const response = await fetch(session.pageUrl);
  if (response.headers.get('x-longform-verify') !== session.nonce) fail('the port is not the verify server');
  const manifest = JSON.parse(await readFile(path.join(session.extensionDir, 'manifest.json'), 'utf8'));
  if (manifest.name !== 'Longform' || manifest.version !== session.version) {
    fail(`loaded manifest is ${manifest.name} ${manifest.version}`);
  }
  const live = await call({ op: 'doctor' });
  if (!live.ok) fail(live.error || 'doctor failed');
  if (live.extensionId !== session.extensionId) fail('extension id changed');
  if (live.pageUrl !== session.pageUrl) fail(`page is ${live.pageUrl}`);
  if (live.workers !== 1) fail(`background workers=${live.workers}`);
  if (live.counts['longform-top'] !== 1 || live.counts['longform-sticky'] !== 1 || live.counts['longform-bottom'] !== 1) {
    fail(`fixture counts ${JSON.stringify(live.counts)}`);
  }
  console.log(`doctor ok server=${session.pageUrl} page=${live.pageUrl} pid=${session.pid} port=${session.port} extension=${session.extensionId} version=${session.version} top=1 sticky=1 bottom=1`);
}

async function run(options) {
  const started = Date.now();
  if (!options.evidence || !options.actions) fail('run needs --evidence and --actions');
  const response = await call({ op: 'run', evidence: options.evidence, actions: options.actions });
  if (!response.ok) fail(response.error || 'run failed');
  const capture = Number.isFinite(response.captureMs) ? ` capture_ms=${response.captureMs}` : '';
  console.log(`pass evidence=${options.evidence} verify_ms=${Date.now() - started}${capture}`);
}

async function killSession() {
  const session = JSON.parse(readFileSync(sessionPath, 'utf8'));
  await signal(session.browserPid, path.join(runDir, 'profile'));
  await signal(session.xvfbPid, session.display);
  await signal(session.pid, 'drive.mjs');
  await rm(sessionPath, { force: true });
}

async function cleanup() {
  if (existsSync(sessionPath)) {
    const session = JSON.parse(readFileSync(sessionPath, 'utf8'));
    if (alive(session.pid)) await call({ op: 'cleanup' }).catch(() => {});
    if (existsSync(sessionPath)) await killSession();
  }
  await rm(runDir, { recursive: true, force: true });
  for (const name of evidenceNames) {
    console.log(`evidence .cursor/skills/verify-longform/evidence/${name}`);
  }
  console.log('cleanup ok');
}

const command = process.argv[2];
const options = parseArgs(process.argv.slice(3));
if (command === 'launch') await launch();
else if (command === 'doctor') await doctor();
else if (command === 'run') await run(options);
else if (command === 'cleanup') await cleanup();
else fail('usage: drive.mjs launch|doctor|run|cleanup');
