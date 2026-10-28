# Capture architecture

Longform uses classic scripts and a frozen `Longform` interface in each isolated
browser context. The top-frame content context owns the session and page
transaction. The popup subscribes to progress and owns Save/Copy delivery. The
service worker brokers authenticated screenshots and bounded digest operations.
The extension loads from the repository without compilation.

## Find the owner

| Change | Owner | Check |
| --- | --- | --- |
| Lifecycle, budgets, cancellation, retention, delivery arbitration | `capture-session.js` | `tests/session.test.mjs` |
| Reversible styles, root measurement, visible resources, stable layout | `capture-page.js` | `tests/page.test.mjs`, browser checks |
| Tile positions, fractional rounding, exact rectangle coverage | `capture-geometry.js` | `tests/geometry.test.mjs`, `tests/coverage.test.mjs` |
| Preparation traversal, bounded retry, capture, validation, encoding | `capture.js` | `tests/capture.test.mjs`, browser checks |
| Sender authentication, activation epochs, serialization, worker generation | `capture-broker.js`, `background.js` | `tests/broker.test.mjs`, browser checks |
| Versioned envelopes, injection order, singleton entry | `protocol.js`, `content.js` | `tests/runtime.test.mjs` |
| Acknowledged chunks, digest and PNG validation | `capture-transfer.js` | `tests/transfer.test.mjs` |
| Extension-origin Save handoff and Blob URL lifetime | `capture-delivery.js` | `tests/delivery.test.mjs`, browser checks |
| Subscription, phrases, gesture clipboard writes, controls | `popup.js`, `clipboard.js`, `popup.html`, `popup.css` | popup and unit checks |
| Release files | `scripts/extension-files.mjs` | packaged release check |
| Landing and privacy layout | `index.html`, `privacy.html`, `landing.css` | visual inspection |

## Session and page ownership

Protocol v6 uses the `longform-session:v6` port. The initial handshake supplies
runtime version and document identity. Commands and replies bind document,
session, request and transfer identities; progress has a monotonic sequence.
Reinjection attaches to the existing singleton. An incompatible runtime requires
a reload instead of replacing a busy owner.

The normal progression is preparing, capturing, validating, restoring, encoding,
ready-to-deliver, transferring, delivering, completed. Cancellation and failure
also restore the page before enabling reuse. Cleanup failure blocks reuse and
asks for a reload. Snapshots contain safe phase/count/code data, never image
bytes, page text or URLs.

One transaction journals each temporary property and its priority immediately
after mutation. It hides fixed/sticky elements and root scrollbars, disables
smooth scrolling, snapping and overflow anchoring, and pauses CSS animation and
transitions. Cleanup restores only declarations still owned by the transaction;
newer page writes, including `!important`, survive. Pagehide performs synchronous
cleanup. Pending callbacks are fenced so BFCache restoration cannot resume
stale capture work. Arbitrary page JavaScript, video and canvas drawing continue.
Preparation declarations and the owned stylesheet (including CSSOM rules) are
checked before retry, scrolling and layout validation. A changed invariant fails
safely while preserving newer site declarations. Cleanup verifies original
coordinates before restoring scroll policies, allowing live shrinkage and half
a device pixel of rounding; a mismatch blocks output and reuse.

## Capture and validation

The engine traverses the finite root scroll surface first, waiting for visible
images, CSS backgrounds and two stable layout samples 150ms apart.
Clipped descendants do not inflate root bounds. Root horizontal overflow and
fractional device pixels are supported; nested scrollers, virtualized lists,
infinite feeds and iframe interiors are outside this traversal.

Capture freezes geometry and resource generation, then draws real screenshots
at the actual scroll coordinates. Coverage is the exact union of integer output
rectangles: any interior or edge gap rejects the PNG. Layout changes allow one
complete retry within the original budget. Restoration precedes encoding.

The broker authenticates the browser sender's tab, window, frame and document.
It serializes screenshots, spaces them at least 600ms apart, checks the active
target before and after the native operation, and fences activation changes
even when the user switches away and back. A new worker generation interrupts
existing capture rather than continuing with uncertain ownership. User wheel,
touch and scrolling keys interrupt capture without suppressing the input.

Capture's `BROKER_HELLO` registers its content document/session against the
browser sender's document, tab and window and checks initial activity. The
session keeps that activation epoch across tile requests. On activation away,
the worker sends `CAPTURE_TARGET_LOST` only to that browser document; content
checks extension sender, protocol, worker generation and exact owner identity
before aborting. This also covers browsers reporting a visible inactive tab.
Content latches `visibilitychange` loss separately. Neither path resumes on
return. `BROKER_RELEASE` removes activity registration after capture settles
(including a late registration reply); document invalidation removes it too.

