# Managed Capture Session Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture finite ordinary pages completely, restore them reliably, and provide simple Save/Copy actions with progress, cancellation, and interruption recovery.

**Architecture:** A reinjection-safe top-frame singleton owns the capture lifecycle and page transaction. A worker brokers guarded screenshots; the popup subscribes to session state and delivers verified PNGs from the extension origin. New components are tested independently before the final runtime cutover.

**Tech Stack:** Buildless classic JavaScript using the existing `Longform` namespace, Chromium Manifest V3, Node 24.19.0 test runner/VM, and the locked Playwright Core dependency. No new production dependencies.

**Spec:** [Approved managed capture design](../specs/2026-10-28-managed-capture-session-design.md). Read both documents before execution.

## Global Constraints

- Permissions remain `activeTab`, `scripting`, and `clipboardWrite`.
- Ordinary HTTP(S) documents with a finite root scrolling surface; preserve horizontal overflow and fractional-device-pixel support.
- No nested-scroller/virtualized-list/infinite-feed/iframe-interior traversal; fixed/sticky suppression remains documented.
- No backend, telemetry, persisted image history, framework migration, editor, preview, or settings screen.
- 120 seconds total active work; 10 seconds for any external operation; two consecutive stable layout samples 150ms apart; at most one complete retry.
- Retain at most one completed PNG per document for two minutes. Retry does not reset deadlines. Waiting in `ready-to-deliver` pauses the active-work budget, not the retention clock; resumed transfer consumes remaining active-work time. This separates the design's recovery TTL from its work deadline.
- Transfer chunks are at most 256KiB raw bytes; sequential acknowledgements; validate digest, order, length, and PNG data.
- Target cleanup initiation within 250ms of Cancel on a responsive page; no side effects from late continuations.
- Live-region section announcements at most once per second; Cancel target at least 44px; preserve themes, keyboard access, and reduced motion.
- Exact success copy: `Download started.` and `Copied.`; never claim verified disk completion.
- No runtime changes until execution is selected. At execution, apply the worktree skill, use an isolated checkout, and preserve unrelated user changes.

## Review Focus

These easily missed cases are assigned explicit tests below:

1. Popup disconnect exactly during delivery commit: show unknown outcome, never silently repeat (Tasks 1, 7, 8).
2. Switching away and back during a screenshot: discard the result even if active tab matches afterward (Tasks 5, 9).
3. Page code changes a touched inline property, including `!important`: preserve that newer change while restoring everything else (Task 2).
4. A retained PNG expires during reconnect/transfer: no stale delivery or revived TTL (Tasks 1, 7, 8).
5. Back-forward-cache restore with a suspended callback: page is restored and stale work cannot resume (Tasks 2, 6, 9).

## Files and responsibility map

| File | Responsibility |
| --- | --- |
| `capture-session.js` (new) | Singleton lifecycle, cancellation, budgets, snapshots, retention, delivery arbitration |
| `capture-page.js` | Reversible preparation transaction, root measurement, resource/layout stability |
| `capture-geometry.js` | Tile planning, actual draw rectangles, exact coverage union |
| `capture.js` | Bounded preparation traversal and validated capture attempts |
| `capture-broker.js` (new), `background.js` | Serialized, authenticated, generation-bound screenshot requests |
| `capture-transfer.js` (new) | Bounded PNG chunk producer/receiver; shared in popup and content |
| `capture-delivery.js` (new) | Popup-only artifact validation, save handoff, URL lifetime |
| `popup.js`, `popup.html`, `popup.css`, `clipboard.js` | Subscription, simple controls, progress, clipboard gesture, user-facing phrases |
| `protocol.js`, `content.js` | Versioned envelopes and reinjection-safe top-frame entry |
| `scripts/extension-files.mjs` | One release allowlist including each new runtime file |
| `tests/helpers/runtime.mjs` (new) | Reusable VM loader extracted from existing runtime tests |
| `tests/{session,page,coverage,broker,capture,transfer}.test.mjs` (new) | Deterministic behavioral contracts, fake clocks and delayed operations |
| `scripts/reliability-checks.mjs` (new) | Real-browser adversarial fixtures and orchestration |
| Existing smoke/popup scripts and docs | Integration, release parity, production-permission checks, updated product claims |

