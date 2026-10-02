# Troubleshooting

First look at the log: **Settings › Diagnostics › Show recent log** (or `logs/photoshop3d.log` in the user-data folder). It records every request, job step, Photoshop operation and error, with credentials masked.

## Installing

The [install guide](INSTALL.md) has the simple version of this table.

| Symptom | Fix |
|---|---|
| Double-clicking the `.ccx` does nothing or opens another app | The Creative Cloud app handles `.ccx` files; open it once, or use the installer script ([Windows](INSTALL.md#on-windows), [Mac](INSTALL.md#on-a-mac)). |
| *Adobe's plugin installer was not found* (older scripts: `UPIA was not found`) | Install or update the Creative Cloud desktop app; it provides Adobe's plugin installer (UPIA). Or double-click the `.ccx`. |
| *not a valid plugin (status -204)* | The file is not a valid `.ccx` (truncated download, or re-zipped by hand). Run the installer again, or download the file again. |
| *No compatible Photoshop found* (`status -411`) | Version 26.0 (Photoshop 2025) or newer is required. Update Photoshop, open it once, then try again. |
| *Could not reach GitHub* | No internet, a proxy or firewall blocks `github.com` / `api.github.com`, or GitHub's rate limit (60 requests/hour per IP) was hit. Try later, or download the `.ccx` in your browser and double-click it. |
| *The downloaded file is damaged (checksum mismatch)* | The download was corrupted on the way. Run the installer again. |
| Plugin not in the Plugins menu | Wait a few seconds after installing; if it still isn't there, restart Photoshop. The installers print whether Adobe's installer lists the plugin. |
| Windows: *Windows protected your PC* when opening `install-windows.cmd` | SmartScreen shows this for scripts from small publishers. Click **More info › Run anyway**, or use the PowerShell line instead. |
| Windows: PowerShell refuses to run `install-windows.ps1` | Use `install-windows.cmd` (it starts PowerShell with `-ExecutionPolicy Bypass` for that one script), or `irm …/install-windows.ps1 \| iex`. |
| macOS: *cannot be opened because it is from an unidentified developer* | Run it with `bash install-macos.command`, or use the `curl … \| bash` one-liner. |

## The panel
| Symptom | Fix |
|---|---|
| The panel's icon is empty when it is collapsed in a dock | Fixed in 0.1.2. Update, then restart Photoshop once (Photoshop reads dock icons at startup). |
| Blank panel or "could not start" | Check the log. Panel pages are copied to the UXP data folder on first start; deleting `%APPDATA%\Adobe\UXP\PluginsStorage\PHSP\<version>\External\com.geekatplay.photoshop3d\PluginData\web` forces a fresh copy. |
| Ctrl/Cmd+V doesn't paste | Photoshop keeps that shortcut. Use the 📋 button next to the field. |
| **Show folder** says `Extension "" is not accepted` | Fixed in 0.1.3: update the plugin. Photoshop then asks whether the plugin may open the folder. Click **Allow** (tick *Remember my choice* to stop being asked). |
| Show folder does nothing | You clicked **Block** with *Remember my choice*. Reinstall the plugin to reset the choice, or open the folder by hand (its path is in Settings › Diagnostics). |
| "Layer … is empty" | The active layer has no pixels; select another layer or make a selection. |
| "32-bit documents are not supported" | Image › Mode › 16 or 8 Bits/Channel. |

## Services
| Symptom | Fix |
|---|---|
| Meshy `401 Invalid API key` | Check the key (Settings › Meshy › Change). Creating tasks needs a paid Meshy plan. |
| Meshy `402` / `429 NoMorePendingTasks` | Out of credits, or too many queued tasks for your plan. |
| Tripo `401 Authentication required` | Wrong or revoked key. The plugin uses Tripo API **v3**; a v2-only key also works. |
| Tripo `code 2010` | Not enough credits. |
| Hitem3D "the Access Key / Secret Key were rejected" | Re-enter both, or paste `AK:SK` into the first field. |
| Hitem3D "balance is too low" | Top up on hi3d.ai. |
| "… is busy; trying again in N s" / "asked to slow down" | The service's rate limit (for example Tripo's 10 tasks at once). The plugin waits as long as the service asks and carries on by itself. |
| "The image is N MB; … accepts up to 20 MB" | Lower **Settings › Generation › Max image size sent**, or crop the layer. |
| A warning in the log: "the service marked … as deprecated" | The service has announced it will retire an endpoint the plugin uses. Please [open an issue](https://github.com/GeekatplayStudio/Photoshop-3D/issues) so the plugin can be updated before it stops working. |
| A finished job fails at "Downloading model" with HTTP 403 | The provider link expired. Click **Retry**: the plugin asks the service for fresh links. Meshy deletes files after 3 days. |
| "The service returned a ZIP archive" | Choose GLB output for that service (the plugin always requests GLB from Meshy/Tripo/Hitem3D; custom ComfyUI workflows must save `.glb`). |

## ComfyUI
| Symptom | Fix |
|---|---|
| "Cannot reach ComfyUI at …" | Start ComfyUI; check the address in Settings. For another machine, start ComfyUI with `--listen` and use its IP. |
| "TRELLIS.2 is not ready: update ComfyUI (missing nodes …)" | Update ComfyUI (TRELLIS.2 nodes are built into recent versions). |
| "… download model files: …" | Open ComfyUI's template **Pixal3D & TRELLIS.2: Image to Model**; it offers to download the models. |
| "… the background-removal model (birefnet.safetensors) is not installed" | The layer has no transparency, so ComfyUI must cut the object out. Cut it out on a transparent layer, or install BiRefNet (the template above downloads it). |
| "The workflow finished but saved no .glb file" | Add a **Save GLB** node to your custom workflow. |
| "This is a regular saved workflow" | In ComfyUI use **Workflow › Export (API)** and choose that file. |
| Job fails with "ComfyUI no longer knows this job" | ComfyUI was restarted while the job was queued; click **Retry**. |
| The model includes background or shadow | Settings › ComfyUI › Object mask: use *layer transparency* and cut the object out first. |

## Importing your own files
| Symptom | Fix |
|---|---|
| "Missing texture: wood.jpg" after an import | Put the texture next to the model (or in a subfolder) and import again. The model was still added, without that texture. |
| "No geometry found in this file" | The file holds no meshes (for example only animation or a camera), or uses a feature the three.js loader does not support. Re-export it from your 3D app as GLB, FBX or OBJ. |
| A file in the Import folder is not picked up | The Library tab must be open. Each file is imported once; to import it again, change or rename it. Check the log (Settings › Diagnostics). |
| The model looks dark or too shiny | Lighting and materials change when converting from Phong/Lambert. Adjust the light in the 3D editor, or export from your 3D app as GLB, which keeps physically based materials exactly. |
| The model is huge, tiny or lying down | The 3D editor fits any size into view; use **Tilt** / **Turn** in the editor to stand it up. |

## The 3D editor
| Symptom | Fix |
|---|---|
| "This model could not be loaded" | The file is missing or not a valid glTF. Re-import it (Browse) or check the library folder. |
| Model looks too dark/bright | Adjust *Env intensity* and *Ambient*, or try another preset or environment. |
| Very large exports fail | Lower the export resolution (WebGL limits depend on the GPU; 4096 is safe on most). |
| Double-click opens the smart object's pixels instead of the editor | Settings › 3D editor › *Double-click a 3D layer to open the 3D editor* is off, or the layer's 3D data was removed (detach/other tools). Use **Edit pose & light** in the panel. |
| "The model … is not in this computer's library" | The PSD came from another computer. Import the model (Browse or Import GLB) and try again. |

## Updates
| Symptom | Fix |
|---|---|
| "Update check failed" | No internet, or GitHub rate limit (60 checks/hour per IP); try later. |
| "The download is corrupted" | The checksum did not match; try again. |
| *Photoshop did not open the installer … choose "Allow"* | You clicked **Block** (or closed) Photoshop's *Request For Permission* dialog. Click **Update** again and choose **Allow**. If you ticked *Remember my choice* with Block, use the [install guide](INSTALL.md) instead. |
| Update did nothing | Creative Cloud may be waiting for you to confirm the install; look for its window. Or follow the [install guide](INSTALL.md), which always installs the latest release. |

## Reporting a problem
Open an issue at https://github.com/GeekatplayStudio/Photoshop-3D/issues. Attach the recent log (Settings › Diagnostics); it contains no API keys.
