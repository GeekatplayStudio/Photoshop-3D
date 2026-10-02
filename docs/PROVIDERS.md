# 3D services: exactly what the plugin sends

Every request goes from the UXP host (not the WebView) and is logged in `logs/photoshop3d.log` with its status and time, without credentials. These API facts were checked against each service's official documentation **and changelog** on 2026-10-02 (links below). Each endpoint was also probed live without credentials to confirm it exists and to record its error format.

**For every service:**
- **Rate limits:** a `429` answer waits as long as the service asks (`Retry-After`, or `X-RateLimit-Reset`). While polling, that wait doesn't count as an error; a submission is retried up to 4 times. See `src/host/platform/http.ts` and `src/host/services/jobs.ts`.
- **Deprecations:** a response with a `Deprecation` header (Meshy sends one, with a `Link` to the migration notes) writes a warning to the log, once per endpoint. A retirement then shows up in the log long before the endpoint stops working.
- **Error details:** error messages keep the service's own `code`, `suggestion` and `request_id`, because support asks for them.

## Meshy — `src/host/providers/meshy.ts`

Base URL: `https://api.meshy.ai` (configurable). Auth: `Authorization: Bearer <msy_…>`. Docs: https://docs.meshy.ai · changelog: https://docs.meshy.ai/en/api/changelog

| Action | Request | Notes |
|---|---|---|
| Generate | `POST /openapi/v1/image-to-3d` with JSON `{ image_url: "data:image/png;base64,…", ai_model, should_texture, enable_pbr, should_remesh, target_formats: ["glb"], alpha_thumbnail: true, … }` → `{ result: "<task id>" }` | The layer goes as a data URI; there is no upload step. `alpha_thumbnail` asks for a transparent preview. Optional fields are only sent where the model supports them: `topology`/`target_polycount` (remesh), `texture_resolution` (not meshy-6-lite), `geometry_resolution` (meshy-7.1/latest), `remove_lighting` (meshy-6), `image_enhancement` (meshy-6, 7.1, latest). **Smart Topology** (`meshy-t2`) is sent as `{ model_type: "smart-topology", ai_model: "meshy-t2", target_polycount 100–15,000, should_texture, enable_pbr }` without the remesh/resolution fields. |
| Poll | `GET /openapi/v1/image-to-3d/{id}` | `status` PENDING / IN_PROGRESS / SUCCEEDED / FAILED / CANCELED, `progress` 0–100, `preceding_tasks`, `model_urls.glb`, `alpha_thumbnail_url` (preferred) / `thumbnail_url`, `task_error.message`, `expires_at`, `consumed_credits` |
| Browse | `GET /openapi/v1/image-to-3d`, `/openapi/v1/multi-image-to-3d`, `/openapi/v2/text-to-3d` with `page_num`, `page_size`, `sort_by=-created_at` | Each returns a bare array. Only tasks created through the API with this key are listed. |
| Cancel | `DELETE /openapi/v1/image-to-3d/{id}` | PENDING tasks are refunded; IN_PROGRESS answers 409 (the task keeps running). |
| Test | `GET /openapi/v1/balance` → `{ balance }` | |

Assets are kept for **3 days**, and URLs are signed until `expires_at`. Models: `latest` (= Meshy 7.1), `meshy-7.1`, `meshy-6`, `meshy-6-lite`, `meshy-t2` (Smart Topology). Saved settings that name a retired or deprecated model are moved to its successor: `meshy-7` → `meshy-7.1`, `meshy-5` (retired 2026-10-10) → `meshy-6-lite`, `meshy-4` → `latest`, `meshy-t1` → `meshy-t2`. Deprecated fields the plugin never sends: `ultra_mode`, `hd_texture`, `symmetry_mode`, `is_a_t_pose`, `model_type: "lowpoly"`. The legacy `/v2/text-to-3d` path (without `/openapi`, deprecated 2026-09-29) isn't used either. Without a valid key the API answers HTTP 401 `{"message":"Invalid API key"}`. 429 answers carry `Retry-After` (since 2026-09-28).

## Tripo (API v3) — `src/host/providers/tripo.ts`

Base URL: `https://openapi.tripo3d.ai/v3` (configurable; China-region keys use `https://openapi.tripo3d.com/v3`). Auth: `Authorization: Bearer <tsk_…>`. Docs: https://developers.tripo3d.ai · changelog: https://developers.tripo3d.ai/en/docs/changelog. **API v2 (`api.tripo3d.ai/v2/openapi`) stops on 2026-11-01 00:00 UTC+8**, which is why the plugin uses v3.