All filenames are repository-relative. Keep modules in closures and publish frozen
interfaces; keep mutable session data private. Extract the VM helper only when its
first new test needs it. Add new modules to the package allowlist when created,
but keep the current production entry until Task 8. New APIs may coexist with the
old wrappers temporarily; delete obsolete wrappers at cutover. Do not ship intermediate commits.

## Shared contracts

Use these names consistently; describe shapes with JSDoc, not a new type toolchain.

```js
// Session snapshot: no image bytes, URLs, page text, or arbitrary exception strings.
// { protocolVersion, documentId, sessionId, sequence, attempt, phase,
//   destination, section, sections, errorCode, canCancel, expiresAt,
//   deliveryOutcome }  // outcome: null | 'known' | 'unknown'
// phase: idle/preparing/capturing/validating/restoring/encoding/ready-to-deliver/
//        transferring/delivering/completed/cancelling/cancelled/failed/expired
// Rect: integer output-pixel half-open bounds {left, top, right, bottom}.
// CodedError: Error with .code, optional safe numeric diagnostics.
// SessionContext: {sessionId, documentId, attempt, signal, deadline,
//   checkpoint(), publish(patch), external(operation, code)}.
// checkpoint throws on cancellation, stale attempt, or spent work budget.
// external accepts a function returning Promise<T>; races cancellation and the
// lesser of 10s and remaining work time; callers fence late results.
```

Protocol v6: `longform-session:v6` port; `START`, `SNAPSHOT`, `CANCEL`,
`ARTIFACT_BEGIN`, `ARTIFACT_CHUNK`, `CHUNK_ACK`, `ARTIFACT_END`,
`COMMIT_DELIVERY`, `DELIVERY_RESULT`. Every non-handshake message contains
`documentId`, `sessionId`, and a request ID; state events carry monotonic sequence.
Artifact messages also carry a transfer ID and chunk index. Snapshot handshakes
return protocol/runtime versions and document identity before accepting commands.
Worker messages are `BROKER_HELLO`, `CAPTURE_TILE`, and
`DIGEST_BEGIN`/`DIGEST_CHUNK`/`DIGEST_END`, scoped to sender tab,
window, document, session, tile index, and worker generation. Never trust a
payload-supplied tab/window ID in place of browser sender data.

Dependencies: Tasks 1–5 establish tested components; Task 6 integrates 1–5;
Task 7 uses 1 and 6; Task 8 activates 1–7; Task 9 is the release gate.

---

### Task 1: Define protocol and a reinjection-safe session owner

**Files:** Create `capture-session.js`, `tests/session.test.mjs`, `tests/helpers/runtime.mjs`; modify `protocol.js`, `tests/runtime.test.mjs`, `scripts/extension-files.mjs`.

**Interfaces:** `Longform.sessions.install({run, now, schedule}) -> SessionOwner`
installs once per document/runtime version. `run(ctx) -> Promise<Blob>` owns capture
and cleanup, and only resolves after restoration. Owner methods:
`start({destination}) -> Snapshot`, `snapshot() -> Snapshot`,
`subscribe(fn) -> unsubscribe`, `cancel(sessionId) -> Snapshot`,
`artifact(sessionId) -> Blob`, `beginTransfer(sessionId, transferId) -> Snapshot`,
`commitDelivery(sessionId, transferId) -> boolean`,
`finishDelivery(sessionId, transferId, outcome) -> Snapshot`,
`disconnectTransfer(transferId) -> Snapshot`, `dispose(reason) -> void`.
`outcome` is `success`, `failed`, or `unknown`. Install returns the existing owner
without replacing its dependencies during an active session. Idle incompatible
versions still require reload rather than mixing old and new module instances.

