# Design

## Identity

Longform uses a warm paper background, dark text, muted olive accents, and
system fonts. Typography, spacing, and fine rules provide the structure.
The interface keeps attention on capture and installation.

The pixel-art mark is defined in [icons/icon.svg](../icons/icon.svg). It uses
a 16px grid, a cream page, a charcoal frame, and an olive edge. The PNG icons
are integer-scale derivatives. Preserve crisp edges when updating them.

## Popup

[popup.html](../popup.html) and [popup.css](../popup.css) define a 300px-wide
popup with 20px padding. A 16px sans-serif heading reads **Full-page
screenshot**. Save and Copy occupy equal columns with an 8px gap and 44px
minimum height. Save has the stronger visual emphasis.

The single status region has no visible text or spacing at rest. Progress,
success, and errors appear below the actions. The live region stays mounted,
uses polite announcements, and presents each message as one unit.

Button labels stay **Save** and **Copy** during capture. Both buttons are
disabled until the operation finishes. Their accessible names include
"full-page screenshot as PNG". Keyboard focus uses an opaque outline, and
reduced-motion preferences remove button transitions.

## Landing page

[index.html](../index.html) uses one centered column. The sequence is the
icon and wordmark, **Capture the whole page.**, a short explanation, three
installation steps, a use note, one native limits disclosure, and footer
links. There is one download action.

[landing.css](../landing.css) caps the column at 50rem and adjusts padding
for narrow screens. The serif headline is capped at 4.5rem. Mobile uses the
same content order from 320px wide. The landing page has no decorative motion.

The [privacy page](../privacy.html) shares the stylesheet and wordmark. Its
policy sections remain a single readable column with a link back home.

## Color and type

The popup and landing page both follow `prefers-color-scheme`. They have
separate OKLCH palettes in their CSS files; those files own the exact values.
Dark mode uses warm dark backgrounds, pale text, and lighter olive accents.
Status messages include text so their meaning does not depend on color.

The landing display stack uses Iowan Old Style, Palatino, and Georgia. Body
text and popup controls use the system sans-serif stack. Technical fragments
use a local monospace stack. No fonts are fetched from a remote service.

## Review the UI

Check light and dark mode, keyboard focus, readable errors, and layouts at
320px, 390px, and desktop widths. Keep primary action targets at least 44px
high. Check the privacy page when changing shared landing styles.

Current reference images live in [docs/screenshots](screenshots/):

- [Popup](screenshots/popup.png).
- [Desktop landing page](screenshots/landing-desktop.png).
- [Mobile landing page in dark mode](screenshots/landing-mobile-dark.png).

These are selected documentation screenshots. Raw browser-test output stays
in `artifacts/smoke/`. The older images in `webstore/assets/` are historical
marketing drafts and are not current UI references.
