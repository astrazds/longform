# Managed capture session

Date: 2026-10-28

Status: Draft for approval; approach selected, detailed design not yet approved.

Reviewed baseline: `3e9ee0269d71ba3b86d7f58c60cc604c94ada6b2`.

## Intent and agreed scope

Reliability is the priority: capture ordinary pages consistently, detect missing
content, and leave the page usable after every operation. Keep the existing
Save and Copy actions. Add progress and Cancel while capturing.

The user selected a managed capture session after considering the alternatives
below. This document specifies the proposed behavior and technical boundaries;
it does not authorize implementation. This is a contained project spanning
capture, messaging, delivery, UI, and regression coverage.

## Approaches

| Approach | Benefit | Cost / limitation | Decision |
| --- | --- | --- | --- |
| Targeted fixes | Smallest patch for locking, measurement, coverage, and cleanup | Leaves interruption and retries spread across modules | Not selected |
| Managed capture session | One owner for preparation, capture, validation, cancellation, and cleanup | Requires coordinated changes across contexts | Selected: best fit for reliability with a simple UI |
| Broad capture support | Could support nested scrollers and virtualized applications | Much larger scope and ambiguous completeness rules | Deferred |

## Goals, boundaries, and anti-goals

- Ordinary HTTP(S) documents with a finite root scrolling surface, including
  horizontal overflow and finite lazy-loaded content that settles within budget.
- Reject incomplete or unstable captures instead of delivering plausible partial PNGs.
- Preserve local-only operation, buildless JavaScript, and the existing permissions:
  `activeTab`, `scripting`, and `clipboardWrite`.
- No editor, preview screen, settings panel, capture history, backend, telemetry,
  persistent host permission, or silent permission expansion.
- No traversal of independently scrolling containers, virtualized lists, infinite
  feeds, or iframe interiors. Iframes contribute only their rendered visible area.
- Existing fixed/sticky suppression remains in this phase. Completeness means the
  prepared root document, excluding those deliberately suppressed elements; this
  limitation must be stated in product documentation, not hidden by an absolute claim.
- Do not fight user scrolling, switch tabs back automatically, or freeze arbitrary
  page JavaScript. Do not promise an atomic snapshot of videos or continuously
  changing applications.

## User experience

Keep the current compact layout, typography, themes, button labels, and accessible
names. No new normal-path step: choosing Save or Copy starts capture and delivers
when ready if that popup remains connected.

| Situation | Feedback and controls |
| --- | --- |
| Ready | Save and Copy enabled; no progress or Cancel |
| Preparing | Both actions disabled; “Preparing page…” and Cancel |
| Capturing | Both actions disabled; “Capturing section 3 of 12…” and Cancel |
| One allowed restart | “Page changed. Retrying…” and Cancel; section count restarts explicitly |
| Restoring / encoding / transferring | Named phase; actions disabled; Cancel remains available until delivery commits |
| Cancelling | “Cancelling…”; Cancel disabled; actions remain disabled until cleanup finishes |
| Cancelled | “Cancelled.”; actions enabled after cleanup; no image delivered |
| Disconnected popup, capture still running | Reopening attaches to that session and displays its current progress |
| Disconnected popup, capture finished | “Capture ready. Choose Save or Copy.”; those buttons deliver the retained image |
| Save handed to browser | “Download started.”; do not claim that a file has reached disk |
| Copy acknowledged by clipboard API | “Copied.” |
| Failure | Specific short explanation and recovery action; no automatic repeated retries |

Use the existing polite live region with throttled section announcements (at most
once per second), plus an accessible progress element where counts are known.
Preparation and encoding are indeterminate. Progress never reaches completion
before validation and cleanup. Cancel is keyboard reachable with a 44px target;
restore sensible focus when it disappears. Preserve reduced-motion behavior.

### Proposed details for approval

Closing the popup does not itself cancel capture. Capture continues only while
the target document stays active and within its deadline. Reopening reconnects;
if completion occurred while closed, a fresh Save/Copy click finishes delivery.
This extra click is limited to interruption recovery and preserves the three
permissions. A lost popup cannot reliably finish its earlier clipboard gesture.