- [ ] **1. Write behavioral tests**, using a controllable `run` promise and fake clock. Include tests named `duplicate start and reinjection share one run`, `cancel waits for cleanup`, `retention expires without renewal`, and `delivery arbitration is irreversible`. Key assertions:
  ```js
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(runCalls, 1);
  assert.equal(owner.commitDelivery(id, transferId), false); // cancel won
  assert.equal(owner.snapshot().phase, 'expired'); // at readyAt + 120000
  assert.equal(owner.snapshot().deliveryOutcome, 'unknown'); // commit then disconnect
  ```
  Add stale/duplicate message rejection, protocol mismatch, failed cleanup blocks
  start until reload, disconnect-before-commit returns ready, and one terminal event.
- [ ] **2. Run** `node --test tests/session.test.mjs`; expect missing session API assertions to fail, not syntax errors.
- [ ] **3. Implement the interfaces** and protocol envelope validators. Acquire ownership synchronously; use AbortController plus generation guards. Store original work-start/budget, pause only during ready-result retention, and apply a nonrenewing 120000ms TTL. Artifact expiry cancels uncommitted transfer; it cannot undo committed delivery. Make runtime timers and waits injectable for tests. Extract/reuse the VM helper without changing existing test assertions.
- [ ] **4. Run** `node --test tests/session.test.mjs tests/runtime.test.mjs`; expect all tests passing, including fake-clock 120000ms work timeout and 10000ms external timeout. Include new runtime file in package allowlist; keep old content entry active.
- [ ] **5. Commit** only this task's files: `feat: add managed capture session contracts`.

### Task 2: Make page preparation a reversible transaction

**Files:** Modify `capture-page.js`; create `tests/page.test.mjs` and `tests/fixtures/restoration-conflicts.html`.

**Interfaces:** `Longform.page.beginTransaction(ctx) -> PageTransaction` records
original scroll before mutation. Methods: `prepare() -> Promise<void>`,
`scrollTo(x,y) -> Promise<void>`, `restore() -> Promise<CleanupResult>`,
`restoreSync() -> CleanupResult`. Result: `{ok, conflicts, failures}` with safe
property/error identifiers only. Restoration is idempotent; failures are aggregated.
Retain `withPreparedState` as a tested adapter until Task 8.

- [ ] **1. Write tests** named `partial preparation unwinds`, `priorities and newer page edits survive`, `restore scroll before smooth policy`, `cleanup continues after one failure`, and `pagehide fences resumed callbacks`:
  ```js
  assert.equal(element.style.getPropertyPriority('visibility'), 'important');
  assert.equal(element.style.color, 'blue'); // unrelated live edit retained
  assert.equal(element.style.visibility, 'visible'); // newer page-owned edit
  assert.deepEqual(restoredPosition, originalPosition);
  assert.equal(cleanupCalls, 1); // restore + restoreSync + restore
  assert.equal(lateScrollCalls, 0);
  ```
- [ ] **2. Run** `node --test tests/page.test.mjs`; expect transaction behavior failures.
- [ ] **3. Implement the journal**: capture property presence/value/priority and the value installed by the extension; journal each successful mutation immediately. Use owned styles for scrollbars/animation suppression where possible. Restore layout-affecting changes, instant coordinates, then snap/scroll policies. Retain newer page-owned edits and report conflicts. Bound paint waits; synchronous pagehide cleanup must not depend on rAF. Explicitly test no double inverse actions.
- [ ] **4. Run** `node --test tests/page.test.mjs tests/runtime.test.mjs` and `node scripts/smoke.mjs --popup`; expect all passing and existing successful/failed captures restoring scroll/styles.
- [ ] **5. Commit** task files: `fix: make page preparation transactional`.

### Task 3: Prove coverage from actual drawn rectangles

**Files:** Modify `capture-geometry.js`; create `tests/coverage.test.mjs`; adjust existing geometry assertions only for added return data.

