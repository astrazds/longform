import assert from 'node:assert/strict';
import test from 'node:test';
import { loadRuntime, flush } from './helpers/runtime.mjs';

// A CSSOM boundary double: production reads and writes real declaration values,
// priorities, and presence. It does not replace any transaction behavior.
class Style {
  values = new Map();
  fail = null;
  get length() { return this.values.size; }
  item(index) { return [...this.values.keys()][index] || ''; }
  getPropertyValue(name) { return this.values.get(name)?.value || ''; }
  getPropertyPriority(name) { return this.values.get(name)?.priority || ''; }
  setProperty(name, value, priority = '') {
    if (this.fail?.(name, value)) throw new Error('private page data');
    this.values.set(name, { value, priority });
  }
  removeProperty(name) {
    if (this.fail?.(name, '')) throw new Error('private page data');
    this.values.delete(name);
  }
  get visibility() { return this.getPropertyValue('visibility'); }
  get color() { return this.getPropertyValue('color'); }
}

async function setup({ suspendedPaint = false, elements = 2 } = {}) {
  const root = { style: new Style() };
  const body = { style: new Style() };
  const sticky = Array.from({ length: elements }, () => ({ style: new Style(), position: 'fixed' }));
  const listeners = new Map();
  const nodes = [];
  const frames = [];
  const scrolls = [];
  let removes = 0;
  const window = {
    scrollX: 17.5, scrollY: 96.25,
    getComputedStyle: (element) => ({ position: element.position || 'static' }),
    addEventListener(name, callback) { listeners.set(name, callback); },
    removeEventListener(name, callback) { if (listeners.get(name) === callback) listeners.delete(name); },
    scrollTo(x, y) {
      if (typeof x === 'object') ({ left: x, top: y } = x);
      scrolls.push({ x, y, behavior: root.style.getPropertyValue('scroll-behavior'), snap: root.style.getPropertyValue('scroll-snap-type') });
      window.scrollX = x;
      window.scrollY = y;
    },
  };
  const document = {
    documentElement: root, body, scrollingElement: root,
    head: { append(node) { nodes.push(node); } },
    querySelectorAll: () => [root, body, ...sticky],
    createElement: () => ({ textContent: '', remove() { removes++; nodes.splice(nodes.indexOf(this), 1); } }),
  };
  const controller = new AbortController();
  const ctx = {
    signal: controller.signal, attempt: 1,
    checkpoint() { if (controller.signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' }); },
  };
  const { page } = await loadRuntime(['capture-geometry.js', 'capture-page.js'], {
    window, document,
    requestAnimationFrame(callback) {
      if (suspendedPaint) frames.push(callback);
      else queueMicrotask(callback);
      return frames.length;
    },
  });
  return { page, root, body, sticky, window, nodes, scrolls, ctx, controller,
    pagehide: () => listeners.get('pagehide')?.(),
    resumePaint() { for (const fn of frames.splice(0)) fn(); },
    get removes() { return removes; },
  };
}

test('partial preparation unwinds', async () => {
  const env = await setup();
  env.sticky[1].style.fail = (name) => name === 'visibility';
  assert.equal(typeof env.page.beginTransaction, 'function');
  const tx = env.page.beginTransaction(env.ctx);
  await assert.rejects(tx.prepare());
  env.controller.abort(); // cleanup must not call the cancelled checkpoint.
  const result = await tx.restore();
  assert.equal(result.ok, true);
  assert.equal(env.sticky[0].style.visibility, '');
  assert.equal(env.root.style.length, 0);
  assert.equal(env.nodes.length, 0);
  assert.deepEqual([env.window.scrollX, env.window.scrollY], [17.5, 96.25]);
});

test('a successful mutation is journaled before CSSOM verification can throw', async () => {
  const env = await setup();
  const style = env.sticky[0].style;
  let reads = 0;
  const originalRead = style.getPropertyPriority.bind(style);
  style.getPropertyPriority = (name) => {
    if (name === 'visibility' && ++reads === 2) throw new Error('page detail');
    return originalRead(name);
  };
  const tx = env.page.beginTransaction(env.ctx);
  await assert.rejects(tx.prepare());
  assert.equal((await tx.restore()).ok, true);
  assert.equal(style.visibility, '');
});

test('priorities and newer page edits survive', async () => {
  const env = await setup({ elements: 3 });
  const [old, changed, priorityChanged] = env.sticky;
  old.style.setProperty('visibility', 'collapse', 'important');
  const tx = env.page.beginTransaction(env.ctx);
  await tx.prepare();
  assert.equal(old.style.getPropertyPriority('visibility'), 'important');
  old.style.setProperty('color', 'blue');
  changed.style.setProperty('visibility', 'visible', 'important');
  priorityChanged.style.setProperty('visibility', 'hidden');
  const result = await tx.restore();
  assert.equal(old.style.visibility, 'collapse');
  assert.equal(old.style.getPropertyPriority('visibility'), 'important');
  assert.equal(old.style.color, 'blue');
  assert.equal(changed.style.visibility, 'visible');
  assert.equal(changed.style.getPropertyPriority('visibility'), 'important');
  assert.equal(priorityChanged.style.visibility, 'hidden');
  assert.equal(priorityChanged.style.getPropertyPriority('visibility'), '');
  assert.deepEqual([...result.conflicts], ['visibility']);
  assert.equal(result.ok, true);
});

test('legacy adapter retains the supplied original metrics position', async () => {
  const env = await setup();
  await env.page.withPreparedState({ scrollX: 7.5, scrollY: 80.25 }, async ({ scrollTo }) => {
    await scrollTo(400, 700);
  });
  assert.deepEqual([env.window.scrollX, env.window.scrollY], [7.5, 80.25]);
});

test('restore scroll before smooth policy', async () => {
  const env = await setup();
  env.root.style.setProperty('scroll-behavior', 'smooth', 'important');
  env.root.style.setProperty('scroll-snap-type', 'y mandatory', 'important');
  const tx = env.page.beginTransaction(env.ctx);
  await tx.prepare();
  await tx.scrollTo(500.5, 800.25);
  const result = await tx.restore();
  assert.equal(result.ok, true);
  assert.deepEqual(env.scrolls.at(-1), { x: 17.5, y: 96.25, behavior: 'auto', snap: 'none' });
  assert.equal(env.root.style.getPropertyValue('scroll-behavior'), 'smooth');
  assert.equal(env.root.style.getPropertyPriority('scroll-behavior'), 'important');
  assert.equal(env.root.style.getPropertyValue('scroll-snap-type'), 'y mandatory');
});

test('cleanup continues after one failure', async () => {
  const env = await setup();
  const tx = env.page.beginTransaction(env.ctx);
  await tx.prepare();
  env.sticky[1].style.fail = (name, value) => name === 'visibility' && value === '';
  const result = await tx.restore();
  assert.equal(result.ok, false);
  assert.deepEqual([...result.failures], ['visibility']);
  assert.equal(env.sticky[0].style.visibility, '');
  assert.equal(env.root.style.length, 0);
  assert.equal(env.nodes.length, 0);
  assert.equal(JSON.stringify(result).includes('private page data'), false);
  assert.equal(tx.restoreSync(), result);
  assert.equal(await tx.restore(), result);
  assert.equal(env.removes, 1);
  assert.equal(env.scrolls.length, 1);
});

test('pagehide fences resumed callbacks', async () => {
  const env = await setup({ suspendedPaint: true });
  const tx = env.page.beginTransaction(env.ctx);
  const preparing = tx.prepare();
  const preparationRejected = assert.rejects(preparing, { code: 'page-restored' });
  env.pagehide();
  assert.equal(env.nodes.length, 0);
  assert.equal(env.root.style.length, 0);
  env.resumePaint();
  await preparationRejected;
  await assert.rejects(tx.scrollTo(99, 999), { code: 'page-restored' });
  await flush();
  assert.equal(env.scrolls.length, 1); // only the synchronous restoration
  assert.equal(env.removes, 1);
});

test('paint waits are bounded when animation frames stop', async () => {
  const env = await setup({ suspendedPaint: true });
  const tx = env.page.beginTransaction(env.ctx);
  await tx.prepare();
  await tx.scrollTo(20, 30);
  assert.equal((await tx.restore()).ok, true);
});

for (const fails of [false, true]) {
  test(`legacy adapter restores after ${fails ? 'failed' : 'successful'} capture`, async () => {
    const env = await setup();
    const capture = env.page.withPreparedState({ scrollX: 17.5, scrollY: 96.25 }, async ({ scrollTo }) => {
      await scrollTo(400, 700);
      if (fails) throw new Error('capture failed');
      return 'image';
    });
    if (fails) await assert.rejects(capture, /capture failed/);
    else assert.equal(await capture, 'image');
    assert.deepEqual([env.window.scrollX, env.window.scrollY], [17.5, 96.25]);
    assert.equal(env.root.style.length, 0);
    assert.equal(env.sticky[0].style.visibility, '');
    assert.equal(env.nodes.length, 0);
  });
}
