import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

function flatten(text) {
  return text.replace(/\r\n/g, '\n').replace(/\n/g, ' ');
}

function boldSpans(text) {
  return [...flatten(text).matchAll(/\*\*([^*]+)\*\*/g)]
    .map((match) => match[1].replace(/\s+/g, ' ').trim());
}

function strongSpans(text) {
  return [...flatten(text).matchAll(/<strong>([^<]+)<\/strong>/gi)]
    .map((match) => match[1].replace(/\s+/g, ' ').trim());
}

function between(text, start, end) {
  const from = text.indexOf(start);
  assert.notEqual(from, -1, `missing ${start}`);
  const rest = text.slice(from + start.length);
  const until = rest.indexOf(end);
  assert.notEqual(until, -1, `missing ${end}`);
  return rest.slice(0, until);
}

function collectStrings(value, into) {
  if (typeof value === 'string') {
    into.add(value);
    return;
  }

  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) collectStrings(child, into);
  }
}

test('current popup labels are in the phrase table', async () => {
  const context = vm.createContext({ Blob, Uint8Array, atob, btoa });
  context.globalThis = context;
  const root = new URL('..', import.meta.url);
  const read = (path) => readFile(new URL(path, root), 'utf8');
  vm.runInContext(await read('protocol.js'), context, { filename: 'protocol.js' });
  vm.runInContext(await read('clipboard.js'), context, { filename: 'clipboard.js' });

  const owned = new Set();
  collectStrings(context.Longform.clipboard.phrases, owned);

  const readme = await read('README.md');
  const product = await read('docs/product.md');
  const design = await read('docs/design.md');
  const privacyHtml = await read('privacy.html');
  const index = await read('index.html');
  const listing = await read('webstore/listing.md');
  const privacyParagraphStart = privacyHtml.indexOf('<p>When you open Longform');
  const useNoteStart = index.indexOf('class="use-note"');
  const spans = [
    ...boldSpans(between(readme, '## Use', '## Privacy')),
    ...boldSpans(between(product, '## Current flows', '## Capture boundaries')),
    ...boldSpans(between(design, '## Popup', '## Landing page')),
    ...boldSpans(await read('PRIVACY.md')),
    ...strongSpans(privacyHtml.slice(privacyParagraphStart, privacyHtml.indexOf('</p>', privacyParagraphStart))),
    ...strongSpans(index.slice(useNoteStart, index.indexOf('</p>', useNoteStart))),
    ...boldSpans(listing.slice(0, listing.indexOf('## Historical version notes'))),
  ];

  assert.ok(spans.length > 0);
  for (const span of spans) {
    assert.equal(owned.has(span), true, span);
  }
  assert.equal(owned.has('Copy PNG'), false);
});
