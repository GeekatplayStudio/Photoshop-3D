# Development

## Requirements
- Node.js 20.19+ (22 recommended) and npm
- For testing in Photoshop: Photoshop 2025 (26.0)+ and the Creative Cloud desktop app (it provides UPIA, Adobe's plugin installer). The UXP Developer Tool is optional.

```bash
npm install
```

## Scripts

| Command | What it does |
|---|---|
| `npm run dev:web` | Serves the UI at http://localhost:5173/panel.html and `/editor.html?model=lib_totem`, against the **mock host** (`src/web/bridge/mockHost.ts`) with the sample model in `tests/fixtures/public`. Hot reload. |
| `npm run build` | Builds `dist/plugin/`: Vite builds the UI into `web/`, esbuild builds `host.js`, then the manifest (version from `package.json`), icons and `build-info.json` are added. |
| `npm run package` | Zips `dist/plugin` into `dist/release/geekatplay-3d-layers-<version>.ccx` (plus `geekatplay-3d-layers.ccx`) and writes `SHA256SUMS.txt`. Validates the manifest the way Adobe's packager does. |
| `npm run dist` | `build` + `package` |
| `npm run dev:install` | `dist`, then installs into Photoshop with UPIA (removing installed copies first). Photoshop reloads the plugin without a restart. |
| `npm run uninstall:local` | Removes the plugin from Photoshop |
| `npm run typecheck` | `tsc --noEmit` over host, web, shared, tests |
| `npm test` | Vitest unit tests |
| `npm run test:e2e` | Playwright tests of the panel and editor in Chromium (starts `dev:web`) |
| `npm run verify` | typecheck + tests + dist + package verification (what CI and releases run) |
| `npm run release -- 0.2.0 [--push]` | See [RELEASING.md](RELEASING.md) |

## Day-to-day loop
1. Work on the UI with `npm run dev:web` in a browser. The mock host fakes jobs, the library, browsing, settings and the editor round trip, so most UI work needs no Photoshop.
2. Work on the host or Photoshop behaviour, or check the UI inside Photoshop, with `npm run dev:install`. This takes about 10 s; the panel reloads.
3. Watch `%APPDATA%\Geekatplay\3D Layers\logs\photoshop3d.log` (or `~/Library/Application Support/...`). Every bridge call, provider request, job transition and Photoshop operation is logged.

## Debugging inside Photoshop
- **Log:** Settings › Diagnostics › *Show recent log* / *Open log folder*.
- **WebViews:** both WebViews have `uxpAllowInspector="true"`. Load the plugin through the UXP Developer Tool (*Add Plugin* → `dist/plugin/manifest.json` → *Load*) and use *Debug* to open Chrome DevTools for the host, panel and editor pages.
- **Host:** `console.log` from host code also shows in UDT's debugger.
- The UXP data folder (only holds the web UI copy) is `%APPDATA%\Adobe\UXP\PluginsStorage\PHSP\<ps-major>\External\com.geekatplay.photoshop3d\PluginData`.

## Conventions
- **Photoshop calls:** only `src/host/ps/*` imports `photoshop`. Keep batchPlay descriptors there and run them inside `modal()`, with a history name for anything that changes the document.
- **Providers:** they never import UXP modules. They get `fetch`, settings, secrets and a logger through `ProviderContext`, so they run under Node in tests.
- **Logging and credentials:** use `log.debug/info/warn/error`. Never log credentials; `redact()` is a safety net, not a licence.
- **UI controls:** use `Select`/`Dropdown`, `ColorField`, `PasteButton` and `title` (turned into in-page tooltips). Never use native `<select>`, `<input type="color">`, or anything that opens an OS popup inside the WebView (see [ARCHITECTURE.md](ARCHITECTURE.md#platform-findings)).
- **Comments:** explain *why* (especially Photoshop/UXP quirks), not *what*.

## Icons and fixtures
- `node scripts/make-icons.mjs` regenerates `plugin/icons/*.png` (committed). Icon files are named `<name>@1x.png` / `<name>@2x.png` while the manifest names `icons/<name>.png`; see [ARCHITECTURE.md](ARCHITECTURE.md#platform-findings).
- `node scripts/make-test-model.mjs` regenerates `tests/fixtures/public/samples/totem.glb` (committed, 7 KB).

## Documentation screenshots
`npm run docs:screenshots` (with `npm run dev:web` running) renders `docs/images/ui-*.png` (the panel tabs, at 2×) and `ui-editor.jpg` against the mock host, so the pictures always match the current UI. The README's editor picture uses a real model:

```bash
DOCS_MODEL="$APPDATA/Geekatplay/3D Layers/library/<id>/model.glb" DOCS_MODEL_NAME="Viking axe" DOCS_TURN=-75 npm run docs:screenshots
```

`DOCS_ONLY=editor` renders just the editor; `DOCS_PRESET` picks the light preset (default *Golden Hour*). The Photoshop screenshots (`plugins-menu.png`, `update-permission.jpg`, `photoshop-layer.jpg`) are captured by hand.
