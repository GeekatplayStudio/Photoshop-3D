# Listing text - Adobe Developer Distribution

Copy each block into the matching field of the Photoshop listing. Limits are Adobe's;
`node distribution/check-listing.mjs` checks them.

## Public plugin name (45)

```text
Geekatplay 3D Layers
```

## Subtitle (30)

```text
Turn layers into 3D models
```

## Description (5000)

```text
Turn a layer into a real 3D model, pose it, light it and place it back in your document as a layer you can change any time. Double-click the layer later to turn the model, move the sun or change the mood: the layer updates in place and keeps its position, masks and effects.

MAKE 3D FROM A LAYER
- Send the active layer, or just the part inside your selection, to Meshy, Tripo, Hitem3D (hi3d.ai) or your own ComfyUI. Transparency is kept, so cut-out objects give the cleanest models.
- Jobs run in the background with progress. They keep going if you close the panel and continue after a restart.
- Up to date with each service: Meshy 7.1 and Smart Topology, Tripo v3.1, P1/P2 and the v3.5 texture model, hi3d v3.0, and TRELLIS.2 in ComfyUI.

POSE AND LIGHT
- A full 3D editor: turn, tilt, roll and scale; camera views and field of view.
- Seven light presets (Studio, Golden Hour, Noon, Dramatic, Rim, Soft, Moonlight), a sun you drag, color temperature, ten lighting environments, cast and contact shadows.
- Export up to 8192 px or match the document. The result is a smart object with a transparent background.

RE-POSE ANY TIME
- Every 3D layer remembers its model, pose and lighting inside the document. Double-click it to open the editor again; Update Layer replaces the render in place.

YOUR 3D LIBRARY
- Every model is stored on your computer with a preview, so it opens instantly and never expires.
- Folders, search and favorites; drag models into folders, select several to move or remove them.
- Bring your own models: GLB, glTF, FBX, OBJ, DAE, USDZ, 3DS, STL, PLY, 3MF, AMF, VRML and VOX. Drag files or whole folders onto the panel, pick them, or copy them into the Import folder. Textures and materials are packed in.
- Browse the models you already made on Meshy, Tripo, Hitem3D or ComfyUI and import them in one click.
- No account yet? Try the sample model that comes with the plugin.

REQUIREMENTS
- To generate models: an account and API key with Meshy, Tripo or Hitem3D (their own credits apply), or ComfyUI with TRELLIS.2 on your computer (free and open source; a strong GPU is recommended). These are third-party services and apps, not part of this plugin.
- Posing, lighting, re-posing and the library work without any of them.
- Dropping files onto the panel needs version 27 (2026) or newer.

PRIVACY
The image you choose to send goes only to the service you picked, when you click Generate. API keys stay on your computer. No accounts with Geekatplay Studio, no tracking. The plugin is free and open source (MIT license).

Guide and support: https://github.com/GeekatplayStudio/Photoshop-3D
```

## Categories

3D; Productivity (or the nearest categories offered for Photoshop).

## Tags (300)

```text
3D, image to 3D, 3D model, pose, lighting, relight, layers, smart object, product mockup, Meshy, Tripo, Hitem3D, ComfyUI, TRELLIS, GLB, FBX, OBJ, USDZ, STL, render, AI, open source
```

## Purchase method

Free.

## Support email (1000)

Your support address (shown to users).

## Help URL

```text
https://github.com/GeekatplayStudio/Photoshop-3D#readme
```

## Privacy Policy URL

```text
https://github.com/GeekatplayStudio/Photoshop-3D/blob/main/PRIVACY.md
```

## Terms of Service URL

Optional. The project's MIT license can be linked:

```text
https://github.com/GeekatplayStudio/Photoshop-3D/blob/main/LICENSE
```

## Supported languages (1000)

```text
English
```

## Version details / release notes (1000)

```text
First Marketplace release.
- Turn a layer or selection into a 3D model with Meshy, Tripo, Hitem3D or your own ComfyUI (TRELLIS.2 built in), with background jobs and progress.
- 3D pose and light editor: light presets, a sun you drag, environments, shadows, camera views, export up to 8192 px.
- 3D layers remember their pose and lighting: double-click to re-pose; Update Layer keeps position, masks and effects.
- Library with previews, folders, search, drag and drop, and import of GLB, FBX, OBJ, USDZ, STL and more.
- Browse and import the models you made on each service.
- A sample model to try everything without an account.
```

## Note for Adobe reviewers (1000)

```text
Test without any account:
1. Open a document. Plugins > Geekatplay 3D Layers > 3D Layers.
2. Click "Try the sample model" (or Library tab > "Add a sample model").
3. Double-click the sample: the 3D editor opens. Turn it, pick a light preset, click "Place in Document". A smart object layer appears.
4. Double-click that layer (or "Edit pose & light" in the panel): the editor reopens with the saved pose. Change it, click "Update Layer".
5. Library > Import files... takes GLB, FBX, OBJ, USDZ, STL files.

Generating from a layer uses the user's own Meshy, Tripo or Hitem3D API key (paid third-party services; see test credentials) or a local ComfyUI. Keys are removed with Remove in Settings.

Permissions: network "all" for these services and the user's own ComfyUI address; localFileSystem for the model library (kept outside the plugin folder so updates keep it) and imports from any folder; launchProcess to open the library and log folders.
```
