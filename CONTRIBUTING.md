# Contributing to Longform

Keep changes focused. Discuss substantial behavior changes in an issue before
implementation. Preserve the extension's local-only capture behavior and its
three permissions in [manifest.json](manifest.json).

## Set up the checkout

The extension uses plain JavaScript, HTML, and CSS. It loads from the repository
root without compilation. Node.js is needed for development checks and
packaging, not for normal extension use.

Use [mise](https://mise.jdx.dev/) with the versions and tasks in
[mise.toml](mise.toml). Packaging checks also require `zip` and `unzip` on `PATH`.

```sh
git clone https://github.com/astrazds/longform.git
cd longform
mise install
mise run install
mise run browser:install
```

Load the checkout through **Load unpacked** on `chrome://extensions`.
After a runtime change, reload the extension there before testing it.

## Verify a change

Run the full check before a pull request:

```sh
mise run check
```

The tasks support narrower checks during development.

| Task | What it checks |
| --- | --- |
| `mise run test:unit` | Geometry, PNG payloads, clipboard timing, and content-listener reinjection |
| `mise run test:popup` | Actual popup document under test host grants: PNG delivery, recovery, restoration and accessibility states |
| `mise run test:browser` | Eight capture fixtures, popup checks and adverse reliability scenarios |
| `mise run test:release` | Package contents and the packaged popup on a restricted page |
| `mise run check` | Unit, browser, and release checks in sequence |

The browser scripts use `CHROMIUM_EXECUTABLE` when set, then look for a system
Chromium or Playwright's installed Chromium. `mise run browser:install` uses
the locked `playwright-core` CLI. CI uses `mise run browser:install-ci` to also
install browser system dependencies.

Inspect the PNGs and JSON reports in `artifacts/smoke/` after capture changes.
Browser and popup runs replace the previous smoke artifacts. The automated
browser copy adds test permissions, so also check the toolbar with the normal manifest after
changes to permissions or activation. See the
[architecture guide](docs/architecture.md#verification) for that boundary.

For focused adverse-case diagnosis use `node scripts/smoke.mjs --reliability`.
The optional `LONGFORM_RELIABILITY_CASE` regex selects scenarios during iteration;
unset it before the full check. The harness runs real isolated-world modules,
real PNGs, local hostile/resource fixtures, a native worker stop and persisted
BFCache restoration. Its hooks and widened permissions exist only in the
temporary test bundle. Preserve a baseline report outside `artifacts/smoke/` at
`artifacts/baseline/chrome-baseline.json` to record all eight fixture durations
and conservative memory comparisons. These estimates are not measured browser RSS.

On Windows set `CHROMIUM_EXECUTABLE` to a working Chrome/Chromium executable
when the Playwright cache is unavailable. Put working `zip` and `unzip` tools on
the process `PATH`. A missing browser or archive tool is a setup failure, not a
reason to skip a release check. The release check compares every ZIP entry and
byte with the shared runtime allowlist and loads the unchanged production manifest.

## Manual release acceptance

In disposable profiles in both Chrome and Edge, load the extension with the
unchanged manifest and invoke its real toolbar/Extensions-menu action. Record
browser and OS versions, permission state and each outcome in ignored artifacts:

- Save and Copy on an ordinary page; inspect the PNG and clipboard output.
- Cancel and keyboard focus after cleanup; reopen during capture and recover a
  finished PNG without recapturing.
- A blocked browser page and a hostile page listening for screenshot URLs and
  cancelling page download links.
- Confirm only `activeTab`, `scripting`, `clipboardWrite`; no test host grants.
- With a screen reader, check phase announcements and section throttling, then
  check keyboard access, visible focus, themes and reduced motion.

An automated `chrome.action.openPopup()` call does not prove the user toolbar
gesture grant. Missing Chrome execution is an outstanding acceptance check even
if Edge passes. Do not declare release readiness until these manual outcomes
are recorded; programmatic accessibility attributes do not substitute for speech.

For landing-page changes, inspect `index.html` and `privacy.html` in Chromium
at mobile and desktop widths in light and dark mode. Check keyboard focus,
the limits disclosure, links, and horizontal overflow. The automated capture
suite loads the landing page but does not validate its visual layout.

## Build a package

```sh
mise run package:release
```

The version comes from `manifest.json`. The command writes
`dist/longform-<version>.zip` and an unpacked copy under
`dist/chrome-web-store/longform-<version>/`. It replaces existing output for
that version.

[scripts/extension-files.mjs](scripts/extension-files.mjs) owns the package
allowlist. The ZIP includes the manifest, runtime scripts, popup files, and
four PNG icons. The site, documentation, source SVG, tests, and dependencies
are excluded. Packaging does not publish a release or submit it to a store.

## Prepare a pull request

Explain what changes for the user and how you verified it. Keep related tests
with the behavior they protect. Use the
[architecture ownership table](docs/architecture.md#find-the-owner) to locate
the code and checks for each change.

Keep generated packages, test reports, raw smoke artifacts, local agent files,
and editor state out of commits. Selected screenshots that document the
current UI may live in `docs/screenshots/`. Update documentation and those
screenshots when a change makes them inaccurate.

By contributing, you agree that your contribution is licensed under the
repository's [GPL-3.0-only license](LICENSE).
