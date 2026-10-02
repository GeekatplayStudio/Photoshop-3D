# Changelog

All notable changes. The format follows [Keep a Changelog](https://keepachangelog.com/); versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Added
- **Getting started** card on the Create tab the first time the panel opens: pick a service, generate, place and re-pose, with buttons to open Settings or the guide. **Hide** dismisses it for good.
- **Install guide** for non-technical users ([docs/INSTALL.md](docs/INSTALL.md)): download-and-double-click first, then the one-line installer, with pictures, updating, uninstalling and the common problems.
- A rewritten README with crisp screenshots of every tab and of the 3D editor, a service comparison and a FAQ.

### Changed
- `install-windows.cmd` and `uninstall-windows.cmd` now work on their own: if `install-windows.ps1` isn't next to them, they download it from GitHub. One file to download and double-click.
- The installers explain problems in plain language (for example "No compatible Photoshop found…", "Could not reach GitHub…") and link to the help page. Pasting the PowerShell one-liner no longer closes the PowerShell window when something fails.
- Updater: if Photoshop's "open file" prompt is blocked, the panel now explains how to finish the update (Install again → Allow, or run the install script) instead of showing "User denied.".
- Settings: the Meshy key link goes straight to meshy.ai's API Keys page, and the Hitem3D hint links to its key instructions.

## [0.1.0] - 2026-10-02

First release.

### Added
- **3D generation:** send the active layer, or the visible pixels in a selection, to Meshy (image-to-3D), Tripo (API v3), Hitem3D/hi3d.ai, or ComfyUI (built-in TRELLIS.2 workflow or any API-format image→3D workflow). Background jobs persist across panel closes and Photoshop restarts, with retry, cancel and progress.
- **Browse** your models on each service and import them (Meshy task lists, Tripo usage history, ComfyUI history, Hitem3D task history) — plus "Track a task ID".
- **Local model library** with automatic previews, an interactive 3D preview, favorites, rename, delete and GLB import. It is stored in a user folder shared by all Photoshop versions and kept across updates.
- **3D pose & light editor** (port of the ImageExpress 3D View Editor):
  - **Light:** sun widget, light presets, intensity/distance/ambient, colour swatches, colour temperature.
  - **Scene:** 10 offline environments, cast and contact shadows.
  - **Pose and camera:** turn/tilt/roll/scale, camera views, field of view.
  - **Export:** up to 8192 px, or match the document.
- **3D layers:** renders are placed as smart objects that store their 3D state in layer XMP. Double-click a 3D layer to re-pose and relight it; the update keeps the layer's position and size.
- **Settings:** API keys and addresses, per-service options, connection tests with balances, and diagnostics (versions, folders, log).
- **Updates:** checks GitHub releases, verifies the SHA-256 and installs through Creative Cloud. One-click install scripts for Windows and macOS.
- Documentation, unit tests, Playwright UI tests and CI/release workflows.
