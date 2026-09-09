# Chrome Web Store listing draft

This is submission copy for the current app. Longform currently uses the
[manual source installation](../README.md#install). A package built with
`mise run package:release` is local output, not a published store release.

## Basic metadata

- Name: Longform
- Short description: Capture a full web page as one review-ready PNG, then save it locally or copy it to the clipboard.
- Category: Productivity
- Language: English
- Official URL: https://astrazds.github.io/longform/
- Privacy policy URL: https://astrazds.github.io/longform/privacy.html
- Support URL: https://github.com/astrazds/longform/issues

## Single purpose

Capture the current web page as one full-page PNG, then save it locally or copy it to the clipboard.

## Detailed description

Longform captures a scrollable web page as one PNG. Open a regular web page,
click the Longform toolbar icon, and choose **Save** or **Copy**. Keep the
popup open until it says **Saved.** or **Copied.**

Use the image in a design review, page audit, QA report, or another app that
accepts images. No account is required.

What it does:

- Captures the scrollable page.
- Stitches captured viewports into one PNG.
- Temporarily hides fixed, sticky, and scrollbar chrome during capture to reduce duplicated page artifacts.
- Saves a timestamped PNG locally.
- Copies the generated PNG to the clipboard when browser support allows it.
- Gives short recovery instructions for unsupported pages, clipboard failures,
  and captures that exceed size or scroll-coverage limits.

Privacy:

Longform does not collect, transmit, sell, or remotely store page content, URLs, screenshots, browsing history, analytics events, or clipboard contents. Captures are created locally in your browser and go only where you choose to save, copy, paste, or upload them.

Current limits:

- Browser-internal pages such as `chrome://`, `edge://`, extension pages, and similar restricted URLs cannot be captured.
- Very large pages can hit Chromium canvas limits.
- Copy depends on browser support for PNG clipboard writes and the image size.
  Keep the popup open until capture finishes. Use Save if copying is unavailable.

## Permission justifications

- `activeTab`: Lets Longform access the current tab only after the user interacts with the extension, so it can capture the page the user selected.
- `scripting`: Lets Longform inject the capture script into the current page to measure, scroll, capture, and stitch the page.
- `clipboardWrite`: Lets Longform copy the generated PNG to the user's local clipboard when requested.

## Remote code declaration

No. Longform does not load or execute remote code.

## Data use declaration

Longform does not collect user data. Page content is processed locally only to create the user-requested PNG artifact. The extension does not transmit page content, URLs, captures, browsing history, analytics, or clipboard data to the developer or any third party.

## Test instructions

1. Install the submitted package. For a local test, use the unpacked output
   from `mise run package:release` as described in
   [CONTRIBUTING.md](../CONTRIBUTING.md#build-a-package).
2. Open a normal `https://` page with vertical scrolling.
3. Click the Longform toolbar icon.
4. Confirm the popup shows **Full-page screenshot**, **Save**, and **Copy**.
   On a supported page with clipboard support, the status is empty at rest.
5. Click **Save**. Confirm both buttons stay disabled during capture, the PNG
   downloads, and the popup reports **Saved.** Check the image and restored
   page scroll position.
6. Reopen the popup and click **Copy** on a supported browser. Keep the popup
   open until **Copied.**, then paste into an app that accepts PNG images.
7. Open `chrome://extensions` and reopen Longform. Confirm both actions are
   disabled and the status reads **Open a regular web page, then try again.**

No account, credentials, payment, backend, or external service is required.

## Artwork

The current UI references are [the popup](../docs/screenshots/popup.png),
[the desktop landing page](../docs/screenshots/landing-desktop.png), and
[the mobile landing page in dark mode](../docs/screenshots/landing-mobile-dark.png).
They document the app and are not a complete set of store-submission assets.

The files in `webstore/assets/` are historical marketing drafts. Their popup
and landing-page imagery is outdated. Replace those drafts with current
captures before a store submission. Do not use them as current documentation
screenshots.

## Current changes for a future submission

- The popup uses Save and Copy with one contextual status message.
- An early clipboard rejection waits for capture cleanup before actions are
  enabled again. Clipboard-only errors leave Save available.
- The landing page presents one download action and three manual install steps.

## Historical version notes

These notes describe earlier repository versions. Labels and screenshot
references below record the UI at that time, not the current interface.

### 1.3.5

- Makes **Copy PNG** reliable by writing from the popup with a click-gesture `ClipboardItem` and transferring PNG bytes as base64 across extension messaging.
- Clarifies that the popup must stay open until copy finishes.

### 1.3.4

- Simplifies the release verification path while keeping the same Chrome Web Store package contents.
- Removes checked-in generated design artifacts from the source repository.
- Keeps the landing page preview tied to the existing packaged store screenshot asset.