**Interfaces:** `drawCapture(context, bitmap, metrics, scrollX, scrollY) -> Rect|null`
returns the exact destination rectangle it drew. Add
`createCoverage({width,height}) -> {add(rect), result()}` where result is
`{complete, uncoveredArea, gaps}` in integer pixels. Preserve `getCapturePositions`
and `getCanvasSize`; remove tolerance-based completeness only at Task 6/8 cutover.

- [ ] **1. Write tests** for interior gaps, diagonal missing corners, overlapping tiles,
  clipped edges, fractional scales, and zero-size draws. Use an independent small
  pixel-grid oracle to compare union results on randomized bounded rectangles:
  ```js
  assert.equal(topAndBottom.result().complete, false);
  assert.equal(topAndBottom.result().uncoveredArea, 800 * 1800);
  assert.equal(diagonalTiles.result().complete, false);
  assert.equal(fullyTiled.result().uncoveredArea, 0);
  assert.deepEqual(actualUnion, pixelOracle);
  ```
- [ ] **2. Run** `node --test tests/coverage.test.mjs`; expect coverage API failures.
- [ ] **3. Implement a sweep over rectangle y-boundaries**, merging x intervals for
  each horizontal band. Keep only bounded gap diagnostics, but calculate the full
  uncovered area. Do not allocate a page-sized per-pixel mask in production.
  Return actual clipped draw bounds; explicitly round shared boundaries so there
  are no interior holes or out-of-canvas reads at fractional pixel ratios.
- [ ] **4. Run** `node --test tests/coverage.test.mjs tests/runtime.test.mjs`; expect
  exact oracle agreement and no image-size limit regressions.
- [ ] **5. Commit** task files: `fix: validate complete drawn capture coverage`.

### Task 4: Measure and stabilize the prepared root document

**Files:** Modify `capture-page.js`, `tests/page.test.mjs`; create fixtures
`tests/fixtures/clipped-descendant.html`, `finite-lazy-load.html`, and `unstable-page.html`.

**Interfaces:** Add `Longform.page.observeLayout(transaction, ctx) -> PageObserver`:
`measure() -> Metrics`, `sample() -> LayoutSample`,
`settleVisible() -> Promise<LayoutSample>`, `dispose() -> void`.
Metrics retains existing geometry field names; LayoutSample includes root size,
viewport, pixel ratio, actual scroll, visible resource readiness, and generation.
Generation ignores extension-owned changes and expected scroll commands, but
includes page content/layout changes. Task 6 owns traversal; observer owns local
settling and visible-resource checks.

- [ ] **1. Add tests** named `clipped descendant does not enlarge root`, `settles after two samples`,
  `visible image timeout is not success`, `page mutations invalidate generation`,
  and `extension mutations do not invalidate generation`:
  ```js
  assert.equal(metrics.pageHeight, 600); // 5000px child in clipped 100px parent
  assert.equal(sampleDelayMs, 150);
  assert.equal(stableSamplesRequired, 2);
  assert.equal(error.code, 'resource-timeout'); // unresolved visible image at 10000ms
  assert.ok(afterPageEdit.generation > before.generation);
  ```
  Cover root horizontal overflow, scrollbar reflow, broken images, CSS background
  image loading, and same-size text changes; offscreen/network analytics must not block settling.
- [ ] **2. Run** `node --test tests/page.test.mjs`; expect new measurement/stability cases failing.
- [ ] **3. Implement root-based measurement** after preparation, without the old
  unclipped descendant maximum. Combine DOM/resource observations with geometry
  samples; settle visible image elements and discoverable computed background
  images with bounded decode/load checks. Broken/opaque unreadable resources get
  a specific resource failure, not an infinite wait. Document that arbitrary
  canvas/video pixels remain outside atomic-snapshot guarantees.
- [ ] **4. Run** `node --test tests/page.test.mjs tests/runtime.test.mjs`; expect all
  passing. Browser counterparts of these fixtures are required in Task 9.
- [ ] **5. Commit** task files: `feat: stabilize finite root documents before capture`.

### Task 5: Guard screenshot requests against tab and worker changes