Retain at most one completed PNG per document, in isolated-world memory, for two
minutes. An undelivered or delivery-failed result may be saved or copied without
recapturing. After acknowledged delivery, release it and return to ordinary
capture behavior. On expiry, report that the capture expired and allow a new one.
No disk persistence or retained browsing history is introduced.

## Ownership and state

The top-frame content context owns the session and the page mutation transaction.
It survives popup closure and repeated script injection in the same document.
Create the singleton only if absent; reinjection must not reset a lock, active
callbacks, session data, or cleanup journal. A different runtime version must
refuse replacement while busy and ask for a page reload after safe cleanup.

The popup is a subscriber and the owner of user-gesture clipboard delivery and
extension-origin download delivery. The worker is a screenshot broker, not the
owner of page cleanup or the sole source of capture state.

Each session has an unpredictable ID, a document-instance ID, an attempt number,
monotonic event sequence, phase, destination intent, cancellation flag, deadline,
metrics, coverage data, and resource handles. Each screenshot request additionally
has a tile sequence and worker-generation identifier.

Normal state progression:

`idle -> preparing -> capturing -> validating -> restoring -> encoding -> ready-to-deliver -> delivering -> completed`

Failure or cancellation from any pre-delivery phase goes through cleanup before
its terminal state. A retry clears the canvas and coverage and restarts measurement
inside the same transaction, preserving the original pre-session page snapshot.
The lock is acquired synchronously before the first await or DOM mutation and
remains held until all cleanup and outstanding side effects have been fenced.
A duplicate start returns the current session snapshot, never queues a capture.
An undelivered ready image is a session result, not permission to start new work.

Terminal events are emitted once. Late results from old attempts or cancelled
sessions are discarded and their resources released. A cleanup failure prevents
success and prevents another capture against an uncertain document until reload.

## Messaging and screenshot isolation

Version the protocol. Define start, query/subscribe, cancel, progress/snapshot,
artifact-transfer, acknowledgement, and terminal messages centrally in
`protocol.js`. Use a top-frame-only port for popup subscription and chunk transfer;
reconnection begins with an authoritative snapshot rather than replay assumptions.
Port loss ends a subscription, not the session.

Validate sender extension identity, top frame, document/session IDs, message shape,
sequence, and payload limits. Do not expose a page-world postMessage bridge.
Use browser-provided sender tab/window IDs rather than trusting payload IDs.

The worker serializes screenshot calls across the extension and respects the
browser's capture quota. Before and after a screenshot, verify the target is
still the active tab in the intended window. Invalidate an in-flight result if
tab activation/navigation events occurred, even if the user switched away and
back. Never activate the target automatically. Content also checks scroll position,
viewport, pixel ratio, and visibility around every screenshot before accepting it.

A worker-generation change, missing response, navigation, or lost target makes
the attempt fail safely; do not reconstruct an uncertain in-flight capture after
worker restart. Content-owned cleanup still runs. Worker memory is not durable.

## Page preparation and restoration

Acquire the session lock before measuring: measurement itself scrolls the page.
Record original coordinates before any probe. Every mutation immediately adds an
inverse action to an idempotent cleanup journal, including partial preparation.

Track only touched properties, their previous presence, value, and CSS priority;
never restore an entire stale style attribute over unrelated page changes. Prefer
an extension-owned stylesheet where possible. If page code concurrently changes a
touched property, preserve its newer value instead of blindly overwriting it and
record the conflict. Fail the attempt if capture assumptions no longer hold.

Temporarily enforce instant root scrolling, disable root scroll snapping and
anchoring, suppress fixed/sticky elements, and pause controllable CSS animations.
Identify newly introduced fixed/sticky elements during a retry. Hide scrollbars
before measuring the prepared document so reflow is part of the measured layout.

Cleanup attempts every inverse action even if one fails. Remove capture-only
layout changes, restore the original coordinates while instant scrolling and
snap suppression still apply, confirm the resulting position, then restore those
scroll policies. Allow clamping only when the live page genuinely shrank. Never
wait indefinitely for animation frames in a hidden document. Pagehide performs
synchronous best-effort cleanup, including documents entering the back-forward cache.
Navigation destroys the old session; a new document never inherits its result.

