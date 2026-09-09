globalThis.Longform ||= {};
Longform.protocol = Object.freeze({
  viewportMessage: 'captureViewport',
  fullPageMessage: 'captureFullPage:v4',
  contentVersion: '2026-09-04-clipboard-base64-v2',
  contentFiles: Object.freeze([
    'protocol.js',
    'capture-geometry.js',
    'capture-page.js',
    'capture.js',
    'content.js',
  ]),
});
