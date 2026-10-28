import assert from 'node:assert/strict';
import test from 'node:test';
import { loadRuntime, flush, fakeClock } from './helpers/runtime.mjs';

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

async function layoutSetup() {
  const clock = fakeClock();
  const records = [];
  let observer;
  const rect = { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 };
  const element = (extra = {}) => ({ style: new Style(), getBoundingClientRect: () => rect, ...extra });
  const root = element({ scrollWidth: 800, scrollHeight: 600, clientWidth: 800, clientHeight: 600 });
  const body = element();
  const elements = [root, body];
  const listeners = new Map();
  const mutate = (record) => records.push(record);
  for (const node of elements) {
    const set = node.style.setProperty.bind(node.style);
    node.style.setProperty = (...args) => {
      set(...args);
      mutate({ type: 'attributes', target: node, attributeName: 'style' });
    };
  }
  const window = {
    innerWidth: 800, innerHeight: 600, devicePixelRatio: 1.25, scrollX: 0, scrollY: 0,
    getComputedStyle: (node) => ({ position: 'static', display: 'block', visibility: 'visible', ...node.computed }),
    addEventListener() {}, removeEventListener() {},
    scrollTo({ left, top }) { window.scrollX = left; window.scrollY = top; },
  };
  const document = {
    documentElement: root, scrollingElement: root, body,
    head: { append(node) { mutate({ type: 'childList', target: this, addedNodes: [node], removedNodes: [] }); } },
    querySelectorAll: () => elements,
    createElement: () => ({ textContent: '', remove() {} }),
    addEventListener(name, callback) { listeners.set(name, callback); },
    removeEventListener(name) { listeners.delete(name); },
  };
  const controller = new AbortController();
  const ctx = {
    attempt: 1, signal: controller.signal,
    checkpoint(attempt = this.attempt) {
      if (controller.signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
      if (attempt !== this.attempt) throw Object.assign(new Error('stale'), { code: 'stale-attempt' });
    },
    external: (operation) => operation(),
  };
  const backgrounds = [];
  const { page } = await loadRuntime(['capture-geometry.js', 'capture-page.js'], {
    window, document, Date: { now: clock.now },
    setTimeout(fn, delay) { return clock.schedule(fn, delay); }, clearTimeout(cancel) { cancel?.(); },
    requestAnimationFrame(fn) { queueMicrotask(fn); },
    MutationObserver: class {
      constructor(fn) { this.callback = fn; observer = this; }
      observe() {} takeRecords() { return records.splice(0); }
      disconnect() { this.disconnected = true; }
    },
    Image: class {
      complete = false; naturalWidth = 0;
      constructor() { backgrounds.push(this); }
    },
  });
  const tx = page.beginTransaction(ctx);
  return { page, tx, ctx, clock, root, body, elements, window, backgrounds, mutate, element, controller,
    get observer() { return observer; }, listeners };
}

test('clipped descendant does not enlarge root', async () => {
  const env = await layoutSetup();
  env.elements.push(env.element({ getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 5000, width: 800, height: 5000 }) }));
  const observer = env.page.observeLayout(env.tx, env.ctx);
  assert.equal(observer.measure().pageHeight, 600);
  assert.equal((await env.page.measure()).pageHeight, 600);
  observer.dispose();
});

test('settles after two samples', async () => {
  const env = await layoutSetup();
  assert.equal(env.page.sampleDelayMs, 150);
  assert.equal(env.page.stableSamplesRequired, 2);
  const observer = env.page.observeLayout(env.tx, env.ctx);
  let result;
  const pending = observer.settleVisible().then((sample) => { result = sample; });
  await env.clock.advance(149);
  assert.equal(result, undefined);
  await env.clock.advance(1);
  await pending;
  assert.equal(result.visibleResourcesReady, true);
  assert.equal(result.pixelRatio, 1.25);
  observer.dispose();
});

test('visible image timeout is not success', async () => {
  const env = await layoutSetup();
  env.elements.push(env.element({ tagName: 'IMG', src: 'pending.png', complete: false, naturalWidth: 0 }));
  const observer = env.page.observeLayout(env.tx, env.ctx);
  const result = assert.rejects(observer.settleVisible(), { code: 'resource-timeout' });
  await env.clock.advance(10000);
  await result;
  observer.dispose();
});

test('page mutations invalidate generation', async () => {
  const env = await layoutSetup();
  const observer = env.page.observeLayout(env.tx, env.ctx);
  const before = observer.sample();
  env.mutate({ type: 'characterData', target: { parentElement: env.body } });
  assert.ok(observer.sample().generation > before.generation);
  const generation = observer.sample().generation;
  env.root.scrollWidth = 1400;
  env.root.clientWidth = 785;
  env.window.innerWidth = 785;
  const changed = observer.sample();
  assert.equal(changed.pageWidth, 1400);
  assert.equal(changed.viewportWidth, 785);
  assert.ok(changed.generation > generation);
  observer.dispose();
});

test('extension mutations do not invalidate generation', async () => {
  const env = await layoutSetup();
  const observer = env.page.observeLayout(env.tx, env.ctx);
  const before = observer.sample();
  await env.tx.prepare();
  await env.tx.scrollTo(10.5, 20.25);
  const after = observer.sample();
  assert.equal(after.generation, before.generation);
  assert.equal(after.scrollX, 10.5);
  assert.equal(after.scrollY, 20.25);
  observer.dispose();
  assert.equal(env.observer.disconnected, true);
});

