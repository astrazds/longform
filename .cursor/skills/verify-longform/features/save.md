# Save

Save captures the current web page and hands the browser a PNG download. On the fixture, the PNG includes the red top band and the blue bottom band. The viewport at scroll 480 includes neither band. After Save, the page is back at scroll 480 and the sticky bar is visible again.

## Sub-features

- `save-ready` shows an enabled Save button and an empty status on the fixture.
- `save-download` ends with `Download started.` and writes `capture.png`.
- `save-restored` puts the scroll position and the sticky bar back.

## How to get to it (user POV)

- Open `http://127.0.0.1:8891/page.html`.
- Scroll down until the red and blue bands are off screen.
- Open Longform from the toolbar. The heading reads `Full-page screenshot` and the status is empty.
- Click `Save`. The status becomes `Download started.` and the browser downloads a PNG.
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
node .cursor/skills/verify-longform/scripts/drive.mjs run --evidence .cursor/skills/verify-longform/evidence/save --actions 'goto-page,scroll:480,shot-page:before,open-popup,assert-ready,shot-popup:popup-ready,save,shot-popup:popup-saved,assert-restored,close-popup,shot-page:after'
```

- **Open the local page.** `goto-page` loads the fixture and waits until the heading, the top band, the sticky bar, and the bottom band are each one element.
- **Leave the bands off screen.** `scroll:480` waits until `scrollY` is 480 and the viewport image contains neither marker color. `shot-page:before` stores that viewport.
- **Open the popup.** `open-popup` invokes the toolbar action and waits until the heading is `Full-page screenshot`.
- **Prove the popup is idle.** `assert-ready` requires an empty status, enabled Save and Copy buttons, and a hidden Cancel button. `shot-popup:popup-ready` stores that popup.
- **Save.** `save` clicks `Save full-page screenshot as PNG`, waits until the status is `Download started.` with class `status success`, and writes `capture.png`. The file is a PNG taller than the 640px viewport, within 80px of the page scroll height, with the fixture's top color at the top and the fixture's bottom color at the bottom.
- **Record the result.** `shot-popup:popup-saved` stores the popup that says `Download started.`
- **Prove the page came back.** `assert-restored` requires `scrollY` 480, marker text unchanged, and the sticky bar's inline visibility cleared. `close-popup` leaves the fixture tab. `shot-page:after` stores the restored viewport.

## Gotchas

- A fresh profile is required. `cleanup` then `launch` is that profile.
- `Download started.` is the browser handoff. The pass is `capture.png`, not the status text.
- `before.png` is the scrolled viewport. It must not show the red band or the blue band. A capture that matches `before.png` is not a full-page save.
- Opening `popup.html` in a tab does not grant `activeTab`. Save then stays disabled, or the status is `Open a regular web page, then try again.`
- Do not add host permissions to make Save run. That loads a different extension.
- The sticky bar is hidden during capture and has to be visible again afterward. A hidden sticky bar is not a pass.
