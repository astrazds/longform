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

The mark is an abstract vertical frame: a long page implied by offset strokes, not a camera or screenshot icon. The wordmark is primary on the landing page; the icon mark must still hold at 16px for the extension toolbar.

## Layout

Use a document-like structure with a quiet header, a dominant typographic hero, precise rule-separated sections, sparse proof columns, and a semantic CSS/SVG capture artifact. Cards are used sparingly; most grouping should come from alignment, spacing, and fine dividers.

## Components

- Header: slim, text-led, with wordmark and compact install CTA.
- Buttons: rectangular or softly rounded, restrained, no pill-heavy SaaS treatment.
- Artifact visual: semantic HTML/CSS/SVG long page frame with scroll/review cues.
- Popup: pale surface, fine borders, clear primary action, local abstract tab badge, calm status states.
- Focus states: visible olive outline or underline treatment with enough offset.

## Motion

Use subtle opacity/translate reveals only when `prefers-reduced-motion` allows it. Motion should feel like a document coming into focus, not a marketing animation.

## Responsive Behavior

Mobile starts with the promise, CTA, and support note before the artifact visual. Desktop can use asymmetric columns and a left/right rail. Maintain readable measures, avoid text overlap, and preserve touch targets.
