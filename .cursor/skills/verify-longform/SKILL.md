---
name: verify-longform
description: "Drive the Longform Chrome extension in Chromium. Use when loading the unpacked extension, opening its toolbar popup, or proving Save, Copy, Cancel, or a page the extension cannot capture."
---

# Verify Longform

Longform is a Manifest V3 Chrome extension. This skill loads the unpacked repository in Chromium and drives the toolbar popup against a local page. It does not replace `mise run check`.

Run every command from the repository root.

## Launch

The extension loads from the repository root. There is no build. The manifest must list `activeTab`, `scripting`, and `clipboardWrite`, and it must not list host permissions.

```bash
mise install
node .cursor/skills/verify-longform/scripts/drive.mjs launch
```

Leave that process running. Ready is a stdout line that starts with `ready`. The process prints it only after all of these are true.

- Node is 20 or newer.
- The verify server owns `127.0.0.1:8891` and serves the fixture.
- Xvfb owns display `:97`.
- Chromium has loaded this repository in a new profile.
- `http://127.0.0.1:8891/page.html` shows one top band, one sticky bar, and one bottom band.
- The toolbar action opened the popup on that page, Save was enabled, and the status was empty. The popup was then closed.

`setup_ms` is the launch clock from process start through that line. `tools_ms` is the part spent on Playwright and Chromium. `popup_ms` is the part spent opening and closing that first popup. A listening port without the `ready` line is not ready.

The driver downloads Playwright 1.65.1 and Chromium into `.cursor/skills/verify-longform/.tools/` when they are missing. The profile and Xvfb state live in `.cursor/skills/verify-longform/run/`. Commands go to `127.0.0.1:8892`. Do not switch that to a Unix socket. This worktree path is longer than the Linux socket limit.

Launch refuses a second session, a taken port 8891, a taken port 8892, or a taken display `:97`. Two browsers would share one profile.

## Doctor

Run this before a drive whenever the page looks wrong. It does not click, type, or reload.

```bash
node .cursor/skills/verify-longform/scripts/drive.mjs doctor
```

Exit 0 prints `doctor ok` with the server url, the page url, the driver pid, the port, the extension id, and the version. Anything else means do not drive. The check fails if the port is not this session, the manifest name is not Longform, the version differs from the session, the page is not the fixture, the background worker count is not 1, or any fixture id matches a count other than 1.

## Drive

Read `features/README.md`, then one feature file. Run that file's commands from an empty profile. `cleanup` then `launch` is the empty profile.

`open-popup` invokes the toolbar action on the current tab and waits until the heading reads `Full-page screenshot`. Do not open `popup.html` as a tab. That tab becomes the active tab, and Save stays disabled. Do not load the smoke bundle from `scripts/smoke.mjs`. That bundle adds host permissions and is a different extension.

The fixture handles each match one element before a page action.

- `#longform-top` is the red band. Its text is `LONGFORM-TOP`.
- `#longform-sticky` is the sticky bar. Its text is `LONGFORM-STICKY`.
- `#longform-bottom` is the blue band. Its text is `LONGFORM-BOTTOM`.
- The heading `Longform fixture page` matches one element.

The popup handles are the heading `Full-page screenshot`, the button `Save full-page screenshot as PNG`, the button `Copy full-page screenshot as PNG`, and `#cancelBtn`. `assert-ready` continues only when Save and Copy are enabled, Cancel is hidden, and `#status` is empty. `assert-blocked` continues only when both buttons are disabled and `#status` is `Open a regular web page, then try again.`

The viewport is 1000 by 640. `scroll:480` moves the red and blue bands out of that viewport. A viewport image at that scroll is not a full-page capture.

```bash
node .cursor/skills/verify-longform/scripts/drive.mjs run --evidence .cursor/skills/verify-longform/evidence/save --actions 'goto-page,scroll:480,shot-page:before,open-popup,assert-ready,shot-popup:popup-ready,save,shot-popup:popup-saved,assert-restored,close-popup,shot-page:after'
```

`pass evidence=... verify_ms=...` is a pass. `capture_ms` is the part of that command spent inside Save, Copy, or Cancel. A thrown check is a failure. Write the failure down and leave the journey as it is.

## Evidence

The driver writes the directory you pass to `--evidence`. For the mapped features those directories are:

- `.cursor/skills/verify-longform/evidence/save`
- `.cursor/skills/verify-longform/evidence/copy`
- `.cursor/skills/verify-longform/evidence/cancel`
- `.cursor/skills/verify-longform/evidence/restricted-page`

`state.json` is the proof. Each step stores the action and the page or popup state after it. `console.txt` is the page, popup, and service worker console. A `shot-page` or `shot-popup` step also writes `<name>.png` and `<name>.aria.txt`. Save writes `capture.png`. Copy writes `clipboard.png`.

A pass has to come from the toolbar popup and the fixture page. `Download started.` without `capture.png` is not a pass. `Copied.` without a clipboard PNG is not a pass. The PNG has to be taller than the viewport, reach the page scroll height, and carry the fixture's top color at the top and the fixture's bottom color at the bottom. The viewport shot taken after `scroll:480` has neither color. The page scroll and the sticky bar have to come back after the popup finishes.

Do not call `chrome.runtime.sendMessage` from the fixture. Do not edit `manifest.json` for the run. The fixture is a local page. It does not stand in for an arbitrary site.

## Cleanup

Stop the session the driver started. This kills that driver pid, its Xvfb pid, and its Chromium pid when `/proc/<pid>/cmdline` still matches. It does not kill by process name. It deletes `.cursor/skills/verify-longform/run/` and leaves every evidence directory listed above.

```bash
node .cursor/skills/verify-longform/scripts/drive.mjs cleanup
```

`cleanup ok` means the processes are gone. Confirm the evidence directory from the drive still contains `state.json`. Run cleanup after a failed launch too, so a broken attempt does not keep the port or the display.

## Helpers

`drive.mjs` is the only helper. It is the way to start Chromium with the extension. Do not read Playwright's launch flags to find another way to open the browser.

```bash
node .cursor/skills/verify-longform/scripts/drive.mjs launch
node .cursor/skills/verify-longform/scripts/drive.mjs doctor
node .cursor/skills/verify-longform/scripts/drive.mjs run --evidence .cursor/skills/verify-longform/evidence/save --actions 'goto-page,scroll:480,shot-page:before,open-popup,assert-ready,shot-popup:popup-ready,save,shot-popup:popup-saved,assert-restored,close-popup,shot-page:after'
node .cursor/skills/verify-longform/scripts/drive.mjs cleanup
```

## Keep the map current

When the popup or the fixture handles change, run `/maintain-verification-skill` and update the feature file that drifted.
