# Testing

Three layers, from fastest to most realistic.

## 1. Unit tests — `npm test` (Vitest, about 1 s)

| File | Covers |
|---|---|
| `src/shared/shared.test.ts` | Settings validation and merging; layer-XMP round trip (escaping, preserving other metadata, removal); semver; base64 and UTF-8 (against Node); format sniffing; the PNG encoder (decoded and compared pixel by pixel, CRC); selection masks; placement geometry; SHA-256 against `node:crypto` |
| `src/host/providers/providers.test.ts` | Every provider against scripted HTTP: request bodies (only documented fields per model), auth headers, Tripo upload→create, the Hitem3D sign-in/token cache/expiry retry, status mapping, Browse pagination, balances, error messages, and ComfyUI upload/queue/progress/output detection |
| `src/host/services/services.test.ts` | File store crash safety; the library (add/update/thumbnail/remove, rejecting non-glTF, healing a hand-edited index, concurrent adds); the job queue (full lifecycle, backoff, transient vs fatal errors, retry from the saved image, re-resolving expired links, resume after restart, cancel, tracking a task id); Browse from history; settings (no keys in `settings.json`); the updater (release picking, checksum-verified install, refusing corrupted downloads); the bridge server; log redaction; shared-folder paths; multipart bodies; TRELLIS.2 graph integrity |
| `scripts/scripts.test.mjs` | `.ccx` ZIP layout (no directory entries, forward slashes, no sourcemaps) and manifest validation; release-note extraction |

## 2. Browser tests — `npm run test:e2e` (Playwright, about 35 s)

The panel and editor run in Chromium, the engine Photoshop's WebView uses, against the mock host:
- Create → generate → job progress → Ready → the model appears in the Library, with a thumbnail rendered by three.js
- The in-page dropdown (selecting a provider)
- Browse → Import → "In library"; pagination
- Settings → saved key preview → Test connection
- The 3D editor: loads the sample model, poses it, applies a preset and an environment, and returns a 1024² PNG with a transparent background, the content bounds and the chosen settings

## 3. In Photoshop — manual checklist

Run `npm run dev:install`, open **Plugins › Geekatplay 3D Layers › 3D Layers**, and follow the steps with the log open. Use a scratch document.

| # | Step | Expected |
|---|---|---|
| 1 | Panel opens | Create tab shows the active layer's preview and size |
| 2 | Settings › each service › key (type or 📋 paste) › **Test connection** | Green "Connected", balance shown; a wrong key shows the service's message |
| 3 | Settings › ComfyUI › Test connection | "Connected: ComfyUI x.y, <GPU>"; for TRELLIS.2, missing nodes/models are listed |
| 4 | Create › ComfyUI › Generate on a cut-out layer | Job: Sending → Running (timer) → Downloading → Ready about 5 min later; the log shows the prompt id |
| 5 | Same with Meshy / Tripo / Hitem3D (needs keys and credit) | Ready; the model has the provider preview in the Library |
| 6 | Close the panel during a job, reopen it (or restart Photoshop) | The job continues and finishes |
| 7 | Job › **Pose & place** | Editor dialog opens with the model; **Place in Document** adds `<name> (3D)` over the source area |
| 8 | Move/scale the layer, then double-click its thumbnail | Photoshop's opened contents close automatically; the editor opens with the saved pose and light |
| 9 | Change light/pose/resolution › **Update Layer** | The layer updates in place, keeping position/size; one undo step "Update 3D Layer" |
| 10 | Save the PSD, close it, reopen it, double-click the layer | The editor opens with the saved state |
| 11 | Library: select (3D preview), rename, favorite, re-render preview, delete | Each works; the folder opens with *Show folder* |
| 12 | Browse each service; Import; Track a task ID | Lists your models; the import lands in the Library |
| 13 | `npm run dev:install` again (reinstall) | Library, settings and keys are still there |
| 14 | Settings › Updates › Check now | "up to date" or the newer release; **Install** opens Creative Cloud's installer |

### Verified for the first release (2026-10-02, Photoshop 27.10, UXP 9.4.1, Windows 11, RTX 3090)
- Steps 1, 3, 4, 6, 7, 8, 9, 11, 12 (ComfyUI), 13 and 14 (check), done by hand while building the plugin, including the TRELLIS.2 generation from a layer (4 min 50 s, 29.9 MB GLB) and double-click re-posing with the transform kept.
- **Meshy, Tripo and Hitem3D** were exercised against their documented APIs in unit tests, and each endpoint was probed live without a key. Generation with real keys (step 5) is left to the account owner.
