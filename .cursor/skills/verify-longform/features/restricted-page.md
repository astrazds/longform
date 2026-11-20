# Restricted page

Longform does not capture a tab that is not an `http` or `https` page. On `about:blank` the popup status is `Open a regular web page, then try again.` Save and Copy are disabled.

## Sub-features

- `restricted-open` opens the popup on a blank tab.
- `restricted-disabled` shows the blocked status and disables both buttons.

## How to get to it (user POV)

- Open a blank tab.
- Open Longform from the toolbar.
- The status reads `Open a regular web page, then try again.`
- Save and Copy do nothing because they are disabled.

## Driving it with drive.mjs

Preconditions, from an empty profile:

```bash
mise install
node .cursor/skills/verify-longform/scripts/drive.mjs cleanup
node .cursor/skills/verify-longform/scripts/drive.mjs launch
node .cursor/skills/verify-longform/scripts/drive.mjs doctor
```

`doctor ok` is required. `doctor` checks the fixture, so run it before this recipe leaves that page. Then run this command unchanged.

```bash
node .cursor/skills/verify-longform/scripts/drive.mjs run --evidence .cursor/skills/verify-longform/evidence/restricted-page --actions 'goto-blank,open-popup,assert-blocked,shot-popup:blocked,close-popup'
```

- **Open a blank tab.** `goto-blank` navigates to `about:blank` and waits until that is the tab url.
- **Open the popup.** `open-popup` invokes the toolbar action on that tab.
- **Prove the page is refused.** `assert-blocked` requires the status `Open a regular web page, then try again.`, the class `status error`, and both Save and Copy disabled. The tab url must not be `http` or `https`.
- **Record the result.** `shot-popup:blocked` stores that popup. `close-popup` leaves the blank tab.

## Gotchas

- An enabled Save button on `about:blank` is not this feature.
- The same status on `http://127.0.0.1:8891/page.html` means the toolbar action did not grant `activeTab`. That is a failed Save setup, not a restricted page.
- `doctor` fails after this recipe because the active tab is no longer the fixture. Run `goto-page` or launch again before `doctor`.
