import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

export async function loadContext(files, globals = {}) {
  const context = vm.createContext({
    Blob, Uint8Array, AbortController, atob, btoa, setTimeout, clearTimeout, ...globals,
  });
  context.globalThis = context;
  for (const file of ['protocol.js', ...files]) await inject(context, file);
  return context;
}

export async function inject(context, file) {
  vm.runInContext(await readFile(new URL(`../../${file}`, import.meta.url), 'utf8'), context, { filename: file });
}

export async function loadRuntime(files, globals = {}) {
  return (await loadContext(files, globals)).Longform;
}

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export const flush = () => new Promise((resolve) => setImmediate(resolve));

export function fakeClock() {
  let time = 0;
  let id = 0;
  const timers = new Map();
  return {
    now: () => time,
    schedule(fn, delay) {
      const key = ++id;
      timers.set(key, { fn, at: time + delay });
      return () => timers.delete(key);
    },
    async advance(ms) {
      const target = time + ms;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        time = next[1].at;
        timers.delete(next[0]);
        next[1].fn();
        await flush();
      }
      time = target;
      await flush();
    },
  };
}