## Budgets and delivery

Active work is bounded to 120 seconds; each external operation to 10 seconds.
Waiting with a ready PNG pauses active work. Transfer resumes the remaining
work budget. A conservative 512MiB working-set estimate and 32MiB PNG cap reject
oversized captures. Estimates include canvas, native bitmap, PNG and transport
copies; they do not measure or guarantee browser RSS.

Capture uses the larger of its capture and encoding phase estimates:
`12*canvasPixels + max(32*tilePixels, 2*pngReserveBytes) + 16MiB`. The canvas
allowance includes native copies; the tile allowance covers two UTF-16 base64
screenshot strings, a tile PNG Blob and decoded bitmap. All tiles close before
encoding; PNG reservation includes uncompressed RGBA, row filters and conservative
stored-deflate/chunk/header overhead without assuming compression. The actual
encoded Blob must still fit 32MiB. Transfer has its own estimate after the runner
releases its canvas, so worker/popup copies do not overlap capture in this model.
If Cancel or timeout leaves native tile fetch/Blob/decode or encoding pending, a
new capture waits for it before preparing or allocating. The tile gate extends
through actual bitmap closure, including a late decoded result. That wait retains
the new session's Cancel, 10-second external bound and original work deadline;
a late callback cannot publish the abandoned image. This prevents overlapping native tile storage
and encoder snapshots across replacement captures.

The content owner retains at most one completed PNG per document in isolated
memory for two minutes. Closing the popup does not cancel capture. Reopening
attaches to progress or offers the retained image with a fresh Save/Copy click.
Expiry continues while disconnected or transferring and cannot revive the TTL.
Acknowledged delivery releases the image. Navigation, tab/browser closure or a
crash can lose the in-memory result; there is no persisted history.

Both destinations use sequential acknowledged chunks of at most 256KiB raw
bytes. The receiver validates order, length, digest and PNG data. Only the popup
creates a screenshot download URL and clicks the download anchor, so page DOM
listeners cannot fetch the screenshot or cancel Save. Copy starts the clipboard
write during the popup gesture and resolves its PNG promise after transfer.

Cancel remains available through transfer. The commit immediately before the
download handoff or clipboard promise resolution ends cancellation. A lost
acknowledgement at commit produces an unknown outcome and never silently repeats
delivery. The user may explicitly retry. Success says **Download started.** or
**Copied.**; Save does not confirm that bytes reached disk.
Clipboard acknowledgement is bounded to 10 seconds after the committed Blob
resolves and interrupted by owner termination or connection loss. A stalled
write becomes unknown and releases the gesture lock. Late native settlement
cannot update a recovery session or produce a second delivery result.

Safe failure codes distinguish `incomplete-coverage`, `unstable-page`, `preparation-changed`,
`resource-timeout`, `external-timeout`, `work-timeout`, `page-too-large`,
`target-changed`, `worker-interrupted`, `user-interrupted`, `cleanup-failed`,
`transfer-failed`, `delivery-unknown` and `artifact-expired`. The popup translates
these into short recovery instructions. No diagnostics are sent to a server.

## Verification

`mise run check` runs units, eight original browser fixtures, popup checks,
adverse reliability scenarios and packaged release checks. `--popup` runs the
popup subset; `node scripts/smoke.mjs --reliability` runs the reliability subset.
`LONGFORM_RELIABILITY_CASE` is a local regex filter for focused diagnosis; unset
it for the full gate. Reports and real PNGs are written to `artifacts/smoke/`,
which each browser invocation replaces. Preserve comparisons elsewhere.

The reliability harness injects test-only hooks into actual extension isolated
worlds, captures real PNGs, checks every interior pixel on a solid grid at
fractional scale, rejects a deliberately missing coverage receipt, uses local
lazy resources, stops the actual worker through CDP, and checks a genuine
persisted BFCache cycle. Fault hooks are absent from the package allowlist.
Browser reports identify timing and conservative memory estimates. A preserved
`artifacts/baseline/chrome-baseline.json` supplies local before/after comparisons.

The automated copy adds host access and `tabs` to let automation initiate
captures. Programmatic `chrome.action.openPopup()` exercises the real popup
document and adapters, but does not prove the production `activeTab` gesture.
The release check verifies allowlisted archive bytes and loads the unchanged
manifest with only `activeTab`, `scripting`, `clipboardWrite`.

Actual toolbar Save, Copy, Cancel, reopen, retained recovery, blocked-page and
hostile-page checks under that manifest must be recorded separately in Chrome
and Edge. Screen-reader speech also needs a manual check: live-region, focus,
target-size, theme and reduced-motion assertions alone do not prove speech.
See [CONTRIBUTING.md](../CONTRIBUTING.md) for the release checklist.
