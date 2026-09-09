# Capture architecture

Longform runs in three Chromium contexts. The popup owns user actions and clipboard writes. The content script owns the page and its capture canvas. The service worker captures the visible tab on request.

## Find the owner

| Change | Owner | Check |
| --- | --- | --- |
| Tile positions, pixel rounding, or canvas limits | `capture-geometry.js` | `mise run test:unit`, `mise run test:browser` |
| Document dimensions or temporary page styles | `capture-page.js` | `mise run test:browser` |
| Capture order, coverage diagnostics, or download delivery | `capture.js` | `mise run test:browser` |
| Message names or injected files | `protocol.js`, `content.js` | `mise run check` |
| Clipboard PNG decoding or write timing | `clipboard.js`, `popup.js` | `mise run test:unit`, `mise run test:popup` |
| Popup status or tab selection | `popup.js` | `mise run test:popup` |
| Browser screenshot API | `background.js` | `mise run test:browser` |
| Release contents | `scripts/extension-files.mjs` | `mise run test:release` |
| Landing page | `index.html`, `privacy.html`, `landing.css` | Inspect the page in Chromium |

## Script loading

The runtime uses classic scripts and one `Longform` namespace in each isolated browser context. Each module keeps helpers inside a closure. `protocol.js` declares content-script injection order. The popup loads its scripts through `popup.html`, and the worker imports the protocol with `importScripts`.

`content.js` replaces its owned message listener on reinjection. The current
`captureFullPage:v5` request distinguishes this runtime from old anonymous v4
listeners that may remain in an already-open page.

The extension loads directly from the repository root. There is no compilation step. Node tests evaluate the same runtime modules in an isolated context. Packaging and browser smoke setup share an explicit release allowlist.

## Capture data

A capture request contains `delivery` and an optional `filename`. Downloads stay in the content script. Clipboard requests return base64 because Chromium extension messages do not preserve Blob or ArrayBuffer objects.

`metrics` describes page and viewport dimensions in CSS pixels, the device pixel ratio, original scroll position, rendered bounds, and measured scroll limits. Geometry converts these values into canvas pixels. It retains a 160 CSS pixel overlap and includes the actual scroll limit as a candidate tile position.

Each capture owns its canvas, visited-position set, and diagnostics. The engine draws at actual scroll coordinates because Chromium may clamp requested positions. Diagnostics record requested counts, captured positions, duplicate skips, coverage, and artifact metadata. More than two uncovered CSS pixels at either edge causes failure instead of a partial PNG.

## Lifecycle contracts

The engine waits for two animation frames and 600 ms after each scroll. It hides fixed and sticky elements and root scrollbars while capturing. `capture-page.js` owns the `withPreparedState` callback and its `finally` block restores the page's inline styles and original scroll position on success or failure.

The popup starts `navigator.clipboard.write` during the click handler. The `ClipboardItem` receives a promise for the PNG Blob. Awaiting capture before starting the write loses the user gesture on browsers that require it.

The production permissions remain `activeTab`, `scripting`, and `clipboardWrite`. The browser test copy adds host access and `tabs` so automation can initiate captures. This does not verify Chromium's toolbar gesture grant for `activeTab`. The release check loads the unmodified packaged manifest and checks its restricted-page state.

## Verification evidence

`mise run check` runs the unit contracts, eight real capture fixtures, popup delivery and restoration checks, and the packaged extension check. Browser artifacts and JSON reports go to `artifacts/smoke/`. `mise run test:popup` runs only the toolbar popup checks.

For capture changes, inspect the saved PNGs as well as the report. Footer markers detect truncation, and the no-scrollbar fixture checks its right edge. A passing marker alone does not prove all pixels match. Use saved before-and-after captures when changing geometry or page preparation.
