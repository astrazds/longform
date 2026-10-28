# Longform privacy policy

Effective date: 2026-10-28

Longform is a Chromium extension that captures the current web page as a full-page PNG when you choose to run it.

## Data collection

Longform does not collect, sell, transmit, or remotely store personal information, browsing history, page URLs, screenshots, page content, analytics events, or clipboard contents.

## How captures work

When you open Longform on a supported `http://` or `https://` page and choose **Save** or **Copy**, the extension temporarily reads the visible page layout in your browser so it can scroll, capture, and stitch the page into one PNG image.

The generated PNG stays on your device. Longform only sends the image to a destination when you explicitly choose one:

- **Save** saves the PNG through the browser's local download flow.
- **Copy** writes the PNG to your local clipboard when browser support allows it.

After that, you control where the file or clipboard image goes.

The content script retains at most one completed PNG per document in isolated
memory for two minutes, so reopening the popup can recover a finished capture.
The retention clock continues during reconnection and transfer. Acknowledged
delivery releases the image; expiry clears it. No image history is written to
extension storage. Navigation, tab/browser closure or a crash can lose the
in-memory image.

Image transfer uses bounded, acknowledged chunks inside extension contexts.
Download links and screenshot URLs are created in the extension popup, outside
the page DOM. Save starts the browser download flow; Longform does not verify
that a file reached disk. Cancel is available until delivery commits. A lost
delivery acknowledgement is reported as unknown and is never automatically
repeated.

## Permissions

Longform uses only the permissions needed for its single purpose:

- `activeTab`: access the current tab after you interact with the extension.
- `scripting`: inject the capture script into the current page.
- `clipboardWrite`: copy the generated PNG to the clipboard.

Longform does not request persistent access to all websites.

## Remote code and services

Longform does not load or execute remote code. It does not use a backend service, analytics service, advertising service, tracking pixel, or remote favicon service.

## Data sharing

Longform does not share user data with the developer or third parties. If you save, upload, paste, or otherwise share a generated PNG outside the extension, that sharing is controlled by you and by the destination you choose.

## Contact

For privacy or support questions, use the
[repository issue tracker](https://github.com/astrazds/longform/issues).
The same policy is available on the
[Longform website](https://astrazds.github.io/longform/privacy.html).
