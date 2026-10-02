# Releasing

Installed plugins update themselves from GitHub releases, so a release is the whole update mechanism.

## Steps
1. Describe the changes under `## [Unreleased]` in `CHANGELOG.md` and commit.
2. Run:
   ```bash
   npm run release -- 0.2.0 --push
   ```
   This:
   - checks the tree is clean;
   - turns `[Unreleased]` into `[0.2.0] - <date>` (with a fresh empty `[Unreleased]` above it);
   - sets the version in `package.json`;
   - runs `npm run verify` (typecheck, unit tests, build, package, package checks);
   - commits `Release v0.2.0`, tags `v0.2.0`, and pushes both.
3. `.github/workflows/release.yml` runs on the tag. It checks the tag matches `package.json`, runs `verify` again, and creates the GitHub release with:
   - `geekatplay-3d-layers-0.2.0.ccx`, plus `geekatplay-3d-layers.ccx` (a stable name)
   - `SHA256SUMS.txt`
   - `install-windows.cmd`, `install-windows.ps1`, `install-macos.command` and the uninstallers
   - release notes: the CHANGELOG section plus install instructions
4. Within 12 hours (or immediately via *Check now*), installed plugins show "Update available: v0.2.0".

Tags with a suffix (`v0.3.0-beta.1`) become GitHub pre-releases. Only users who enabled *Include pre-releases* are offered them.

## What the updater relies on (do not break)
- **Repository:** `GeekatplayStudio/Photoshop-3D` (Settings › Updates › Release repository can point elsewhere).
- **Tags:** `vMAJOR.MINOR.PATCH[-pre]`.
- **Assets:** exactly one `geekatplay-3d-layers-<version>.ccx` and a `SHA256SUMS.txt` with a line `<sha256>  geekatplay-3d-layers-<version>.ccx`. Without that line the update is refused.
- **Plugin id:** `com.geekatplay.photoshop3d` and the name `Geekatplay 3D Layers` must never change. The installers remove old copies by name, and the id ties settings to the plugin.

## Manual release (without the script)
```bash
npm version 0.2.0 --no-git-tag-version
npm run verify
git commit -am "Release v0.2.0" && git tag -a v0.2.0 -m "v0.2.0" && git push && git push origin v0.2.0
```
If Actions is unavailable, run `npm run dist` and create the release by hand with `gh release create v0.2.0 dist/release/* --notes-file <(node scripts/release-notes.mjs 0.2.0)`.