**Files:** Create `capture-broker.js`, `tests/broker.test.mjs`; modify `background.js`,
`protocol.js`, `scripts/extension-files.mjs`.

**Interfaces:** `Longform.broker.create({tabs, runtimeId, now, wait}) -> Broker`;
`hello(sender) -> {generation}`;
`capture(request,sender) -> Promise<{generation,tileIndex,dataUrl}>`;
`invalidate({tabId,windowId}) -> void`; `digestMessage(request,sender) -> Promise<DigestReply>`
accepts bounded begin/chunk/end messages and returns acknowledgement or SHA-256.
Request carries document/session IDs,
tile index, and expected worker generation. Only top-frame content senders are
accepted. `background.js` imports this module and wires activation/navigation/removal events.

- [ ] **1. Write tests** named `switch away and back invalidates in flight tile`,
  `forged sender is rejected`, `worker generation mismatch fails`, and
  `two windows share capture rate limiter`:
  ```js
  assert.equal(error.code, 'target-changed');
  assert.equal(tabsUpdateCalls, 0); // never steal focus
  assert.equal(error.code, 'worker-interrupted');
  assert.ok(captureTimes[1] - captureTimes[0] >= 600);
  assert.equal(maxConcurrentCaptures, 1);
  ```
  Include changed window, stale tile index, navigation while awaiting capture,
  quota rejection, digest chunk order/size/session mismatch, and digest expiry.
  A generation is new for each worker instance.
- [ ] **2. Run** `node --test tests/broker.test.mjs`; expect broker contract failures.
- [ ] **3. Implement serialized capture** with at least 600ms between calls, pre/post
  active-tab queries, and event-generation comparison. Authenticate browser sender
  data and reject missing top-frame/document identity. Retain the legacy handler
  only until Task 8; do not add `tabs` or host permissions. Never return a rejected
  screenshot's bytes to content.
- [ ] **4. Implement bounded source digesting in the worker**, using native Web Crypto
  in the extension origin. HTTP content scripts must not depend on `crypto.subtle`.
  Assemble one bounded artifact buffer per session (32MiB maximum), acknowledge
  chunks sequentially, hash on END, then clear buffers. Bind it to generation,
  document/session/transfer identity; expire stalled operations after 10000ms and
  enforce the shared estimated memory ceiling across concurrent digest buffers.
  Popup independently computes the received digest in its extension context.
- [ ] **5. Run** `node --test tests/broker.test.mjs`; expect passing with no activation
  calls. Include the broker file in release packaging immediately.
- [ ] **6. Commit** task files: `fix: bind screenshot requests to the active document`.

### Task 6: Integrate bounded capture attempts with cancellation and cleanup

**Files:** Modify `capture.js`, `capture-session.js`; create `tests/capture.test.mjs`.

**Interfaces:** `Longform.capture.run(ctx) -> Promise<Blob>` consumes Tasks 2–5.
Add `Longform.capture.estimateWorkingBytes({canvasPixels,tilePixels,pngBytes}) -> number`
and central limits in protocol. Keep legacy `captureFullPage` until cutover.

- [ ] **1. Write tests** named `finite growth discards first attempt`,
  `second unstable attempt fails`, `all cancellation phases fence callbacks`,
  `worker interruption still restores page`, and `memory check precedes allocation`:
  ```js
  assert.equal(attempts, 2);
  assert.equal(deliveredTilesFromAttempt1, 0);
  assert.equal(error.code, 'unstable-page');
  assert.ok(cleanupStartedAt - cancelAt <= 250);
  assert.equal(drawsAfterCancel, 0);
  assert.equal(originalScrollSnapshotCount, 1);
  assert.equal(canvasAllocations, 0); // budget rejection
  ```
  Run cancellation at preparation, settle, screenshot, validation, restoration,
  and encoding; delayed callbacks must close bitmaps and never resume scrolling.
