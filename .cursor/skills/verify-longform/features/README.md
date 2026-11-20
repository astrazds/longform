# Longform verification map

This directory is the maintained source for verifying the user-facing behavior of Longform. Read the index, then use one feature file as the recipe.

## Baseline preconditions

A fresh profile is `cleanup`, then `launch`, from the repository root.

```bash
mise install
node .cursor/skills/verify-longform/scripts/drive.mjs cleanup
node .cursor/skills/verify-longform/scripts/drive.mjs launch
node .cursor/skills/verify-longform/scripts/drive.mjs doctor
```

Require a `ready` line, then `doctor ok`, before any recipe. Do not drive a browser this session did not start.

## Driving conventions

- `#longform-top`, `#longform-sticky`, and `#longform-bottom` each match one element before a page action.
- The heading `Longform fixture page` matches one element on the fixture.
- `Save full-page screenshot as PNG` and `Copy full-page screenshot as PNG` each match one button before a click.
- `open-popup` continues only after the heading reads `Full-page screenshot` and the popup has settled on an empty status with Save enabled, or on `Open a regular web page, then try again.`
- `scroll:480` is valid only while the viewport is 1000 by 640. The action fails if that viewport still shows the top or bottom band.
- `shot-page` stores the viewport, not the whole document.
- Keep `state.json`. Cleanup does not remove it.

## Proof and skip reporting

- A passing recipe writes `state.json` whose steps show the action and the state after it.
- Save and Copy also store a PNG that contains the top band and the bottom band and is taller than the viewport.
- The viewport shot after `scroll:480` contains neither band. That shot is not the capture.
- Report a recipe that cannot run with the command and the unmet precondition. Do not mark it passed through a different recipe.

## Features

- [Save](./save.md) downloads a full-page PNG from the fixture.
- [Copy](./copy.md) puts that PNG on the clipboard.
- [Cancel](./cancel.md) stops a capture before a download starts.
- [Restricted page](./restricted-page.md) disables Save and Copy when the active tab is not a web page.
