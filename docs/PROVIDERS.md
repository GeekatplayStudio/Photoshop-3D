# 3D services: exactly what the plugin sends

Every request goes from the UXP host (not the WebView) and is logged in `logs/photoshop3d.log` with its status and time, without credentials. These API facts were checked against each service's official documentation on 2026-10-02. Each endpoint was also probed live without credentials to confirm it exists and to record its error format.

## Meshy — `src/host/providers/meshy.ts`

Base URL: `https://api.meshy.ai` (configurable). Auth: `Authorization: Bearer <msy_…>`. Docs: https://docs.meshy.ai

| Action | Request | Notes |
|---|---|---|
| Generate | `POST /openapi/v1/image-to-3d` with JSON `{ image_url: "data:image/png;base64,…", ai_model, should_texture, enable_pbr, should_remesh, target_formats: ["glb"], … }` → `{ result: "<task id>" }` | The layer goes as a data URI; there is no upload step. Optional fields are only sent where the model supports them: `topology`/`target_polycount` (remesh), `texture_resolution` (not meshy-6-lite), `geometry_resolution` (meshy-7.1/latest), `remove_lighting` (meshy-6), `image_enhancement`. |
| Poll | `GET /openapi/v1/image-to-3d/{id}` | `status` PENDING / IN_PROGRESS / SUCCEEDED / FAILED / CANCELED, `progress` 0–100, `preceding_tasks`, `model_urls.glb`, `thumbnail_url`, `task_error.message`, `expires_at` |
| Browse | `GET /openapi/v1/image-to-3d`, `/openapi/v1/multi-image-to-3d`, `/openapi/v2/text-to-3d` with `page_num`, `page_size`, `sort_by=-created_at` | Each returns a bare array. Only tasks created through the API with this key are listed. |
| Cancel | `DELETE /openapi/v1/image-to-3d/{id}` | PENDING tasks are refunded; IN_PROGRESS answers 409 (the task keeps running). |
| Test | `GET /openapi/v1/balance` → `{ balance }` | |

Assets are kept for **3 days**, and URLs are signed until `expires_at`. Models: `latest` (= Meshy 7.1), `meshy-7.1`, `meshy-6`, `meshy-6-lite`; `meshy-5` is retired on 2026-10-10. Without a valid key the API answers HTTP 401 `{"message":"Invalid API key"}`.

## Tripo (API v3) — `src/host/providers/tripo.ts`

Base URL: `https://openapi.tripo3d.ai/v3` (configurable). Auth: `Authorization: Bearer <tsk_…>`. Docs: https://developers.tripo3d.ai. **API v2 (`api.tripo3d.ai/v2/openapi`) stops on 2026-11-01**, which is why the plugin uses v3.

| Action | Request | Notes |
|---|---|---|
| Upload | `POST /files` (multipart `file`) → `data.file_token` | v3 rejects data URIs. |
| Generate | `POST /generation/image-to-model` with `{ input: file_token, model, texture, pbr, texture_quality, auto_size, orientation, face_limit?, geometry_quality?, smart_low_poly? }` → `data.task_id` | `geometry_quality` and `smart_low_poly` are sent only for v3.x models (not P1). `quad` is never sent, because it forces FBX output. |
| Poll | `GET /tasks/{id}` | `data.status` queued / running / success / failed / cancelled (banned and expired count as failed), `progress`, `output.model_url`, `output.rendered_image_url`, `error_code`, `error_message` |
| Browse | `GET /account/usage?limit&offset` → task ids, then `POST /tasks/list { task_ids }` → `{ tasks, missed }` | Tripo has no "list my models" endpoint; this is the documented way to rebuild history. |
| Test | `GET /account/balance` → `data.balance`, `data.frozen` | |

The envelope is `{ code: 0, data }`; errors look like `{ code, status: "error", message, suggestion }` (HTTP 401 for a bad key). Result URLs last about 24 h, and querying the task again gives fresh ones. There is no cancel API.

## Hitem3D / Hi3D — `src/host/providers/hitem3d.ts`

Base URL: `https://api.hitem3d.ai/open-api/v1` (configurable). Docs: https://docs.hitem3d.ai