- [ ] **2. Run** `node --test tests/capture.test.mjs`; expect orchestration failures.
- [ ] **3. Implement `run(ctx)`**: one transaction, bounded root traversal for lazy
  loading, frozen attempt metrics, guarded screenshot/draw/coverage, final stability
  validation, restoration, then PNG encoding. Use `finally` for all resources.
  Retry once only for layout/content instability; not user input, target change,
  timeout, resource failure, or incomplete coverage. User wheel/touch/scroll keys
  interrupt rather than being suppressed. Recheck checkpoint after every await.
  Encoding callbacks that arrive after cancellation discard results.
- [ ] **4. Add working-memory checks** with an initial 512MiB conservative estimated
  budget and 32MiB encoded PNG cap (builder choices within spec). Estimate
  `12*canvasPixels + 8*tilePixels + 8*pngBytes + 16MiB`; reserve a worst-case PNG
  size before encoding, refine with actual size afterward, and reject when over
  budget. Reserve raw RGBA size plus PNG row/filter/chunk overhead; do not assume
  compressibility before encoding. Budget is an estimate, not a browser RSS guarantee.
  Measure against baseline fixtures in Task 9; a newly rejected near-limit fixture
  must explicitly expect `page-too-large`, no delivered PNG, and restored page state.
  Ordinary baseline fixtures must continue producing correct images.
- [ ] **5. Run** `node --test tests/*.test.mjs`; expect all passing, fake-clock
  deadlines preserved across retry, observer disposal, no PNG before restoration,
  and no revived operation after pagehide/pageshow.
- [ ] **6. Commit** task files: `feat: orchestrate cancellable validated capture sessions`.

### Task 7: Transfer artifacts and deliver exclusively in the popup

**Files:** Create `capture-transfer.js`, `capture-delivery.js`, `tests/transfer.test.mjs`;
modify `clipboard.js`, `scripts/extension-files.mjs`, `tests/runtime.test.mjs`.

**Interfaces:** `Longform.transfer.send(blob,{port,ctx,transferId}) -> Promise<void>`;
`receive({port,ctx,transferId,maxBytes}) -> Promise<Blob>`.
`Longform.delivery.save(blob,filename) -> {outcome:'started'}` only in an extension
document. `Longform.clipboard.copyBlobDuringGesture(getCommittedBlob) -> Promise<Outcome>`
initiates write synchronously; Outcome `{phrase,deliveryOutcome}`. Its callback
returns a Blob only after session commit succeeds. Keep old helper until Task 8.

- [ ] **1. Write tests** named `bounded chunks round trip exactly`, `corrupt stream rejected`,
  `disconnect requires explicit delivery retry`, `expired transfer never commits`,
  `clipboard write starts in original gesture`, and `save refuses page origin`:
  ```js
  assert.ok(Math.max(...rawChunkSizes) <= 256 * 1024);
  assert.equal(maxUnacknowledgedChunks, 1);
  assert.deepEqual(receivedBytes, originalBytes);
  assert.equal(error.code, 'transfer-failed'); // digest/order/length corruption
  assert.equal(automaticRetryCount, 0);
  assert.equal(clipboardWriteCalledBeforeFirstAwait, true);
  assert.equal(pageDocumentAnchorCount, 0);
  ```
  Include duplicate/reordered chunks, forged transfer/session ID, unsupported PNG,
  early clipboard rejection, Cancel before commit, and disconnect after commit.
- [ ] **2. Run** `node --test tests/transfer.test.mjs`; expect new delivery failures.
- [ ] **3. Implement bounded transfer and popup delivery**. Include SHA-256 in artifact
  metadata using Task 5's authenticated source-digest protocol; account both worker
  and popup digest buffers in the memory estimate. Test from an HTTP document with
  unavailable `crypto.subtle`, as well as HTTPS. Validate actual PNG decode
  and dimensions before commit. Limit transfer allocation before accepting chunks.
  Revoke popup URLs after a browser-tested handoff delay and on teardown; keep an
  explicit URL registry. Reject page-origin use; never insert image URLs into content DOM.
  Map failure/unknown outcome to session owner without losing a still-valid PNG.