Guarantee cleanup for a live, responsive document. Browser/renderer termination
cannot be repaired by extension code; documentation must not promise otherwise.

## Measurement, stability, and complete coverage

Measure the prepared root scrolling surface using root/client dimensions and
verified scroll extents. Do not inflate it with unclipped descendant rectangles.
Any rendered-bounds fallback must account for ancestor clipping and have a fixture.
Preserve existing horizontal-overflow and fractional-device-pixel support.

For finite lazy loading, perform a bounded preparation traversal before the final
capture plan. Wait for relevant visible images to load/decode and for layout to
settle at each position; do not require global network idle. Check cancellation
between steps. A timed-out resource or continuously growing page produces a clear
failure rather than a successful image of placeholders.

Proposed starting limits: 120 seconds total, 10 seconds for any external operation,
two consecutive stable layout samples 150ms apart, and at most one complete retry.
The builder may tune sample timing using fixtures; increasing total/retry budgets
is a product change. Resource and total deadlines also cover preparation and transfer.

Freeze document dimensions, viewport, pixel ratio, and layout generation for each
capture attempt. Detect relevant layout/content changes with measurements,
observers, and visible-resource readiness. Ignore extension-owned preparation
mutations. Growth, shrinkage, resize, zoom, or changed content invalidates the
attempt; discard all tiles and retry once if eligible. Recheck at the end. Explain
that these checks are conservative, not a proof that arbitrary script-driven
pixels never changed.

Draw only verified screenshots at their actual stable coordinates. Derive coverage
from the rectangles actually drawn in output pixels, not from requested scroll
positions or separate maximum x/y values. Validate the union across the entire
canvas: diagonal captures must not disguise missing corners, and top/bottom
captures must not disguise interior gaps. No interior missing pixels are acceptable;
boundary rounding must be explicitly accounted for by clipping and device-pixel
conversion rather than a blanket two-CSS-pixel exemption.

Scroll snapping or page handlers that prevent required coverage produce an
incomplete-capture error. Always validate current dimensions and coverage before
encoding. Retain current canvas dimension/area ceilings and add a conservative
working-memory budget covering canvas, decoded tile, PNG, and transfer buffers.
Check that budget before allocation; fail clearly on exhaustion rather than crash.

## Cancellation and delivery

Cancel marks the session immediately and wakes interruptible waits. Stop issuing
scroll/screenshot operations, reject the pending clipboard image promise, discard
the artifact, and run cleanup. Uncancellable browser calls may finish later but
cannot draw, deliver, or mutate the restored page. Fence every asynchronous
continuation by session/attempt state. Target cleanup initiation within 250ms of
Cancel on a responsive page; test with delayed screenshot and encoding callbacks.

Capture and cleanup complete before the popup obtains a deliverable image. The
content context must never create a screenshot Blob URL, anchor, DOM attribute,
or page event containing image data. Transfer binary PNG data as bounded base64
chunks over extension messaging, with sequential acknowledgements and declared
byte count. Decode incrementally in the popup, validate order, length, PNG type,
and a digest, and discard malformed or stale streams. A proposed 256KiB raw chunk
keeps individual messages small; cap total bytes against the memory budget.

Save creates a Blob URL and temporary anchor inside the extension popup document.
The page has no access to that document. Revoke URLs after handoff with a tested
delay and on teardown; release transfer buffers promptly. Without a downloads
permission, report “Download started.” rather than verified disk completion.

Copy continues to call clipboard.write during the original click, using a promise
that resolves only after validation and restoration. Do not defer initiating the
clipboard write until capture finishes. On popup loss or early clipboard failure,
retain a valid finished image for a fresh Save/Copy gesture within its TTL.

Define a delivery commit boundary: before invoking the save anchor or resolving
the clipboard image promise, arbitrate Cancel against delivery and transition to
delivering. Cancel is then removed/disabled; already handed-off downloads and
clipboard writes cannot be undone. If the popup disappears during commit without
an acknowledgement, mark delivery outcome unknown, never auto-repeat it; explain
that it may have completed and permit an explicit retry. This avoids false
cancelled/success claims and silent duplicate deliveries.

