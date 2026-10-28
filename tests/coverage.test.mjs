import assert from 'node:assert/strict';
import test from 'node:test';
import { loadRuntime } from './helpers/runtime.mjs';

const { geometry } = await loadRuntime(['capture-geometry.js']);
const plain = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const rect = (left, top, right, bottom) => ({ left, top, right, bottom });

test('top and bottom tiles cannot hide an interior gap', () => {
  const coverage = geometry.createCoverage({ width: 800, height: 2000 });
  coverage.add(rect(0, 0, 800, 100));
  coverage.add(rect(0, 1900, 800, 2000));
  assert.deepEqual(plain(coverage.result()), {
    complete: false, uncoveredArea: 800 * 1800, gaps: [rect(0, 100, 800, 1900)],
  });
});

test('diagonal tiles leave two missing corners despite touching every edge', () => {
  const coverage = geometry.createCoverage({ width: 10, height: 10 });
  coverage.add(rect(0, 0, 5, 5));
  coverage.add(rect(5, 5, 10, 10));
  assert.equal(coverage.result().complete, false);
  assert.equal(coverage.result().uncoveredArea, 50);
});

test('overlapping and clipped tiles count each canvas pixel only once', () => {
  const coverage = geometry.createCoverage({ width: 10, height: 10 });
  const tile = rect(-2, -2, 7, 12);
  coverage.add(tile);
  tile.right = 0; // The accumulator must own its recorded bounds.
  coverage.add(rect(5, -1, 12, 11));
  coverage.add(rect(20, 20, 30, 30));
  coverage.add(null);
  coverage.add(rect(0, 0, 0, 10));
  assert.deepEqual(plain(coverage.result()), { complete: true, uncoveredArea: 0, gaps: [] });
});

// This oracle marks individual pixels; it shares no sweep/interval logic.
function pixelOracle(width, height, tiles) {
  const missing = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!tiles.some((r) => x >= r.left && x < r.right && y >= r.top && y < r.bottom)) {
        missing.push(`${x},${y}`);
      }
    }
  }
  return missing.sort();
}

test('randomized bounded rectangle unions agree with an independent pixel oracle', () => {
  let seed = 751;
  const random = (max) => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % max; };
  for (let trial = 0; trial < 300; trial += 1) {
    const width = 1 + random(8);
    const height = 1 + random(7);
    const tiles = Array.from({ length: random(12) }, () => {
      const x = random(13) - 2;
      const y = random(12) - 2;
      return rect(x, y, x + random(9), y + random(8));
    });
    const coverage = geometry.createCoverage({ width, height });
    tiles.forEach((tile) => coverage.add(tile));
    const actual = plain(coverage.result());
    const expected = pixelOracle(width, height, tiles);
    assert.equal(actual.uncoveredArea, expected.length, `area at trial ${trial}`);
    assert.equal(actual.complete, expected.length === 0, `complete at trial ${trial}`);
    const gapPixels = actual.gaps.flatMap((r) => {
      const pixels = [];
      for (let y = r.top; y < r.bottom; y += 1) {
        for (let x = r.left; x < r.right; x += 1) pixels.push(`${x},${y}`);
      }
      return pixels;
    }).sort();
    assert.deepEqual(gapPixels, expected, `gap pixels at trial ${trial}`);
  }
});

test('gap diagnostics are bounded while area includes every missing pixel', () => {
  const coverage = geometry.createCoverage({ width: 1000, height: 1000 });
  for (let y = 1; y < 1000; y += 2) coverage.add(rect(0, y, 1000, y + 1));
  const result = coverage.result();
  assert.equal(result.uncoveredArea, 500000);
  assert.equal(result.complete, false);
  assert.ok(result.gaps.length > 0 && result.gaps.length <= 64);
});

test('actual drawn rectangles include bitmap and canvas clipping', () => {
  const calls = [];
  const context = { canvas: { width: 10, height: 10 }, drawImage: (...args) => calls.push(args) };
  const bitmap = { width: 10, height: 10 };
  const metrics = { pageWidth: 10, pageHeight: 10, viewportWidth: 10, viewportHeight: 10, pixelRatio: 1 };
  assert.deepEqual(plain(geometry.drawCapture(context, bitmap, metrics, -2, -3)), rect(0, 0, 8, 7));
  assert.deepEqual(calls, [[bitmap, 2, 3, 8, 7, 0, 0, 8, 7]]);
  assert.deepEqual(plain(geometry.drawCapture(context, bitmap, metrics, 8, 8)), rect(8, 8, 10, 10));
  assert.deepEqual(calls[1], [bitmap, 0, 0, 2, 2, 8, 8, 2, 2]);
  assert.equal(geometry.drawCapture(context, bitmap, metrics, 10, 10), null);
  assert.equal(geometry.drawCapture(context, { width: 0, height: 0 }, metrics, 0, 0), null);
  assert.equal(calls.length, 2);
});

test('fractional device ratios cover shared boundaries using only valid source pixels', () => {
  for (const pixelRatio of [1.25, 1.5, 1.75]) {
    const metrics = { pageWidth: 9, pageHeight: 9, viewportWidth: 3, viewportHeight: 3, pixelRatio };
    const size = geometry.getCanvasSize(metrics);
    const coverage = geometry.createCoverage(size);
    const bitmap = { width: Math.round(3 * pixelRatio), height: Math.round(3 * pixelRatio) };
    const context = { canvas: size, drawImage: (_, sx, sy, sw, sh, dx, dy, dw, dh) => {
      assert.ok(sx >= 0 && sy >= 0 && sx + sw <= bitmap.width && sy + sh <= bitmap.height);
      assert.ok(dx >= 0 && dy >= 0 && dx + dw <= size.width && dy + dh <= size.height);
    } };
    for (const y of [0, 3, 6]) {
      for (const x of [0, 3, 6]) coverage.add(geometry.drawCapture(context, bitmap, metrics, x, y));
    }
    assert.equal(coverage.result().uncoveredArea, 0, `ratio ${pixelRatio}`);
  }
});
