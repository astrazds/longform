# Chrome Web Store Listing Draft

## Basic Metadata

- Name: Longform
- Short description: Capture a full web page as one review-ready PNG, then save it locally or copy it to the clipboard.
- Category: Productivity
- Language: English
- Official URL: https://astrazds.github.io/longform/
- Privacy policy URL: https://astrazds.github.io/longform/privacy.html
- Support URL: https://github.com/astrazds/longform/issues

## Single Purpose

Capture the current web page as one full-page PNG artifact for design review, then save it locally or copy it to the clipboard.

## Detailed Description

Longform helps product and design teams preserve a complete web page as one PNG artifact. Open a normal `http://` or `https://` page, run Longform, and choose whether to save the generated PNG or copy it into a review thread.

Longform is built for design critique, page audits, QA notes, implementation review, and handoff moments where a viewport screenshot loses important context.

What it does:

- Captures the full scrollable page, not just the visible viewport.
- Stitches captured viewports into one PNG.
- Temporarily hides fixed, sticky, and scrollbar chrome during capture to reduce duplicated page artifacts.
- Saves a timestamped PNG locally.
- Copies the generated PNG to the clipboard when browser support allows it.
- Names unsupported-page, clipboard, and large-page limits instead of saving partial artifacts.

Privacy:

Longform does not collect, transmit, sell, or remotely store page content, URLs, screenshots, browsing history, analytics events, or clipboard contents. Captures are created locally in your browser and go only where you choose to save, copy, paste, or upload them.

Current limits:

- Browser-internal pages such as `chrome://`, `edge://`, extension pages, and similar restricted URLs cannot be captured.
- Very large pages can hit Chromium canvas limits.
- **Copy PNG** writes from the extension popup during the click gesture; keep the popup open until copy finishes. Delivery still depends on browser support for image clipboard writes.

## Permission Justifications

- `activeTab`: Lets Longform access the current tab only after the user interacts with the extension, so it can capture the page the user selected.
- `scripting`: Lets Longform inject the capture script into the current page to measure, scroll, capture, and stitch the page.
- `clipboardWrite`: Lets Longform copy the generated PNG to the user's local clipboard when requested.

## Remote Code Declaration

No. Longform does not load or execute remote code.

## Data Use Declaration

Longform does not collect user data. Page content is processed locally only to create the user-requested PNG artifact. The extension does not transmit page content, URLs, captures, browsing history, analytics, or clipboard data to the developer or any third party.

## Test Instructions

1. Install the submitted package.
2. Open a normal `https://` page with vertical scrolling.
3. Click the Longform toolbar icon.
4. Confirm the popup shows the current page as the page to capture.
5. Click **Capture page** and save the PNG.
6. Reopen the popup and click **Copy PNG** on a supported browser.
7. Open `chrome://extensions` or another browser-internal URL and confirm Longform disables capture with a clear unsupported-page message.

No account, credentials, payment, backend, or external service is required.

## Release Notes

### 1.3.5

- Makes **Copy PNG** reliable by writing from the popup with a click-gesture `ClipboardItem` and transferring PNG bytes as base64 across extension messaging.
- Clarifies that the popup must stay open until copy finishes.

### 1.3.4

- Simplifies the release verification path while keeping the same Chrome Web Store package contents.
- Removes checked-in generated design artifacts from the source repository.
- Keeps the landing page preview tied to the existing packaged store screenshot asset.