- [ ] **4. Run** `node --test tests/transfer.test.mjs tests/runtime.test.mjs`; expect all
  passing. Preserve early-rejection waiting/cleanup semantics of existing Copy tests.
- [ ] **5. Commit** task files: `feat: isolate PNG transport and popup delivery`.

### Task 8: Activate session protocol and the progress/Cancel UI

**Files:** Modify `content.js`, `protocol.js`, `capture.js`, `background.js`, `popup.js`,
`popup.html`, `popup.css`, `clipboard.js`, `scripts/extension-files.mjs`,
`scripts/smoke.mjs`, `scripts/popup-checks.mjs`, `tests/phrases.test.mjs`,
`tests/runtime.test.mjs`, `tests/session.test.mjs`.

**Interfaces:** Content installs `Longform.sessions.install({run:Longform.capture.run,...})`
and routes v6 commands. Popup `connectSession(tabId) -> Promise<SessionClient>` with
`snapshot()`, `start(destination)`, `cancel()`, `artifact()`, `commit(transferId)`,
`result(transferId,outcome)`, `disconnect()`; asynchronous commands return snapshots
or artifacts through validated port responses. UI renderer consumes only Snapshot
plus browser clipboard capability and client connection state.

- [ ] **1. Extend popup/reinjection tests** for start/reopen/ready/expired/unknown
  states, snapshot ordering, and versions; update success expectation deliberately:
  ```js
  assert.equal(statusText, 'Download started.');
  assert.equal(reopened.sessionId, original.sessionId);
  assert.equal(captureCallsAfterRecoverySave, 1);
  assert.equal(cancelHeight >= 44, true);
  assert.equal(liveAnnouncementsInOneSecond <= 1, true);
  assert.equal(terminalEvents, 1);
  ```
  Include Save/Copy disabled while busy, visible Cancel until commit, stable labels,
  focus after Cancel, indeterminate preparation, and no complete progress before cleanup.
- [ ] **2. Run** `node --test tests/session.test.mjs tests/runtime.test.mjs tests/phrases.test.mjs`
  and `node scripts/smoke.mjs --popup`; expect new session/UI assertions to fail.
- [ ] **3. Cut over production atomically**: inject protocol, geometry, page, session,
  transfer, capture, then content. Popup loads protocol, transfer, delivery, clipboard,
  popup in dependency order. Remove content clipboard/download code and v5 capture
  handlers; old protocol requests fail with reload guidance. A pre-v6 active runtime
  cannot be safely adopted: detect existing legacy Longform runtime before replacing
  modules and require reload. Never claim old captures are protected by the new lock.
  Keep reinjection identical-version safe and protocol/package lists in parity.
- [ ] **4. Implement renderer and adapters** using exact design phrases, native progress,
  1000ms section-announcement throttling, and Cancel. Route expiration/unknown delivery
  to explicit recovery; new clicks on retained results do not recapture. Catch blocked
  HTTPS injection errors as blocked, not generic clipboard failures. Early clipboard
  rejection keeps capture progressing for recovery; closing a subscription never cancels it.
- [ ] **5. Update smoke harness delivery** to receive chunks and trigger download from
  its extension page. Await downloads on the extension delivery target, not the captured
  page. Keep actual toolbar UI assertions; verify protocol list matches package list.
- [ ] **6. Run** `node --test tests/*.test.mjs`, `node scripts/smoke.mjs --popup`, then
  `node scripts/smoke.mjs`; expect ordinary original fixtures and new popup checks passing.
  Update only the near-limit fixture's expected outcome if the measured conservative
  memory ceiling rejects it; assert no output and restoration instead of dropping the test.
- [ ] **7. Commit** task files: `feat: enable managed capture progress and cancellation`.

### Task 9: Prove adverse cases, production permissions, and release readiness

