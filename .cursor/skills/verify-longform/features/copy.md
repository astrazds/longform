# Copy

Copy captures the current web page and writes the PNG to the clipboard. On the fixture, that PNG includes the red top band and the blue bottom band. The status `Copied.` is the clipboard result, not a download.

## Sub-features

- `copy-ready` shows an enabled Copy button and an empty status on the fixture.
- `copy-clipboard` ends with `Copied.` and writes `clipboard.png`.
- `copy-restored` puts the scroll position and the sticky bar back.

## How to get to it (user POV)

- Open `http://127.0.0.1:8891/page.html`.
- Scroll down until the red and blue bands are off screen.
- Open Longform from the toolbar. The heading reads `Full-page screenshot` and the status is empty.
- Click `Copy`. The status becomes `Copied.`
- Paste the image. It is the full page, not the visible viewport.
- The page is back where it was scrolled, and the sticky bar is visible.

## Driving it with drive.mjs

Preconditions, from an empty profile:

```bash
mise install
node .cursor/skills/verify-longform/scripts/drive.mjs cleanup
node .cursor/skills/verify-longform/scripts/drive.mjs launch
node .cursor/skills/verify-longform/scripts/drive.mjs doctor
```

`doctor ok` is required. Then run this command unchanged.

```bash
node .cursor/skills/verify-longform/scripts/drive.mjs run --evidence .cursor/skills/verify-longform/evidence/copy --actions 'goto-page,scroll:480,open-popup,assert-ready,copy,shot-popup:popup-copied,assert-restored,close-popup'
```

- **Open the local page.** `goto-page` loads the fixture and waits until the heading and the three bands are each one element.
- **Leave the bands off screen.** `scroll:480` waits until `scrollY` is 480 and the viewport contains neither marker color.
- **Open the popup.** `open-popup` invokes the toolbar action. `assert-ready` requires an empty status and an enabled Copy button.
- **Copy.** `copy` clicks `Copy full-page screenshot as PNG`, waits until the status is `Copied.` with class `status success`, and writes `clipboard.png`. The file is a PNG taller than the viewport, within 80px of the page scroll height, with the fixture's top color at the top and the fixture's bottom color at the bottom.
- **Record the result.** `shot-popup:popup-copied` stores the popup that says `Copied.`
- **Prove the page came back.** `assert-restored` requires `scrollY` 480 and a visible sticky bar. `close-popup` leaves the fixture tab.

## Gotchas

- `Copy is unavailable in this browser. You can still save the screenshot.` is not `Copied.` Do not click Save and call it a copy.
- `Copied.` without `clipboard.png` is not a pass. A clipboard PNG that matches the scrolled viewport is not a pass.
- The click has to land on the Copy button. A script call to `navigator.clipboard.write` from the fixture is not the popup gesture.
- A page that is not `http` or `https` disables Copy. That is the restricted-page recipe.
