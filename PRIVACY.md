# Longform Privacy Policy

Effective date: 2026-05-25

Longform is a Chromium extension that captures the current web page as a full-page PNG when you choose to run it.

## Data Collection

Longform does not collect, sell, transmit, or remotely store personal information, browsing history, page URLs, screenshots, page content, analytics events, or clipboard contents.

## How Captures Work

When you open Longform on a supported `http://` or `https://` page and choose **Save** or **Copy**, the extension temporarily reads the visible page layout in your browser so it can scroll, capture, and stitch the page into one PNG image.

The generated PNG stays on your device. Longform only sends the image to a destination when you explicitly choose one:

- **Save** saves the PNG through the browser's local download flow.
- **Copy** writes the PNG to your local clipboard when browser support allows it.

After that, you control where the file or clipboard image goes.

## Permissions

Longform uses only the permissions needed for its single purpose:

- `activeTab`: access the current tab after you interact with the extension.
- `scripting`: inject the capture script into the current page.
- `clipboardWrite`: copy the generated PNG to the clipboard.

Longform does not request persistent access to all websites.

## Remote Code And Services

Longform does not load or execute remote code. It does not use a backend service, analytics service, advertising service, tracking pixel, or remote favicon service.

## Data Sharing

Longform does not share user data with the developer or third parties. If you save, upload, paste, or otherwise share a generated PNG outside the extension, that sharing is controlled by you and by the destination you choose.

## Contact

For privacy or support questions, use the repository issue tracker:

https://github.com/astrazds/longform/issues