**Files:** Create `scripts/reliability-checks.mjs` and
`tests/fixtures/hostile-download.html`, `coverage-gaps.html`, `capture-interruption.html`;
modify `scripts/smoke.mjs`, `scripts/popup-checks.mjs`, `docs/architecture.md`,
`docs/product.md`, `docs/design.md`, `README.md`, `PRIVACY.md`, `privacy.html`,
`CONTRIBUTING.md`; update selected images under `docs/screenshots/`.

**Interfaces:** `runReliabilityChecks({browserContext,serviceWorker,baseUrl,artifactsDir})`
returns a structured assertion report and throws on failure. Wire into full smoke
after normal fixtures; fixtures use deterministic local resources, no external sites.
Production-manifest toolbar validation is a separate, explicitly recorded manual
check where the harness cannot grant a real toolbar gesture without extra permissions.

- [ ] **1. Add browser assertions** covering every design acceptance case, including
  the Review Focus list. Pin these assertions in the relevant scenario:
  ```js
  assert.equal(pageObservedScreenshotUrls.length, 0);
  assert.equal(pageReadScreenshotBytes, false);
  assert.equal(downloads.length, 1);
  assert.equal(wrongTabPixels, 0);
  assert.equal(interiorMissingPixels, 0);
  assert.deepEqual(await livePageState(), expectedRestoredState);
  assert.equal(bfcacheResumedCaptureCalls, 0);
  ```
  Exercise actual extension worlds, real PNGs, switch-away-and-back during a delayed
  screenshot, worker termination, navigation, shrinking pages, animation suppression,
  user scroll interruption, zoom/resize, visible lazy resources, retry exhaustion,
  unknown delivery, and post-expiry transfer. Tests must establish a gap is rejected
  rather than merely measuring output dimensions. Record baseline/new timing and
  estimated memory for all eight fixtures, including explanations for tradeoffs.
- [ ] **2. Run** `node scripts/smoke.mjs`; investigate failures before documentation or release claims.
- [ ] **3. Verify actual toolbar flows** in Chrome and Edge with the unchanged manifest:
  Save, Copy, Cancel, reopen in progress, recover finished PNG, blocked page, no extra
  permissions, and hostile-page delivery. Record browser/OS versions and outcomes in
  ignored artifacts. Run screen-reader announcement and keyboard checks. Missing
  Chrome execution is an unfulfilled acceptance check, not an Edge-equivalent pass.
- [ ] **4. Update docs and screenshots** to describe recovery TTL, cancellation boundary,
  ordinary-page scope, suppression limitations, secure delivery, deadlines, failure
  codes, and updated module ownership. Do not claim browser crashes are recoverable
  or downloads are confirmed on disk. No unrelated landing-page redesign.
- [ ] **5. Run** `mise run check` with working Chromium and documented ZIP utilities;
  expect unit, full browser, package-content, and unmodified-manifest release checks
  passing. On Windows configure `CHROMIUM_EXECUTABLE` explicitly when required.
  Missing `zip`/`unzip` is a setup blocker to resolve, not a reason to skip release
  checks or add a packaging rewrite. Inspect output PNGs, ensure allowlist excludes
  fixtures/docs/dependencies, and run `git diff --check`.
- [ ] **6. Commit** task files: `test: verify managed capture reliability and recovery`.

## Self-review and execution handoff

Spec coverage: lifecycle/retention/protocol -> 1, 8; page ownership/restoration -> 2;
complete coverage -> 3; resource/layout stability -> 4; tab/worker safety -> 5;
budgets/retry/cancellation -> 6; isolated delivery -> 7; UI/accessibility -> 8;
browser/permissions/docs/release -> 9. Review Focus tests are assigned explicitly.
Shared signatures and phase names above govern all tasks; adapters are temporary
and removed at cutover. No required design section is intentionally deferred.

This plan has been self-reviewed, not executed. Implementation requires the user's
choice of execution approach. Recommend subagent-driven execution with per-task
review: errors at lifecycle and delivery boundaries can corrupt pages or expose
images, and the explicit contracts make focused review useful. Native execution
with one final independent review remains an option. Neither choice authorizes
publishing a release, changing permissions, or silently expanding supported scope.
