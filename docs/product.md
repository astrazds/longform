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
one status message reports progress. Success is **Saved.** or **Copied.**
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

Save downloads the PNG from the content script. Copy returns image data to
the popup and depends on browser clipboard support and message-size limits.
The popup must remain open until the operation finishes. See
[architecture](architecture.md) for delivery and cleanup details.

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
