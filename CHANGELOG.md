# Changelog

All notable changes. The format follows [Keep a Changelog](https://keepachangelog.com/); versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Added
- **Sample model** that ships with the plugin. *Try the sample model* (Getting started card) or *Add a sample model* (empty Library) lets you pose, light, place and re-pose without any account.
- **Meshy content moderation**, on by default (Settings › Meshy). Meshy checks the image before generating.
- **Creative Cloud Marketplace build** (`distribution/`, see its README):
  - `build-info.json` carries a `channel`. A Marketplace copy has no GitHub updater, because Creative Cloud updates it, and no WebView inspector.
  - Listing text, icons, screenshots and a privacy policy (`PRIVACY.md`).

### Changed
- New plugin icon: a cube standing on a layer, lit by a sun, in the Geekatplay colors.
- Demo models for the sample and the listing are made by `scripts/make-demo-models.py` (Blender).

## [0.1.4] - 2026-10-03

### Added
- **Library folders:**
  - Create folders and subfolders, open them by clicking, and go back up with the path above the grid.
  - Rename or delete folders. Deleting a folder moves its models up a level; it never deletes them.
  - Search looks in every folder.
  - Folders are virtual (stored in the library index), so moving models never touches their files or placed layers.
- **Drag and drop:**
  - Drag models onto a folder or the path to move them.
  - Drag 3D files or whole folders from File Explorer / Finder onto the Library to import them into the open folder (Photoshop 2026 / UXP 9.1+).
  - **Import folder…** and subfolders of the Import folder become library folders.
- **Removing models:**
  - Select several with Ctrl/Cmd+click, Shift+click or Ctrl/Cmd+A, then **Move to…** or **Remove** them.
  - The **Delete** key removes the selection after asking.
  - Each card has a quick remove button.

### Changed
- The development server uses port 5317 (fixed), so the browser tests never run against another project's server.

## [0.1.3] - 2026-10-02

### Added
- **Import your own 3D files** in any common format: GLB, glTF, FBX, OBJ (+MTL), DAE, USDZ/USD, 3DS, STL, PLY, 3MF, AMF, VRML and VOX.
  - **Import files…** picks one or more files. **Import folder…** adds every 3D file in a folder and its subfolders.
  - Everything is added to the library automatically. Formats other than GLB are converted to GLB in the panel (three.js loaders + GLTFExporter), with their materials and textures packed in.
  - Textures are found next to the model or in subfolders, by name, even when the file points at a folder on another computer.
- **Import folder:** files copied into the library's `Import` folder in File Explorer / Finder are added automatically while the Library tab is open. Each file is imported once, and nothing there is moved or deleted.

### Fixed
- **Show folder** (Library, Settings › Diagnostics) failed with `Extension "" is not accepted`. The manifest now allows opening folders, and Photoshop asks once for permission.

## [0.1.2] - 2026-10-02

### Fixed
- **The panel icon is no longer empty when the panel is collapsed in a dock (Windows).**
  - Photoshop looks for `<name>@1x.png` and `@2x.png` and needs `"species": ["chrome"]` on panel icons.
  - The icon files are renamed to that convention, and packaging now refuses a manifest without them.
  - Restart Photoshop once after updating.

### Changed: latest service APIs (checked against each changelog on 2026-10-02)
- **Meshy:**
  - Asks for transparent previews (`alpha_thumbnail`) and uses them in the library.
  - New **Smart Topology** model `meshy-t2` (clean low-poly, 100–15,000 faces).
  - Saved settings naming retired models (`meshy-5`, `meshy-7`, `meshy-4`, `meshy-t1`) move to their successors.
  - Only fields each model supports are sent.
- **Tripo:**
  - New **P2** model (`P2-20260801`, preview).
  - New **texture model v3.5** (`texture_version`), with **Fast** quality and **delight** (remove baked lighting).
  - `auto_size` is no longer sent to v2.5 or the P series.
  - `face_limit` is kept within each model's documented range.
  - Unknown task statuses fail the job, as Tripo's v3 migration guide asks.
  - Images over Tripo's 20 MB limit are refused with a clear message.
  - Usage-history errors are reported.
- **Hitem3D:**
  - New **de-shading** option (`shading`).
  - Plain-language messages for the documented error codes (10031001–10031017, 10000000).
  - The 20 MB image limit is checked before upload.
  - Links point to the new hi3d.ai docs and key page (platform.hi3d.ai).
- **ComfyUI (0.38):**
  - Cancel uses the jobs API (`POST /api/jobs/{id}/cancel`); `/interrupt` and `/queue` delete are deprecated.
  - Browse uses `GET /api/jobs` (paginated, without the full workflow graphs).
  - Both fall back to the old routes on older servers.
  - Test connection also checks the BiRefNet background-removal model.
  - The built-in TRELLIS.2 workflow uses whichever model files are installed (also in subfolders, or the documented alternatives).
- **All services:**
  - Rate limits (429) wait as long as the service asks (`Retry-After`). Polling doesn't count them as errors, and submissions are retried.
  - Endpoints a service marks deprecated (`Deprecation` header) are logged.
  - Error messages keep the service's code and request id.
- The installers' final check names each Photoshop version that has the plugin (for example "Photoshop 2026 (27.10.0): version 0.1.1") instead of printing Adobe's raw list.
- Docs: a sharp screenshot of the Plugins menu.

## [0.1.1] - 2026-10-02

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