| Action | Request | Notes |
|---|---|---|
| Sign in | `POST /auth/token` with `Authorization: Basic base64(AK:SK)` → `data.accessToken`, `data.tokenType` | The token is cached for 50 minutes. When a call answers `code 401` / "login expired", the plugin signs in again once and retries. A credential without `:` is used directly as a bearer token. An optional `Appid` header is sent when set. |
| Generate | `POST /submit-task` (multipart): `images` (PNG), `request_type`, `model`, `resolution`, `format=2` (GLB; the API default is OBJ), `rmbg`, `face?`, `pbr?` → `data.task_id` | `pbr` only for v2.0, v2.1 and v3.0 models with textures. |
| Poll | `GET /query-task?task_id=` | `data.state` created / queueing / processing / success / failed, `data.url` (model) and `data.cover_url`, both valid for **1 hour**. Older response shapes (`task_status`, `task_result.model_url`) are also understood. |
| Browse | — | No list endpoint exists. The plugin shows its own task history (`history.json`) and refreshes each task's state. "Track a task ID" adds any task. |
| Test | `GET /balance` → `data.totalBalance` | |

Errors arrive as HTTP 200 with a non-200 `code`: `401` (token expired), `40010000` (bad AK/SK), `30010000` (balance too low), `50010001` (generation failed, refunded).

| Model | Resolutions (first = default) |
|---|---|
| `hi3dv3.0` (default) | `2048quality`, `2048master` |
| `hitem3dv2.1` | `1536fast`, `1536pro` |
| `hitem3dv2.0` | `1536`, `1536pro` |
| `hitem3dv1.5` | `1024`, `512`, `1536`, `1536pro` |
| `scene-portraitv2.1` | `1536profast`, `1536pro` |
| `scene-portraitv2.0` | `1536pro` |
| `scene-portraitv1.5` | `1536` |

## ComfyUI — `src/host/providers/comfyui.ts`, `comfyWorkflows.ts`

Base URL: your server (default `http://127.0.0.1:8188`). No auth.

| Action | Request |
|---|---|
| Upload | `POST /upload/image` (multipart `image`, `subfolder=photoshop3d`, `type=input`, `overwrite=true`) → `{ name, subfolder }` |
| Run | `POST /prompt { prompt: <API workflow>, client_id }` → `{ prompt_id }`; validation errors (`node_errors`) are shown per node |
| Poll | `GET /history/{prompt_id}`; while it is absent, `GET /queue` gives queued vs running. Progress is estimated from elapsed time, since ComfyUI has no HTTP progress. |
| Result | The first `.glb`/`.gltf` in the history outputs (`SaveGLB` reports `outputs[node]["3d"] = [{filename, subfolder, type}]`; legacy `Preview3D` reports a path string), downloaded from `GET /view?filename&subfolder&type=output` |
| Browse | `GET /history?max_items=500`: every prompt that saved a 3D file |
| Cancel | `POST /interrupt { prompt_id }` while running, `POST /queue { delete: [id] }` while queued |
| Test | `GET /system_stats`; for TRELLIS.2 also `GET /object_info/<node>` to check that nodes and model files are present |

**Built-in TRELLIS.2 workflow:**

- **Source:** the Comfy-Org template *3d_pixal3d_trellis2_image_to_model*, reduced to its TRELLIS.2 branch, with `Save3DAdvanced` replaced by core `SaveGLB`.
- **Pipeline:**
  - **Object mask:** either `InvertMask(LoadImage.mask)` (the layer's transparency; `LoadImage` returns 1 − alpha) or BiRefNet `RemoveBackground`.
  - **Image prep and conditioning:** `ImageCropToMask` (1024²), then DINOv3 conditioning.
  - **Shape and texture:** structure → shape → upsample (1536) → texture sampling.
  - **Mesh clean-up:** remesh (UDF 768), decimate to *max faces*, then UV unwrap.
  - **Baking:** base colour / metallic / roughness, normal and AO at *texture size*; then `SaveGLB` to `output/photoshop3d/`.
- **Verified:** ComfyUI 0.38, RTX 3090, about 4.5 min, about 30 MB textured GLB.

**Custom workflows** are API-format JSON (*Workflow › Export (API)*). The plugin puts the uploaded image into the chosen or detected `LoadImage` node, sets every `seed`/`noise_seed`, and looks for a 3D file in the outputs.

## Adding another service

See [ARCHITECTURE.md › Adding a 3D service](ARCHITECTURE.md#adding-a-3d-service).
