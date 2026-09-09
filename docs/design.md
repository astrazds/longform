# Design

## Brand

Longform is a restrained, typography-first identity for a full-page capture extension used by product and design teams. Longform is the product, package, extension, and documentation name.

## Visual Theme

The visual system is a quiet longform document, not a conversion funnel. It uses an off-white surface, deep ink, fine rules, sparse columns, and one muted olive-gray accent. The scene is a product designer preparing a design review packet late afternoon on a calibrated desktop display, focused and exact.

## Color Palette

Use OKLCH tokens. The site and popup follow the operating system color scheme with matching restrained light and dark palettes.

- `--paper`: `oklch(0.965 0.006 78)`, main background.
- `--paper-raised`: `oklch(0.985 0.004 78)`, elevated panels and popup surface.
- `--paper-line`: `oklch(0.855 0.006 78)`, rules and quiet borders.
- `--ink`: `oklch(0.185 0.012 80)`, primary text and mark.
- `--ink-muted`: `oklch(0.43 0.01 82)`, supporting text.
- `--accent`: `oklch(0.49 0.035 138)`, muted olive-gray action/accent.
- `--accent-soft`: `oklch(0.89 0.025 138)`, low-emphasis accent fields.
- `--danger`: `oklch(0.48 0.12 30)`, error text.
- `--success`: `oklch(0.45 0.07 145)`, success text.

Dark mode inverts the document atmosphere rather than becoming pure black: warm ink-black surfaces, pale text, preserved olive accents, and softened rule contrast. Primary buttons should keep AA contrast by swapping to a dedicated button text token instead of reusing a surface token.

## Typography

Use local/system fonts only unless a later release adds bundled font files.

- Display: `"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif`.
- Text/UI: `ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`.
- Code/technical fragments: `"SFMono-Regular", Consolas, "Liberation Mono", monospace`.

Headlines use the display stack with sharp contrast and balanced line breaks. Body and UI use the sans stack for clarity. Body text is 16px or larger; hero display type is fluid and capped. Avoid repeated tracked uppercase labels.

## Logo And Mark

The mark is a pixel-aligned capture frame: a warm cream long page sits inside a stepped charcoal silhouette, with a muted olive rail connecting the right and bottom edges. It uses a strict 16px base grid, three flat colors, and no document lines so the icon remains legible in the extension toolbar. The wordmark remains primary on the landing page.

## Layout

The landing page uses one narrow, centered reading path. Its order is the wordmark, product promise, installation steps, brief use note, one limits disclosure, and footer. Spacing and fine rules provide the structure.

## Components

- Wordmark: the accepted pixel-art icon beside the Longform name.
- Download link: the landing page's sole primary action, with a 44px or larger touch target.
- Installation: three ordered steps for the current unpacked Chrome install path.
- Limits: one native disclosure after the primary instructions.
- Popup: concise heading, Save and Copy actions, and status feedback only when needed.
- Focus states: visible olive outline or underline treatment with enough offset.

## Motion

The landing page has no decorative motion. Keep native interaction behavior for the limits disclosure.

## Responsive Behavior

The same single-column sequence works from 320px mobile screens through desktop widths. Keep readable measures, avoid text overlap, and preserve 44px touch targets.
