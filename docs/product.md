# Product

## Purpose

Longform captures a scrollable web page as one PNG. People can save the image
or copy it into a design review, QA report, or other app that accepts images.
The extension processes captures locally and requires no account.

## Current flows

The [landing page](../index.html) explains the result and the current manual
Chrome installation. It has one download action, three setup steps, a brief
use instruction, one limits disclosure, and privacy and source links.

The [popup](../popup.html) shows **Full-page screenshot**, **Save**, and
**Copy**. Each action starts capture immediately. There is no separate capture
step, source selector, settings panel, or image editor.

The popup is quiet when ready. During capture, both buttons are disabled and
one status message reports progress. Success is **Download started.** or **Copied.**
Errors give a short recovery instruction. Unsupported pages disable both
actions; unsupported clipboard writes leave Save available.

## Capture boundaries

Longform works on regular `http://` and `https://` pages in Chrome and other
Chromium-based browsers. Browser settings, extension pages, and other
restricted pages cannot be captured.

The extension scrolls the document and combines viewport screenshots. Fixed
and sticky elements and root scrollbars are temporarily hidden during
capture. The original scroll position and temporary inline styles are
restored when capture finishes or fails.

The engine rejects captures that exceed its canvas limits or fail its scroll
coverage check. This does not guarantee pixel-perfect output for every
dynamic page. Browser fixtures cover specific layouts; visual inspection is
still needed after capture changes.

Both destinations receive a validated PNG through bounded, acknowledged chunks
in the extension popup. Save uses an extension-origin download link; page
listeners cannot fetch the screenshot URL or cancel that link. Copy depends on
browser PNG clipboard support. **Download started.** confirms the browser
handoff, not that a file reached disk.

Capture supports ordinary documents with a finite root scroll surface and
horizontal overflow. It does not traverse nested scrollers, virtualized lists,
infinite feeds or iframe interiors. Fixed/sticky elements remain deliberately
absent from the PNG. CSS animations and transitions pause temporarily, while
page JavaScript, video and canvas updates can continue. There is no atomic
snapshot guarantee for a changing application.

Capture has a 120-second active-work deadline, 10-second external-operation
limits, and one complete retry for page changes. Missing interior or edge
coverage, unstable content and stalled resources fail with a recovery action.
Switching tabs or user scrolling can interrupt the session; Longform does not
switch the tab back or suppress the user's input.

## Cancellation and recovery

Cancel stays available during preparation, capture, restoration, encoding and
transfer. It ends at delivery commit, just before Save hands off or Copy resolves
its image promise. A download or clipboard write already handed off cannot be
undone. If the popup disconnects at commit, the outcome is reported as unknown
and delivery is never silently repeated.

Closing the popup keeps capture running while the document remains active and
within its deadline. Reopening shows progress or **Capture ready. Choose Save or
Copy.** A fresh click delivers the retained PNG without recapturing. One completed
PNG stays in isolated document memory for two minutes, including time spent
disconnected or transferring. Acknowledged delivery releases it; expiry requires
a new capture. This recovery does not survive browser crashes or promise
recovery after navigation/tab closure. See [architecture](architecture.md).

## Privacy boundary

The extension has no backend, telemetry, remote code, or persistent access to
all websites. Capture starts only after the user chooses an action. The
requested permissions are `activeTab`, `scripting`, and `clipboardWrite`.
The [privacy policy](../PRIVACY.md) defines the data and permission boundary.

## UI priorities

Keep the task and the next action clear. Show feedback when it changes what
the user should do. Avoid repeated claims, page metadata already visible in
the browser, and additional steps between capture and its destination.

Preserve keyboard access, visible focus, readable light and dark themes, and
44px action targets. The [design guide](design.md) records the current layout
and styling choices.
