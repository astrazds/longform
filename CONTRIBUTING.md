# Contributing to Longform

Thanks for taking an interest in Longform. Small, focused changes are easiest
to review.

## Before opening a pull request

1. Open an issue for behavior changes or substantial new work so the scope can
   be agreed first.
2. Preserve Longform's single-purpose privacy boundary. Changes must not add
   telemetry, remote code, persistent all-site access, or unrelated browser
   permissions.
3. Keep extension runtime files at the repository root and keep the release ZIP
   limited to the manifest, runtime, popup, and four PNG icons.
4. Do not commit generated packages, browser reports, smoke artifacts, local
   agent files, or editor state.
5. Run the complete check:

   ```sh
   mise install
   mise run install
   mise run browser:install
   mise run check
   mise run package:release
   ```

Read [the capture architecture](docs/architecture.md) to find the owner and
verification command for each behavior. `mise.toml` owns project tool versions
and common tasks. Browser installation uses the locked `playwright-core` CLI.
Release packaging and checks also require `zip` and `unzip` on `PATH`.

## Pull requests

Explain the problem, the chosen approach, and how you verified it. Add or
update a fixture for capture-behavior changes. By contributing, you agree that
your contribution is licensed under the repository's GPL-3.0-only license.