## Failure policy

Distinct codes cover blocked page, incomplete coverage, unstable page, resource
timeout, capture timeout, page too large, target changed, worker interrupted,
cleanup failure, transfer failure, clipboard failure, cancellation, and expired
artifact. Translate codes to short next actions; keep diagnostics out of normal UI.
Diagnostics contain phases, counts, timings, dimensions, and error codes, never
page text, URLs, image bytes, or telemetry. Store them only in ephemeral session
memory unless deliberately exported for development.

## Verification and acceptance

Retain the current unit, browser, popup, and release checks. Add focused tests for:

1. Reinjection/reopen/double-start: one owner and one mutation transaction; no
   stranded styles or duplicate delivery.
2. Interior and two-dimensional coverage holes, fractional scaling, edge clipping,
   and the existing eight fixtures, with pixel-region assertions beyond footer markers.
3. Overflow-clipped descendants, scrollbar-induced reflow, smooth scroll, snapping,
   CSS priorities, and failure midway through preparation or cleanup.
4. Finite lazy-load growth and changing content: one successful bounded retry;
   endless growth or stalled resources: clear failure with restoration.
5. Cancel in every phase, delayed callbacks, popup loss/reopen, retained-result
   expiry, unknown delivery outcome, and repeated cancellation.
6. Tab switch away/back, navigation, viewport/zoom change, worker restart, pagehide
   and back-forward restoration. No image from another tab may enter the artifact.
7. A hostile page listener attempting to fetch download data or cancel delivery:
   no screenshot URL/data is observable in page DOM and Save still hands off.
8. Progress semantics, keyboard/focus behavior, Cancel target size, themes,
   reduced motion, and screen-reader announcement sanity checks.
9. Actual installed-extension toolbar flows under the unchanged production
   manifest in Chrome and Edge. Test-only host access is not sufficient evidence.

Measure normal-page duration and memory against baseline fixtures; no unexplained
regression is acceptable. A slower preparation pass is an explicit reliability
tradeoff and should be quantified. Run release packaging with its required tools;
the earlier Windows ZIP-tool failure must not be treated as a passing release check.

Update architecture/product/privacy copy where behavior changes and refresh popup
screenshots. No new guarantee of universal or pixel-perfect web-page capture.

## Implementation boundaries and builder discretion

Likely owners: a new session module plus `content.js` for lifecycle; `capture-page.js`
for the mutation journal and measurement; `capture-geometry.js` for rectangle
coverage; `capture.js` for traversal/validation/encoding; `background.js` for guarded
screenshots; popup/clipboard modules for subscription and delivery. Update protocol
injection order and the release allowlist together. Avoid a framework migration.

The builder chooses exact data structures, module filenames, observer filtering,
coverage-union algorithm, safe URL-revocation timing, and the conservative memory
ceiling, documenting measured rationale. They may not silently change permissions,
supported page scope, retry limits, artifact retention, or user-visible lifecycle.
If browser testing disproves secure popup delivery under these permissions, return
with that specific constraint before substituting an offscreen/downloads design.

## Sources

- [Current architecture](../../architecture.md), [product boundaries](../../product.md),
  [design system](../../design.md), and [contribution constraints](../../../CONTRIBUTING.md).
- [Capture engine](../../../capture.js), [page preparation](../../../capture-page.js),
  [content entry](../../../content.js), and [clipboard gesture handling](../../../clipboard.js).
- Review in this conversation, 2026-10-28: reproduced overlap, coverage holes,
  clipped-bounds inflation, restoration timing, and page-visible download data.
- [Chrome messaging](https://developer.chrome.com/docs/extensions/develop/concepts/messaging):
  JSON serialization and port lifecycle motivate chunked transfer and reconnection.
- [Chrome tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs):
  visible-tab capture and rate limits require target checks and serialization.
- [Service-worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle):
  worker termination motivates content-owned cleanup and explicit interruption.