| Action | Request | Notes |
|---|---|---|
| Upload | `POST /files` (multipart `file`, PNG/JPEG/WebP up to **20 MB**) → `data.file_token` | v3 rejects data URIs. Larger images are refused before upload with a clear message. |
| Generate | `POST /generation/image-to-model` with `{ input: file_token, model, texture, pbr, orientation, texture_quality?, texture_version?, delight?, auto_size?, geometry_quality?, smart_low_poly?, face_limit? }` → `data.task_id` | **Models:** H series `v3.1-20260211` (latest), `v3.0-20250812`, `v2.5-20250123`; P series `P1-20260311`, `P2-20260801` (preview). `auto_size`, `geometry_quality` and `smart_low_poly` are sent only for H-series v3.x models. **Texture model** (`texture_version`): `v3.5-20260815` (newest; adds `texture_quality: "fast"` and `delight`), `v3.0-20250812`, `v2.5-20250123`, or left out for Tripo's default. Not sent for the P series. **`face_limit`** is clamped to the documented range: v3.1 ≤ 1.5 M (2 M with detailed geometry), v3.0 ≤ 1 M (2 M detailed), v2.5 ≤ 500 k, P1 50–20,000, P2 50–50,000, smart low-poly 500–20,000. **`quad`** is never sent, because it forces FBX output. |
| Poll | `GET /tasks/{id}` | `data.status` queued / running / success / failed / cancelled (banned and expired count as failed; any other status counts as failed, as Tripo's v3 migration guide asks), `progress`, `output.model_url`, `output.rendered_image_url`, `error_code`, `error_message` |
| Browse | `GET /account/usage?limit&offset` → task ids, then `POST /tasks/list { task_ids }` → `{ tasks, missed }` | Tripo has no "list my models" endpoint; this is the documented way to rebuild history. |
| Test | `GET /account/balance` → `data.balance`, `data.frozen` | |

The envelope is `{ code: 0, data }`; errors look like `{ code, status: "error", message, suggestion, request_id }` (HTTP 401 for a bad key, 403 with code 2010 for too few credits, 429 with code 2000 when too many tasks run at once). Default concurrency is 10 tasks for the H series and 5 for the P series. Result URLs last about 24 h, and querying the task again gives fresh ones. There is no cancel API.

## Hitem3D / Hi3D — `src/host/providers/hitem3d.ts`

Base URL: `https://api.hitem3d.ai/open-api/v1` (configurable; still the API host, there is no v2). Keys: https://platform.hi3d.ai/console/apiKey. Docs: https://docs.hi3d.ai (docs.hitem3d.ai redirects there) · changelog: https://docs.hi3d.ai/en/api/api-reference/changelog

| Action | Request | Notes |
|---|---|---|
| Sign in | `POST /auth/token` with `Authorization: Basic base64(AK:SK)` → `data.accessToken`, `data.tokenType` | The token is cached for 50 minutes. When a call answers `code 401` / "login expired", the plugin signs in again once and retries. A credential without `:` is used directly as a bearer token. An optional `Appid` header is sent when set. |
| Generate | `POST /submit-task` (multipart): `images` (PNG, up to **20 MB**), `request_type`, `model`, `resolution`, `format=2` (GLB; the API default is OBJ), `rmbg`, `face?`, `pbr?`, `shading?` → `data.task_id` | `pbr` and `shading` (de-shading strength 0–1, added 2026-08-04; default 0.5, sent only when changed) are sent only for v2.0, v2.1 and v3.0 models with textures. Larger images are refused before upload. |
| Poll | `GET /query-task?task_id=` | `data.state` created / queueing / processing / success / failed, `data.url` (model) and `data.cover_url`, both valid for **1 hour**. Older response shapes (`task_status`, `task_result.model_url`) are also understood. |
| Browse | — | No list endpoint exists. The plugin shows its own task history (`history.json`) and refreshes each task's state. "Track a task ID" adds any task. |
| Test | `GET /balance` → `data.totalBalance` | |

Errors arrive as HTTP 200 with a non-200 `code`, and the plugin explains them in plain language:
- **Sign-in and account:** `401` (token expired), `40010000` (bad AK/SK), `30010000` (balance too low).
- **Generation:** `50010001` (generation failed, refunded), `10000000` (system error).
- **Submit validation:**
  - `10031001` (file over 20 MB)
  - `10031002` (face count out of range): the parameter table says 100,000–5,000,000, but this error's text says 100,000–2,000,000.
  - `10031003` (resolution), `10031005` (image type), `10031006` (model), `10031010` (empty file), `10031017` (texturing an existing mesh is not supported).

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

Base URL: your server (default `http://127.0.0.1:8188`). No auth. Checked against ComfyUI **0.38.0** (2026-09-29): `server.py`, `openapi.yaml` and the live `/object_info`. Changelog: https://docs.comfy.org/changelog. Routes work with and without the `/api` prefix, except the jobs API, which exists only as `/api/jobs`.

| Action | Request |
|---|---|
| Upload | `POST /upload/image` (multipart `image`, `subfolder=photoshop3d`, `type=input`, `overwrite=true`) → `{ name, subfolder }` |
| Run | `POST /prompt { prompt: <API workflow>, client_id }` → `{ prompt_id }`; validation errors (`node_errors`) are shown per node |
| Poll | `GET /history/{prompt_id}`; while it is absent, `GET /queue` gives queued vs running. Progress is estimated from elapsed time, since ComfyUI has no HTTP progress. |
| Result | The first `.glb`/`.gltf` in the history outputs (`SaveGLB` reports `outputs[node]["3d"] = [{filename, subfolder, type}]`; legacy `Preview3D` reports a path string), downloaded from `GET /view?filename&subfolder&type=output` |
| Browse | `GET /api/jobs?status=completed&sort_order=desc&limit&offset` (jobs API, ComfyUI ≥ 0.6) → `{ jobs: [{ id, preview_output: { filename, subfolder, type, mediaType }, outputs_count, execution_start_time }], pagination: { has_more } }`. A job whose preview is not the 3D file but which has several outputs is read in full with `GET /api/jobs/{id}`. Older servers: `GET /history?max_items=500`. |
| Cancel | `POST /api/jobs/{id}/cancel` → `{ cancelled }` (ComfyUI ≥ 0.26; it interrupts only if that job is the one running). Older servers: `POST /interrupt { prompt_id }` while running, `POST /queue { delete: [id] }` while queued. ComfyUI 0.38 marks those two deprecated. |
| Test | `GET /system_stats`; for TRELLIS.2 also `GET /object_info/<node>` to check that the nodes and model files are present, including the BiRefNet background-removal model (`LoadBackgroundRemovalModel`), which only opaque images need |

**Built-in TRELLIS.2 workflow:**

- **Source:** the Comfy-Org template *3d_pixal3d_trellis2_image_to_model*, reduced to its TRELLIS.2 branch, with `Save3DAdvanced` replaced by core `SaveGLB`.
- **Pipeline:**
  - **Object mask:** either `InvertMask(LoadImage.mask)` (the layer's transparency; `LoadImage` returns 1 − alpha) or BiRefNet `RemoveBackground`.
  - **Image prep and conditioning:** `ImageCropToMask` (1024²), then DINOv3 conditioning.
  - **Shape and texture:** structure → shape → upsample (1536) → texture sampling.
  - **Mesh clean-up:** remesh (UDF 768), decimate to *max faces*, then UV unwrap.
  - **Baking:** base colour / metallic / roughness, normal and AO at *texture size*; then `SaveGLB` to `output/photoshop3d/`.
- **Verified:** ComfyUI 0.38, RTX 3090, about 4.5 min, about 30 MB textured GLB.

**Model files:** the plugin uses whichever file is installed for each loader. That can be the template's name, the same name in a subfolder (e.g. `trellis/trellis_2_int8_convrot.safetensors`), or a documented alternative: another `trellis_2*.safetensors` diffusion model such as `trellis_2_bf16.safetensors`, or `dino_v3_vit_l.safetensors` for DINOv3. If an opaque image needs BiRefNet and it is missing, the job stops with a clear message instead of failing inside ComfyUI.

**Custom workflows** are API-format JSON (*Workflow › Export (API)*). The plugin puts the uploaded image into the chosen or detected `LoadImage` node, sets every `seed`/`noise_seed`, and looks for a 3D file in the outputs.

## Adding another service

See [ARCHITECTURE.md › Adding a 3D service](ARCHITECTURE.md#adding-a-3d-service).
