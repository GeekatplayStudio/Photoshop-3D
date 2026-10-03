/*
 * The API changes each service published up to 2026-10-02 (see docs/PROVIDERS.md):
 * Meshy (Sep 2026 changelog), Tripo (P2, texture model v3.5), Hitem3D (shading, error
 * codes), ComfyUI 0.38 (jobs API), and the rate-limit / deprecation headers.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { PNG_1PX, context, json, parseMultipart, route, scriptedFetch } from "../../../tests/unit/helpers";
import { DEFAULT_SETTINGS, sanitizeSettings } from "@shared/settings";
import { HttpError, errorExtras, requestJson, retryAfterMs } from "../platform/http";
import { buildImageTo3dBody, meshy } from "./meshy";
import { buildImageToModelBody, tripo, tripoFaceLimitRange } from "./tripo";
import { buildSubmitFields, clearHitem3dTokenCache, hitem3d } from "./hitem3d";
import { comfyui, checkTrellis2 } from "./comfyui";
import { pickModelFile } from "./comfyWorkflows";

const input = { image: PNG_1PX, width: 1, height: 1, hasAlpha: true, name: "Chair" };

describe("rate limits, deprecations and error details", () => {
    it("reads how long a service asks us to wait", () => {
        const h = (o: Record<string, string>) => new Headers(o);
        expect(retryAfterMs(h({ "Retry-After": "12" }))).toBe(12_000);
        expect(retryAfterMs(h({ "Retry-After": new Date(1_000_000 + 5000).toUTCString() }), 1_000_000)).toBeGreaterThanOrEqual(4000);
        expect(retryAfterMs(h({ "X-RateLimit-Reset": "3" }))).toBe(3000);
        expect(retryAfterMs(h({ "X-RateLimit-Reset": "1790000010" }), 1_790_000_000_000)).toBe(10_000);
        expect(retryAfterMs(h({}))).toBeUndefined();
    });

    it("keeps the service's code, suggestion and request id in the error", async () => {
        expect(errorExtras({ code: 2010, message: "Not enough credits", suggestion: "Top up", request_id: "req-9" }, "Not enough credits", 403)).toBe(" (Top up) [code 2010, request req-9]");
        const fetch = scriptedFetch([route("POST", /x$/, () => json({ code: 2000, message: "Too many concurrent tasks" }, 429, { "Retry-After": "20" }))]);
        const err = (await requestJson(fetch, "https://api.example.com/x", { method: "POST", label: "Tripo" }).catch((e: unknown) => e)) as HttpError;
        expect(err).toBeInstanceOf(HttpError);
        expect(err.message).toBe("Tripo error 429: Too many concurrent tasks [code 2000]");
        expect(err.retryAfterMs).toBe(20_000);
    });

    it("logs an endpoint the service marked deprecated, once", async () => {
        const fetch = scriptedFetch([route("GET", /old$/, () => json({ ok: 1 }, 200, { Deprecation: "@1790000000", Link: '<https://docs.meshy.ai/en/api/changelog>; rel="deprecation"' }))]);
        const ctx = context(fetch);
        await requestJson(fetch, "https://api.example.com/v2/old", { label: "Meshy" }, ctx.log);
        await requestJson(fetch, "https://api.example.com/v2/old", { label: "Meshy" }, ctx.log);
        const warnings = ctx.log.lines.filter((l) => /deprecated/.test(l));
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatch(/^warn .*GET api\.example\.com\/v2\/old .*changelog/);
    });
});

describe("Meshy (Sep 2026)", () => {
    const base = "https://api.meshy.ai";
    const secrets = { "meshy.apiKey": "msy_testkey123456" };

    it("asks for a transparent preview and uses it", async () => {
        expect(buildImageTo3dBody(DEFAULT_SETTINGS.meshy, "d")).toMatchObject({ alpha_thumbnail: true, moderation: true });
        expect(buildImageTo3dBody({ ...DEFAULT_SETTINGS.meshy, moderation: false }, "d")).not.toHaveProperty("moderation");
        const fetch = scriptedFetch([
            route("GET", /image-to-3d\/t1$/, () => json({ status: "SUCCEEDED", model_urls: { glb: "https://cdn/m.glb" }, thumbnail_url: "https://cdn/t.png", alpha_thumbnail_url: "https://cdn/alpha.png" })),
        ]);
        const res = await meshy.poll(context(fetch, {}, secrets), "t1", { kind: "image-to-3d" });
        expect(res.result?.thumbnailUrl).toBe("https://cdn/alpha.png");
        expect(base).toBe(DEFAULT_SETTINGS.meshy.baseUrl);
    });

    it("sends Smart Topology (meshy-t2) with only its own fields", () => {
        const body = buildImageTo3dBody({ ...DEFAULT_SETTINGS.meshy, aiModel: "meshy-t2", targetPolycount: 40_000, shouldRemesh: true, geometryResolution: "4k", textureResolution: "4k" }, "d");
        expect(body).toMatchObject({ model_type: "smart-topology", ai_model: "meshy-t2", target_polycount: 15_000, alpha_thumbnail: true });
        for (const field of ["should_remesh", "topology", "geometry_resolution", "texture_resolution", "remove_lighting", "image_enhancement"]) expect(body).not.toHaveProperty(field);
    });

    it("moves saved settings off retired models", () => {
        expect(sanitizeSettings({ meshy: { aiModel: "meshy-7" } }).meshy.aiModel).toBe("meshy-7.1");
        expect(sanitizeSettings({ meshy: { aiModel: "meshy-5" } }).meshy.aiModel).toBe("meshy-6-lite");
        expect(sanitizeSettings({ meshy: { aiModel: "meshy-9-preview" } }).meshy.aiModel).toBe("meshy-9-preview");
    });
});

describe("Tripo (P2, texture model v3.5)", () => {
    const t = DEFAULT_SETTINGS.tripo;

    it("sends the v3.5 texture model with delight, and fast quality only with it", () => {
        expect(buildImageToModelBody(t, "tok")).not.toHaveProperty("texture_version");
        expect(buildImageToModelBody({ ...t, textureVersion: "v3.5-20260815", delight: false }, "tok")).toMatchObject({ texture_version: "v3.5-20260815", delight: false });
        expect(buildImageToModelBody({ ...t, textureVersion: "v3.0-20250812" }, "tok")).not.toHaveProperty("delight");
        expect(buildImageToModelBody({ ...t, textureQuality: "fast" }, "tok")).toMatchObject({ texture_quality: "fast", texture_version: "v3.5-20260815", delight: true });
        expect(sanitizeSettings({ tripo: { textureQuality: "fast", textureVersion: "" } }).tripo.textureQuality).toBe("standard");
        expect(sanitizeSettings({ tripo: { textureQuality: "fast", textureVersion: "v3.5-20260815" } }).tripo.textureQuality).toBe("fast");
    });

    it("keeps v3-only fields off v2.5 and the P series", () => {
        const v25 = buildImageToModelBody({ ...t, model: "v2.5-20250123", autoSize: true, smartLowPoly: true }, "tok");
        for (const field of ["auto_size", "geometry_quality", "smart_low_poly"]) expect(v25).not.toHaveProperty(field);
        const p2 = buildImageToModelBody({ ...t, model: "P2-20260801", textureVersion: "v3.5-20260815", autoSize: true }, "tok");
        for (const field of ["auto_size", "geometry_quality", "texture_version", "delight"]) expect(p2).not.toHaveProperty(field);
        expect(buildImageToModelBody({ ...t, autoSize: true }, "tok")).toMatchObject({ auto_size: true, geometry_quality: "standard" });
    });

    it("clamps the face limit to each model's documented range", () => {
        expect(tripoFaceLimitRange("P2-20260801", { geometryQuality: "standard", smartLowPoly: false })).toEqual([50, 50_000]);
        expect(buildImageToModelBody({ ...t, model: "P1-20260311", faceLimit: 100_000 }, "tok").face_limit).toBe(20_000);
        expect(buildImageToModelBody({ ...t, faceLimit: 1_800_000 }, "tok").face_limit).toBe(1_500_000);
        expect(buildImageToModelBody({ ...t, faceLimit: 1_800_000, geometryQuality: "detailed" }, "tok").face_limit).toBe(1_800_000);
        expect(buildImageToModelBody({ ...t, faceLimit: 200, smartLowPoly: true }, "tok").face_limit).toBe(500);
        expect(buildImageToModelBody({ ...t, model: "v4.0-20270101", faceLimit: 3_000_000 }, "tok").face_limit).toBe(3_000_000);
    });

    it("treats an unknown task status as failed and refuses images over 20 MB", async () => {
        const fetch = scriptedFetch([route("GET", /tasks\/t1$/, () => json({ code: 0, data: { status: "archived" } }))]);
        const ctx = context(fetch, {}, { "tripo.apiKey": "tsk_x" });
        expect(await tripo.poll(ctx, "t1")).toMatchObject({ state: "failed", error: expect.stringMatching(/unknown task status "archived"/) });
        await expect(tripo.submit(ctx, { ...input, image: new Uint8Array(21 * 1024 * 1024) })).rejects.toThrow(/up to 20 MB/);
    });
});

describe("Hitem3D (shading, error codes)", () => {
    const base = "https://api.hitem3d.ai/open-api/v1";
    const secrets = { "hitem3d.accessKey": "AK123", "hitem3d.secretKey": "SK456" };
    beforeEach(() => clearHitem3dTokenCache());

    it("sends de-shading only when changed and supported", () => {
        const h = DEFAULT_SETTINGS.hitem3d;
        expect(buildSubmitFields(h)).not.toHaveProperty("shading");
        expect(buildSubmitFields({ ...h, shading: 0.8 }).shading).toBe("0.8");
        expect(buildSubmitFields({ ...h, model: "hitem3dv1.5", resolution: "1024", shading: 0.8 })).not.toHaveProperty("shading");
        expect(buildSubmitFields({ ...h, requestType: "1", shading: 0.8 })).not.toHaveProperty("shading");
        expect(sanitizeSettings({ hitem3d: { shading: 0.77 } }).hitem3d.shading).toBe(0.8);
    });

    it("explains documented error codes", async () => {
        const fetch = scriptedFetch([
            route("POST", `${base}/auth/token`, () => json({ code: 200, data: { accessToken: "tok", tokenType: "Bearer" } })),
            route("POST", `${base}/submit-task`, (call) => {
                expect(parseMultipart(call.body, call.headers["content-type"]).files.images).toBeTruthy();
                return json({ code: 10031002, msg: "Face not valid" });
            }),
        ]);
        await expect(hitem3d.submit(context(fetch, {}, secrets), input)).rejects.toThrow(/face count is outside the range .* \(Face not valid\) \[code 10031002\]/);
        await expect(hitem3d.submit(context(fetch, {}, secrets), { ...input, image: new Uint8Array(21 * 1024 * 1024) })).rejects.toThrow(/up to 20 MB/);
    });
});

describe("ComfyUI 0.38 (jobs API, installed model files)", () => {
    const base = "http://127.0.0.1:8188";

    it("browses with the jobs API and finds GLBs hidden behind an image preview", async () => {
        const fetch = scriptedFetch([
            route("GET", /\/api\/jobs\?status=completed&sort_order=desc&limit=10&offset=0$/, () =>
                json({
                    jobs: [
                        { id: "a", status: "completed", execution_start_time: 30, outputs_count: 1, preview_output: { filename: "trellis2_00002_.glb", subfolder: "photoshop3d", type: "output", mediaType: "3d" } },
                        { id: "b", status: "completed", execution_start_time: 20, outputs_count: 2, preview_output: { filename: "shot.png", subfolder: "", type: "output", mediaType: "images" } },
                        { id: "c", status: "completed", execution_start_time: 10, outputs_count: 1, preview_output: { filename: "only.png", subfolder: "", type: "output", mediaType: "images" } },
                    ],
                    pagination: { offset: 0, limit: 10, total: 13, has_more: true },
                }),
            ),
            route("GET", `${base}/api/jobs/b`, () => json({ id: "b", outputs: { "7": { images: [{ filename: "shot.png" }] }, "9": { "3d": [{ filename: "mesh_00001_.glb", subfolder: "3d", type: "output" }] } } })),
        ]);
        const page = await comfyui.list!(context(fetch), 1, 10);
        expect(page.items.map((i) => [i.remoteId, i.name])).toEqual([
            ["a", "trellis2_00002"],
            ["b", "mesh_00001"],
        ]);
        expect(page.hasMore).toBe(true);
        expect(fetch.calls.some((c) => /\/history/.test(c.url))).toBe(false);
    });

    it("cancels through the jobs API, and through the old routes on older servers", async () => {
        const modern = scriptedFetch([route("POST", `${base}/api/jobs/p1/cancel`, () => json({ cancelled: true }))]);
        await comfyui.cancel!(context(modern), "p1");
        expect(modern.calls.map((c) => c.url)).toEqual([`${base}/api/jobs/p1/cancel`]);

        const old = scriptedFetch([
            route("POST", `${base}/api/jobs/p1/cancel`, () => json({ error: "Not Found" }, 404)),
            route("GET", `${base}/queue`, () => json({ queue_running: [[1, "p1"]], queue_pending: [] })),
            route("POST", `${base}/interrupt`, () => json({})),
        ]);
        await comfyui.cancel!(context(old), "p1");
        expect(old.calls.map((c) => `${c.method} ${c.url.replace(base, "")}`)).toEqual(["POST /api/jobs/p1/cancel", "GET /queue", "POST /interrupt"]);
    });

    it("uses the model files that are installed", async () => {
        expect(pickModelFile(["a.safetensors", "trellis/trellis_2_int8_convrot.safetensors"], "trellis_2_int8_convrot.safetensors")).toBe("trellis/trellis_2_int8_convrot.safetensors");
        expect(pickModelFile(["dino_v3_vit_l.safetensors"], "dino_v3_L_naf_fp32.safetensors", /^dino_v3.*\.safetensors$/i)).toBe("dino_v3_vit_l.safetensors");
        expect(pickModelFile(["clip_vision_h.safetensors"], "dino_v3_L_naf_fp32.safetensors", /^dino_v3.*\.safetensors$/i)).toBeUndefined();

        const combo = (options: string[]) => ["COMBO", { options }];
        const defs: Record<string, unknown> = {
            UNETLoader: { input: { required: { unet_name: combo(["trellis_2_bf16.safetensors"]) } } },
            VAELoader: { input: { required: { vae_name: combo(["trellis_2_shape_vae_bf16.safetensors", "trellis_2_texture_vae_bf16.safetensors"]) } } },
            CLIPVisionLoader: { input: { required: { clip_name: [["dino_v3_vit_l.safetensors"]] } } },
            LoadBackgroundRemovalModel: { input: { required: { bg_removal_name: combo([]) } } },
        };
        let queued: Record<string, { inputs: Record<string, unknown> }> = {};
        const fetch = scriptedFetch([
            route("GET", /\/object_info\/(\w+)$/, (call) => {
                const name = /object_info\/(\w+)$/.exec(call.url)![1];
                return json(defs[name] ? { [name]: defs[name] } : {});
            }),
            route("POST", `${base}/upload/image`, () => json({ name: "x.png", subfolder: "photoshop3d" })),
            route("POST", `${base}/prompt`, (call) => {
                queued = JSON.parse(call.body as string).prompt;
                return json({ prompt_id: "p1" });
            }),
        ]);
        const ctx = context(fetch);
        await comfyui.submit(ctx, input);
        expect(queued["40"].inputs.unet_name).toBe("trellis_2_bf16.safetensors");
        expect(queued["15"].inputs.clip_name).toBe("dino_v3_vit_l.safetensors");
        // An opaque image needs BiRefNet, which is not installed here.
        await expect(comfyui.submit(ctx, { ...input, hasAlpha: false })).rejects.toThrow(/background-removal model \(birefnet\.safetensors\) is not installed/);
        // The TRELLIS.2 nodes are missing from this fake server, but the files are not reported missing.
        expect((await checkTrellis2(ctx)).join("; ")).not.toMatch(/download model files/);
        const test = await comfyui.test(
            context(
                scriptedFetch([
                    route("GET", `${base}/system_stats`, () => json({ system: { comfyui_version: "0.38.0" }, devices: [] })),
                    route("GET", /\/object_info\/(\w+)$/, (call) => {
                        const name = /object_info\/(\w+)$/.exec(call.url)![1];
                        return json({ [name]: defs[name] ?? { input: { required: {} } } });
                    }),
                ]),
            ),
        );
        expect(test).toMatchObject({ ok: true, message: expect.stringMatching(/Note: the background-removal model \(birefnet\.safetensors\) is missing/) });
    });
});
