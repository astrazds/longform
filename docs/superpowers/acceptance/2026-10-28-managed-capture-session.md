# Managed capture acceptance — 2026-10-28

## Decision and scope

The user accepted the Chrome manual walkthrough, explicitly waived the remaining
Edge manual checks, and authorized merging the managed-capture changes into local
`main`. This is acceptance under a revised scope, not a claim that Edge's manual
checks passed. It does not authorize publishing a release or pushing the branch.

Runtime tested: `6048fd84e8c614da4df41f4b87caab7951ca20f5`, Longform 1.3.5,
loaded unpacked with the unchanged production manifest (`activeTab`, `scripting`,
`clipboardWrite`; no test host grants). Manual evidence below is the user's
reported observations and attached screenshots in the acceptance conversation.
Chrome's exact version and the Narrator version were not recorded. Earlier
automated runs identify their own browser versions separately.

Related documents: [approved design](../specs/2026-10-28-managed-capture-session-design.md),
[implementation plan](../plans/2026-10-28-managed-capture-session.md), and
[manual verification procedure](../../../CONTRIBUTING.md#manual-release-acceptance).

## Chrome manual results

| Check | Result | Reported evidence |
| --- | --- | --- |
| Save at normal maximized size/scaling | Pass | One PNG downloaded and original scroll position restored after the 4K memory-accounting correction. This is not an explicit native F11 test. |
| Copy | Pass | "Copied" appeared; image pasted into Paint with the end marker; scroll position restored. Attached output shows sections One through Five and the pink end marker. |
| Cancel and keyboard focus | Pass | No download; scroll position restored; focus returned to Save. |
| Popup close/reopen and retained-image delivery | Pass | Reopened popup showed capture ready; Save downloaded one PNG without scrolling through the page or recapturing. In-progress reopening was not separately observed: capture was already ready. |
| Blocked page | Pass | Chrome settings produced cannot-capture guidance; no download; capture worked again on the fixture. |
| Hostile-page delivery | Pass | One green PNG downloaded; `pageObservedScreenshotUrls` was `[]`; `pageReadScreenshotBytes` was `false`. |
| Narrator controls, progress and completion | Pass | Save and Copy announced as buttons, progress spoken without excessive repetition, then "Download started". |
| Narrator cancellation/focus | Pass | Cancel announced as a button, cancellation message spoken, then Save announced when focus returned; no download; restored scroll. |
| Narrator retained-image recovery | Pass | "Capture ready" announced; keyboard Save delivered one PNG without recapture; "Download started" announced. |
| Narrator blocked-page guidance | Pass | Explanation spoken; no download; Escape closed popup normally. |
| Light/dark themes and keyboard focus | Pass | Both themes clear; keyboard focus visible. |
| Reduced motion | Pass | Capture succeeded with one download and restored scroll position. |

The initial size rejection in Chrome and Edge was an acceptance failure, not a
passed limit check. Narrowing the window succeeded. Fixes at `98b34c5`, `478db97`
and `6048fd8` corrected phase memory accounting and pending-native-work lifetimes
without reducing output resolution or raising the 512 MiB working estimate or
32 MiB actual PNG cap. The user subsequently reported full-size Save succeeding.

## Edge waiver

User instruction: "Let's assume Edge works and just complete this testing based
on the Chrome." The user then explicitly requested recording the results and
waiver and merging into `main`.

Remaining native Edge functional, screen-reader, theme and reduced-motion checks
are **waived, not passed**. Edge has automated browser coverage, including the
full-resolution regression, but those tests use a disposable test harness and
do not substitute for production-manifest native toolbar or speech verification.
The accepted limitation is that Edge-specific activation or accessibility issues
could remain undetected.

## Automated verification and evidence boundaries

The final implementation evidence at `6048fd8` records 194 passing unit tests,
seven focused Chrome and seven focused Edge cases, and release packaging with
all 19 allowlisted file bytes matching source. Both emulated large viewports
(2560×1392 and 2560×1440 CSS pixels at DPR 1.5) produced decoded 3840×6300 PNGs
with coverage, footer and restoration assertions. Oversized artifacts were still
rejected with cleanup. Independent review approved the final correction.

Earlier full browser gates cover the eight original fixtures, popup flows and
adversarial reliability scenarios. Local raw evidence remains in the managed
worktree's ignored `.superpowers/sdd/2026-10-28-managed-capture-session/` and
`artifacts/` directories. A fresh full gate is run on the merged tree as part of
integration; its outcome is reported separately rather than invented here.

The harness's `manualAcceptance.releaseReady=false` is an automatic reminder
that the harness cannot establish manual acceptance. It is not rewritten to
fabricate an Edge pass. This document records the human Chrome results and the
explicit scope exception; it makes no blanket release-publication claim.
