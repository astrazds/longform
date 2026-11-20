# Cancel

Cancel stops a capture before Longform hands the PNG to the browser. The status becomes `Cancelled.` The browser does not download a file. The page returns to its scroll position and the sticky bar is visible again.

## Sub-features

- `cancel-ready` shows an enabled Save button before the click.
- `cancel-stop` clicks Cancel while it is visible and ends on `Cancelled.`
- `cancel-restored` leaves no download and puts the page back.

## How to get to it (user POV)

- Open `http://127.0.0.1:8891/page.html` and scroll down.
- Open Longform from the toolbar.
- Click `Save`. Cancel appears.
- Click `Cancel` before the download starts. The status becomes `Cancelled.`
- No PNG is downloaded. The page is back where it was scrolled.

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
node .cursor/skills/verify-longform/scripts/drive.mjs run --evidence .cursor/skills/verify-longform/evidence/cancel --actions 'goto-page,scroll:480,open-popup,assert-ready,cancel,shot-popup:popup-cancelled,assert-restored,close-popup'
```

- **Open the local page.** `goto-page` loads the fixture. `scroll:480` moves both marker bands out of the viewport.
- **Open the popup.** `open-popup` and `assert-ready` require an enabled Save button and a hidden Cancel button.
- **Cancel the capture.** `cancel` clicks Save, waits until the one Cancel button is visible, clicks it, and waits until the status is `Cancelled.` with class `status`. A download event fails the step.
- **Record the result.** `shot-popup:popup-cancelled` stores that popup.
- **Prove the page came back.** `assert-restored` requires `scrollY` 480 and a visible sticky bar.

## Gotchas

- `Download started.` means Cancel lost the race. Do not delete the download and mark the recipe passed.
- `Cancelled.` with a download file is not a pass.
- Click Cancel only after it is visible. The button is in the page while it is hidden, and a click on the hidden button is not the user action.
