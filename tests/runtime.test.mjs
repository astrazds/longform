import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

async function loadRuntime(files, globals = {}) {
  const context = vm.createContext({ Blob, Uint8Array, atob, ...globals });
  for (const file of ['protocol.js', ...files]) {
    vm.runInContext(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'), context, { filename: file });
  }
  return context.Longform;
}

const { geometry } = await loadRuntime(['capture-geometry.js']);

test('tile planning covers both edges and retains the actual scroll limit', () => {
  assert.deepEqual([...geometry.getCapturePositions(2000, 720, 1280)], [0, 560, 1120, 1280]);
  assert.deepEqual([...geometry.getCapturePositions(2000, 720, 1300)], [0, 560, 1120, 1280, 1300]);
  assert.deepEqual([...geometry.getCapturePositions(400, 720, 0)], [0]);
  assert.deepEqual([...geometry.getCapturePositions(400, 720, 12)], [0, 12]);
});

test('canvas limits apply after device-pixel scaling', () => {
  const size = geometry.getCanvasSize({ pageWidth: 800, pageHeight: 1200, pixelRatio: 1.25 });
  assert.deepEqual({ ...size }, { width: 1000, height: 1500 });
  for (const metrics of [
    { pageWidth: 0, pageHeight: 100, pixelRatio: 1 },
    { pageWidth: 800, pageHeight: 16384, pixelRatio: 2 },
    { pageWidth: 20000, pageHeight: 20000, pixelRatio: 1 },
  ]) {
    assert.throws(() => geometry.getCanvasSize(metrics), /captureable area|too large/);
  }
});

test('the final tile is clipped to the canvas at its actual scroll position', () => {
  const calls = [];
  const context = { canvas: { width: 1280, height: 800 }, drawImage: (...args) => calls.push(args) };
  const bitmap = { width: 1280, height: 720 };
  const metrics = { pageWidth: 1280, pageHeight: 800, viewportWidth: 1280, viewportHeight: 720, pixelRatio: 1 };
  geometry.drawCapture(context, bitmap, metrics, 0, 560);
  assert.deepEqual(calls, [[bitmap, 0, 0, 1280, 240, 0, 560, 1280, 240]]);
  geometry.drawCapture(context, bitmap, metrics, 1280, 800);
  assert.equal(calls.length, 1);
});

test('fractional scroll coordinates use device pixels without crossing canvas edges', () => {
  const calls = [];
  const context = { canvas: { width: 875, height: 1000 }, drawImage: (...args) => calls.push(args) };
  const bitmap = { width: 800, height: 600 };
  const metrics = { pageWidth: 700, pageHeight: 800, viewportWidth: 640, viewportHeight: 480, pixelRatio: 1.25 };
  geometry.drawCapture(context, bitmap, metrics, 100.5, 400.5);
  assert.deepEqual(calls, [[bitmap, 0, 0, 750, 500, 125, 500, 750, 500]]);
});

test('clipboard payloads are decoded as PNG bytes and malformed payloads fail', async () => {
  const { clipboard } = await loadRuntime(['clipboard.js']);
  const blob = clipboard.pngBase64ToBlob('iVBORw0KGgo=');
  assert.equal(blob.type, 'image/png');
  assert.equal(Buffer.from(await blob.arrayBuffer()).toString('hex'), '89504e470d0a1a0a');
  assert.throws(() => clipboard.pngBase64ToBlob(''), /did not return image data/);
  assert.throws(() => clipboard.pngBase64ToBlob('aGVsbG8='), /invalid PNG/);
});

test('clipboard write starts before capture resolves', async () => {
  let resolveCapture;
  const capture = new Promise((resolve) => { resolveCapture = resolve; });
  let writtenItems;
  const { clipboard } = await loadRuntime(['clipboard.js'], {
    navigator: { clipboard: { write: (items) => { writtenItems = items; return Promise.resolve(); } } },
    ClipboardItem: class { constructor(data) { this.data = data; } },
  });
  const write = clipboard.copyPngBlobPromiseToClipboard(capture);
  assert.equal(writtenItems[0].data['image/png'], capture);
  resolveCapture(new Blob(['png']));
  await write;
});

test('upgrading and reinjecting the content entry uses the current capture exactly once', async () => {
  const listeners = new Set([
    (request, sender, reply) => {
      if (request.type === 'captureFullPage:v4') reply({ artifact: 'legacy' });
    },
  ]);
  const context = vm.createContext({
    window: { __longformContentScriptVersion: '2026-09-04-clipboard-base64-v2' },
    chrome: { runtime: { onMessage: {
      addListener: (listener) => listeners.add(listener),
      removeListener: (listener) => listeners.delete(listener),
    } } },
  });
  vm.runInContext(await readFile(new URL('../protocol.js', import.meta.url), 'utf8'), context);
  context.Longform.captureFullPage = async () => ({ artifact: 'current' });
  const entry = await readFile(new URL('../content.js', import.meta.url), 'utf8');
  vm.runInContext(entry, context);
  vm.runInContext(entry, context);
  const artifacts = [];
  for (const listener of listeners) {
    listener({ type: context.Longform.protocol.fullPageMessage }, {}, (response) => artifacts.push(response.artifact));
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(artifacts, ['current']);
});
