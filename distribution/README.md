# Publishing on the Creative Cloud Marketplace

Everything needed to list **Geekatplay 3D Layers** through
[Adobe Developer Distribution](https://developer.adobe.com/developer-distribution/).

| File | Use |
| --- | --- |
| `LISTING.md` | Text for every listing field, within Adobe's limits |
| `assets/icon-48.png`, `icon-96.png`, `icon-192.png` | Plugin icons |
| `assets/screenshot-1.png` ... `screenshot-5.png` | Listing screenshots, 1360 × 800 (the first is the main one) |
| `assets/publisher-logo-250.png` | Publisher logo, 250 × 250 (the same as the ComfyUI Bridge's) |
| `source/` | Vector source of the icon, and the logo page |
| `make-assets.mjs` | Renders the icons, the logo and the screenshots |
| `check-listing.mjs` | Checks the text lengths and image sizes |
| `../PRIVACY.md` | Privacy policy (linked from the listing) |

## How the Marketplace build differs

The same code serves both channels. `build-info.json` in the package says which one:

| | GitHub (`"channel": "github"`) | Marketplace (`"channel": "marketplace"`) |
| --- | --- | --- |
| Plugin ID | `com.geekatplay.photoshop3d` | the ID the Developer Distribution portal generates |
| Updates | the plugin checks GitHub releases and offers them | Creative Cloud updates it; the GitHub updater is off |
| WebView inspector | on (for debugging) | off (Adobe's review: no developer tools) |
| `launchProcess` | `.ccx`, `.log`, `.glb`, `.gltf`, folders | `.log`, `.glb`, `.gltf`, folders (no `.ccx`: nothing to install) |

User data (library, settings, API keys) lives in `Geekatplay/3D Layers` in the user folder, not in
the plugin's own storage. A Marketplace copy therefore finds the same library as a GitHub
copy, whatever its plugin ID.

The submission folder's `build-ccx.ps1` makes the Marketplace package from a built plugin: it writes
the portal's ID and version into the manifest, sets the channel, drops `.ccx` from
`launchProcess` and zips it.

## Steps

1. **Publisher profile.** Sign in at Developer Distribution and create (or reuse) the profile:
   name *Geekatplay Studio*, website *https://www.geekatplay.com*, a short description and
   `assets/publisher-logo-250.png`.
2. **Create the listing.** *Create New Listing > Creative Cloud desktop plugin > Photoshop*,
   plugin type UXP. Copy the **plugin ID** the portal generates.
3. **Package** with that ID (`build-ccx.bat` in the submission folder) and upload the `.ccx`.
4. **Fill in the listing** from `LISTING.md`: the fields, the three icons, the five screenshots,
   the support email, the help and privacy URLs, *Free* as purchase method, and the trader
   information if the plugin is offered in the EU.
5. **Test credentials.** Generation needs a key for Meshy, Tripo or Hitem3D. Give the reviewers
   one (with a few credits) in the credentials field, or say that the sample model covers
   everything except generation.
6. **Reviewer note.** Paste *Note for Adobe reviewers* from `LISTING.md`.
7. **Submit for review.** Adobe aims to answer within 10 business days.

Before submitting, run:

```bash
npm run verify
node distribution/check-listing.mjs
```

and check that the privacy and help URLs open (they point at `main` on GitHub).

## Review points already covered

| Adobe review point | In this plugin |
| --- | --- |
| Custom icons, all themes and scales | Own artwork: panel icons for light and dark themes at 1× and 2× (`@1x`/`@2x`, `species: chrome`); plugin icon at 48/96; listing icons at 48/96/192 |
| No Adobe logos or product names in the name | None in the name, icons, logo or screenshots |
| No blank panel at launch | A *Getting started* card with the steps, a sample model and a link to the guide |
| Loading indicators | Job progress, "Converting…", "Reading files…", "Rendering…", previews rendering |
| Clear, actionable errors | Every error says what to do (keys, credits, limits, missing models, Allow prompts) |
| Scrolling and layout | The panel scrolls; minimum size 260 × 320; the editor dialog resizes |
| Input | A paste button next to key fields (Photoshop keeps Ctrl/Cmd+V in docked panels) |
| Third-party dependencies disclosed | Meshy, Tripo, Hitem3D and ComfyUI are named in the description and the reviewer note |
| External accounts | Keys are entered and removed (Remove) in Settings; reviewers can test without any with the sample model |
| AI-generated content | Meshy's moderation is on by default (Settings › Meshy › Content moderation); Tripo and Hitem3D moderate on their side |
| No developer tools | The WebView inspector is off in the Marketplace build |
| Support and privacy | GitHub issues and the website; `PRIVACY.md` (no data collection, no tracking) |
| Network and file permissions | Explained in the reviewer note |
| Platforms | Pure UXP (JavaScript): no native code, so nothing to sign or notarize; macOS arm64/x64 and Windows x64 |

## Decide before submitting

- **Support email** shown to users.
- **Test credentials** for generation (see step 5).
- **ComfyUI and generated content:** with a local ComfyUI the user runs their own models with no
  filter of ours. The reviewer may ask about it.