test('same-size page text adjacent to an owned write is retained', async () => {
  const env = await layoutSetup();
  const observer = env.page.observeLayout(env.tx, env.ctx);
  const before = observer.sample();
  env.mutate({ type: 'characterData', target: env.body });
  const write = env.root.style.setProperty.bind(env.root.style);
  env.root.style.setProperty = (...args) => {
    write(...args);
    env.mutate({ type: 'characterData', target: env.body });
  };
  await env.tx.prepare();
  assert.ok(observer.sample().generation >= before.generation + 2);
  observer.dispose();
});

test('a synchronous site style edit on the owned target is retained', async () => {
  const env = await layoutSetup();
  const observer = env.page.observeLayout(env.tx, env.ctx);
  const before = observer.sample();
  const write = env.root.style.setProperty.bind(env.root.style);
  env.root.style.setProperty = (...args) => {
    write(...args);
    write('color', 'red');
  };
  await env.tx.prepare();
  assert.ok(observer.sample().generation > before.generation);
  observer.dispose();
});

test('clipped images and unrelated network traffic do not block settling', async () => {
  const env = await layoutSetup();
  const parent = env.element({ computed: { overflow: 'hidden' },
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }) });
  env.elements.push(env.element({ tagName: 'IMG', complete: false, parentElement: parent,
    getBoundingClientRect: () => ({ left: 0, top: 200, right: 100, bottom: 300, width: 100, height: 100 }) }));
  const observer = env.page.observeLayout(env.tx, env.ctx);
  const pending = observer.settleVisible();
  env.listeners.get('load')({ target: { tagName: 'SCRIPT' } });
  await env.clock.advance(150);
  assert.equal((await pending).visibleResourcesReady, true);
  observer.dispose();
});

test('unreadable resources fail with a safe specific code', async () => {
  const env = await layoutSetup();
  env.body.getBoundingClientRect = () => { throw new Error('private URL'); };
  const observer = env.page.observeLayout(env.tx, env.ctx);
  await assert.rejects(observer.settleVisible(), { code: 'resource-unreadable', message: 'resource-unreadable' });
  observer.dispose();
});

test('cancelled decode continuations do not start resource work', async () => {
  const env = await layoutSetup();
  let decodes = 0;
  env.elements.push(env.element({ tagName: 'IMG', src: 'ready.png', complete: true, naturalWidth: 10,
    decode() { decodes++; return Promise.resolve(); } }));
  const observer = env.page.observeLayout(env.tx, env.ctx);
  observer.sample();
  env.controller.abort();
  await flush();
  assert.equal(decodes, 0);
  observer.dispose();
});

test('continuous same-size text mutations hit the layout bound', async () => {
  const env = await layoutSetup();
  const observer = env.page.observeLayout(env.tx, env.ctx);
  let active = true;
  const change = () => {
    if (!active) return;
    env.mutate({ type: 'characterData', target: env.body });
    env.clock.schedule(change, 50);
  };
  env.clock.schedule(change, 50);
  const result = assert.rejects(observer.settleVisible(), { code: 'layout-unstable' });
  await env.clock.advance(10000);
  await result;
  active = false;
  observer.dispose();
});

test('broken images and failed decode are resource failures', async () => {
  for (const image of [
    { complete: true, naturalWidth: 0 },
    { complete: true, naturalWidth: 20, decode: () => Promise.reject(new Error('private URL')) },
  ]) {
    const env = await layoutSetup();
    env.elements.push(env.element({ tagName: 'IMG', src: 'broken.png', ...image }));
    const observer = env.page.observeLayout(env.tx, env.ctx);
    const result = assert.rejects(observer.settleVisible(), { code: 'resource-failed' });
    await env.clock.advance(300);
    await result;
    observer.dispose();
  }
});

test('computed backgrounds settle while offscreen images do not block', async () => {
  const env = await layoutSetup();
  env.body.computed = { backgroundImage: 'url("background.png")' };
  env.elements.push(env.element({ tagName: 'IMG', complete: false,
    getBoundingClientRect: () => ({ left: 0, top: 700, right: 100, bottom: 800, width: 100, height: 100 }) }));
  const observer = env.page.observeLayout(env.tx, env.ctx);
  let settled = false;
  const pending = observer.settleVisible().then(() => { settled = true; });
  await env.clock.advance(150);
  assert.equal(settled, false);
  assert.equal(env.backgrounds.length, 1);
  env.backgrounds[0].complete = true;
  env.backgrounds[0].naturalWidth = 200;
  await env.clock.advance(300);
  await pending;
  assert.equal(settled, true);
  observer.dispose();
});

test('retry reuses original transaction and fences old scroll continuations', async () => {
  const env = await setup({ suspendedPaint: true });
  env.ctx.checkpoint = (attempt = env.ctx.attempt) => {
    if (attempt !== env.ctx.attempt) throw Object.assign(new Error('stale'), { code: 'stale-attempt' });
  };
  const tx = env.page.beginTransaction(env.ctx);
  const first = tx.prepare();
  env.resumePaint(); await flush(); env.resumePaint(); await first;
  const oldScroll = tx.scrollTo(100, 200);
  const rejected = assert.rejects(oldScroll, { code: 'stale-attempt' });
  env.sticky[0].style.setProperty('visibility', 'visible', 'important');
  const lateFixed = { style: new Style(), position: 'fixed' };
  env.sticky.push(lateFixed);
  env.ctx.attempt = 2;
  const preparing = tx.prepare();
  env.resumePaint(); await flush(); env.resumePaint(); await preparing;
  await rejected;
  assert.equal(env.nodes.length, 1);
  assert.equal(lateFixed.style.visibility, 'hidden');
  assert.equal(env.sticky[0].style.visibility, 'visible');
  assert.equal((await tx.restore()).ok, true);
  assert.equal(lateFixed.style.visibility, '');
  assert.equal(env.sticky[0].style.visibility, 'visible');
  assert.deepEqual([env.window.scrollX, env.window.scrollY], [17.5, 96.25]);
});

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
