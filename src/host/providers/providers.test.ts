import { beforeEach, describe, expect, it } from "vitest";
import { PNG_1PX, context, json, parseMultipart, route, scriptedFetch } from "../../../tests/unit/helpers";
import { buildImageTo3dBody, meshy } from "./meshy";
import { buildImageToModelBody, tripo } from "./tripo";
import { buildSubmitFields, clearHitem3dTokenCache, hitem3d, isExpiredTokenResponse } from "./hitem3d";
import { comfyui } from "./comfyui";
import { toEpochMs, toPercent } from "./types";
import { DEFAULT_SETTINGS } from "@shared/settings";

const input = { image: PNG_1PX, width: 1, height: 1, hasAlpha: true, name: "Chair" };

describe("provider helpers", () => {
    it("normalises progress and timestamps", () => {
        expect(toPercent(0.42)).toBe(42);
        expect(toPercent("73")).toBe(73);
        expect(toPercent(150)).toBe(100);
        expect(toPercent(undefined)).toBeUndefined();
        expect(toEpochMs(1_700_000_000)).toBe(1_700_000_000_000);
        expect(toEpochMs(1_700_000_000_000)).toBe(1_700_000_000_000);
        expect(toEpochMs("2026-10-02T10:00:00Z")).toBe(Date.parse("2026-10-02T10:00:00Z"));
    });
});

describe("Meshy", () => {
    const base = "https://api.meshy.ai";
    const secrets = { "meshy.apiKey": '"Bearer msy_testkey123456"' };

    it("only sends documented, model-appropriate options", () => {
        const s = DEFAULT_SETTINGS.meshy;
        const body = buildImageTo3dBody(s, "data:x");
        expect(body).toMatchObject({ image_url: "data:x", ai_model: "latest", should_texture: true, enable_pbr: true, should_remesh: false, target_formats: ["glb"], image_enhancement: true });
        expect(body).not.toHaveProperty("remove_lighting");
        expect(body).not.toHaveProperty("topology");
        const remesh = buildImageTo3dBody({ ...s, aiModel: "meshy-6", shouldRemesh: true, topology: "quad", targetPolycount: 50, textureResolution: "4k", geometryResolution: "4k" }, "d");
        expect(remesh).toMatchObject({ topology: "quad", target_polycount: 100, remove_lighting: true, texture_resolution: "4k" });
        expect(remesh).not.toHaveProperty("geometry_resolution"); // 4k geometry needs meshy-7.1/latest
        expect(buildImageTo3dBody({ ...s, aiModel: "meshy-6-lite", textureResolution: "8k" }, "d")).not.toHaveProperty("texture_resolution");
    });

    it("submits a data URI with a clean bearer token", async () => {
        const fetch = scriptedFetch([route("POST", `${base}/openapi/v1/image-to-3d`, () => json({ result: "task-1" }))]);
        const res = await meshy.submit(context(fetch, {}, secrets), input);
        expect(res).toEqual({ remoteId: "task-1", meta: { kind: "image-to-3d", aiModel: "latest" } });
        expect(fetch.calls[0].headers.authorization).toBe("Bearer msy_testkey123456");
        const body = JSON.parse(fetch.calls[0].body as string);
        expect(body.image_url).toMatch(/^data:image\/png;base64,iVBOR/);
    });

    it("maps task states and results", async () => {
        const replies = [
            { status: "PENDING", progress: 0, preceding_tasks: 3 },
            { status: "IN_PROGRESS", progress: 55 },
            { status: "SUCCEEDED", progress: 100, model_urls: { glb: "https://cdn/m.glb?Expires=1" }, thumbnail_url: "https://cdn/t.png", created_at: 1_790_000_000_000 },
            { status: "SUCCEEDED", model_urls: {} },
            { status: "FAILED", task_error: { message: "Bad image" } },
            { status: "CANCELED" },
        ];
        let i = 0;
        const fetch = scriptedFetch([route("GET", /image-to-3d\/t1$/, () => json(replies[i++]))]);
        const ctx = context(fetch, {}, secrets);
        expect(await meshy.poll(ctx, "t1")).toMatchObject({ state: "queued", message: "3 tasks ahead in Meshy's queue" });
        expect(await meshy.poll(ctx, "t1")).toMatchObject({ state: "running", progress: 55 });
        const done = await meshy.poll(ctx, "t1");
        expect(done.state).toBe("succeeded");
        expect(done.result).toMatchObject({ modelUrl: "https://cdn/m.glb?Expires=1", format: "glb", thumbnailUrl: "https://cdn/t.png" });
        expect(await meshy.poll(ctx, "t1")).toMatchObject({ state: "failed" });
        expect(await meshy.poll(ctx, "t1")).toEqual({ state: "failed", error: "Bad image" });
        expect(await meshy.poll(ctx, "t1")).toEqual({ state: "cancelled" });
    });

    it("lists all task kinds, newest first, and marks expired assets", async () => {
        const now = 1_790_000_000_000;
        const fetch = scriptedFetch([
            route("GET", /\/openapi\/v1\/image-to-3d\?page_num=1&page_size=2&sort_by=-created_at$/, () =>
                json([
                    { id: "a", status: "SUCCEEDED", created_at: now - 1000, expires_at: now + 1000, model_urls: { glb: "u" }, thumbnail_url: "t" },
                    { id: "b", status: "SUCCEEDED", created_at: now - 5000, expires_at: now - 1, model_urls: { glb: "u" } },
                ]),
            ),
            route("GET", /multi-image-to-3d\?/, () => json([])),
            route("GET", /\/openapi\/v2\/text-to-3d\?/, () => json([{ id: "c", status: "IN_PROGRESS", progress: 10, created_at: now - 100, prompt: "a red chair", type: "text-to-3d-preview" }])),
        ]);
        const page = await meshy.list!(context(fetch, {}, secrets, () => now), 1, 2);
        expect(page.items.map((i) => i.remoteId)).toEqual(["c", "a", "b"]);
        expect(page.items[0]).toMatchObject({ name: "a red chair", status: "running", hasModel: false });
        expect(page.items[1]).toMatchObject({ status: "succeeded", hasModel: true, thumbnailUrl: "t" });
        expect(page.items[2]).toMatchObject({ status: "expired", hasModel: false });
        expect(page.hasMore).toBe(true);
    });

    it("reports a helpful error when cancel is refused", async () => {
        const fetch = scriptedFetch([route("DELETE", /image-to-3d\/t1$/, () => json({ message: "in progress" }, 409))]);
        await expect(meshy.cancel!(context(fetch, {}, secrets), "t1")).rejects.toThrow(/already started/);
    });

    it("tests the key with the balance endpoint", async () => {
        const ok = await meshy.test(context(scriptedFetch([route("GET", `${base}/openapi/v1/balance`, () => json({ balance: 1200 }))]), {}, secrets));
        expect(ok).toEqual({ ok: true, message: "Connected to Meshy.", balance: "1200 credits" });
        const bad = await meshy.test(context(scriptedFetch([route("GET", `${base}/openapi/v1/balance`, () => json({ message: "Invalid API key" }, 401))]), {}, secrets));
        expect(bad).toEqual({ ok: false, message: "Meshy error 401: Invalid API key" });
        expect((await meshy.isConfigured(context(scriptedFetch([]), {}, {}))).configured).toBe(false);
    });
});

describe("Tripo (API v3)", () => {
    const base = "https://openapi.tripo3d.ai/v3";
    const secrets = { "tripo.apiKey": "tsk_abcdefghijklmnop" };

    it("omits options the chosen model does not accept", () => {
        const s = DEFAULT_SETTINGS.tripo;
        expect(buildImageToModelBody(s, "file_1")).toMatchObject({ input: "file_1", model: "v3.1-20260211", texture: true, pbr: true, geometry_quality: "standard", texture_quality: "standard" });
        const p1 = buildImageToModelBody({ ...s, model: "P1-20260311", smartLowPoly: true }, "f");
        expect(p1).not.toHaveProperty("geometry_quality");
        expect(p1).not.toHaveProperty("smart_low_poly");
        const v25 = buildImageToModelBody({ ...s, model: "v2.5-20250123", texture: false, pbr: false, faceLimit: 20000 }, "f");
        expect(v25).toMatchObject({ texture: false, pbr: false, face_limit: 20000 });
        expect(v25).not.toHaveProperty("texture_quality");
        expect(v25).not.toHaveProperty("geometry_quality");
    });

    it("uploads the image, then creates the task", async () => {
        const fetch = scriptedFetch([
            route("POST", `${base}/files`, () => json({ code: 0, data: { file_token: "file_abc" } })),
            route("POST", `${base}/generation/image-to-model`, () => json({ code: 0, data: { task_id: "tt1" } })),
        ]);
        const res = await tripo.submit(context(fetch, {}, secrets), input);
        expect(res.remoteId).toBe("tt1");
        const upload = parseMultipart(fetch.calls[0].body, fetch.calls[0].headers["content-type"]);
        expect(upload.files.file.filename).toBe("image.png");
        expect(Buffer.from(upload.files.file.bytes).equals(Buffer.from(PNG_1PX))).toBe(true);
        expect(JSON.parse(fetch.calls[1].body as string).input).toBe("file_abc");
        expect(fetch.calls[1].headers.authorization).toBe("Bearer tsk_abcdefghijklmnop");
    });

    it("surfaces Tripo error envelopes", async () => {
        const fetch = scriptedFetch([route("POST", `${base}/files`, () => json({ code: 2010, message: "Insufficient credits", suggestion: "Top up" }))]);
        await expect(tripo.submit(context(fetch, {}, secrets), input)).rejects.toThrow("Tripo upload failed: Insufficient credits (Top up)");
    });

    it("maps statuses, including banned/expired as failures", async () => {
        const replies = [
            { status: "queued", progress: 0 },
            { status: "running", progress: 40 },
            { status: "success", output: { model_url: "https://x/m.glb", rendered_image_url: "https://x/r.webp" } },
            { status: "banned", error_code: 2008, error_message: "Content policy" },
            { status: "expired" },
        ];
        let i = 0;
        const fetch = scriptedFetch([route("GET", `${base}/tasks/tt1`, () => json({ code: 0, data: replies[i++] }))]);
        const ctx = context(fetch, {}, secrets);
        expect((await tripo.poll(ctx, "tt1")).state).toBe("queued");
        expect(await tripo.poll(ctx, "tt1")).toMatchObject({ state: "running", progress: 40 });
        expect((await tripo.poll(ctx, "tt1")).result).toMatchObject({ modelUrl: "https://x/m.glb", thumbnailUrl: "https://x/r.webp" });
        expect(await tripo.poll(ctx, "tt1")).toEqual({ state: "failed", error: "Content policy (code 2008)" });
        expect((await tripo.poll(ctx, "tt1")).state).toBe("failed");
    });

    it("builds Browse from account usage + batch task query", async () => {
        const fetch = scriptedFetch([
            route("GET", `${base}/account/usage?limit=3&offset=0`, () =>
                json({ code: 0, data: { items: [{ task_id: "a", type: "image_to_model", created_at: "2026-10-01T10:00:00Z" }, { task_id: "b", type: "text_to_image" }, { task_id: "c", type: "multiview_to_model" }] } }),
            ),
            route("POST", `${base}/tasks/list`, (call) => {
                expect(JSON.parse(call.body as string).task_ids).toEqual(["a", "c"]);
                return json({ code: 0, data: { tasks: { a: { status: "success", output: { model_url: "m", rendered_image_url: "r" }, created_at: "2026-10-01T10:00:00Z" } }, missed: ["c"] } });
            }),
        ]);
        const page = await tripo.list!(context(fetch, {}, secrets), 1, 3);
        expect(page.items).toHaveLength(2);
        expect(page.items[0]).toMatchObject({ remoteId: "a", status: "succeeded", hasModel: true, thumbnailUrl: "r" });
        expect(page.items[1]).toMatchObject({ remoteId: "c", status: "unknown", hasModel: false });
        expect(page.hasMore).toBe(true);
        expect(page.notice).toMatch(/no model-list API/);
    });

    it("reports balance with reserved credits", async () => {
        const fetch = scriptedFetch([route("GET", `${base}/account/balance`, () => json({ code: 0, data: { balance: 120.5, frozen: 20 } }))]);
        expect((await tripo.test(context(fetch, {}, secrets))).balance).toBe("120.5 credits (20 reserved)");
    });
});

describe("Hitem3D", () => {
    const base = "https://api.hitem3d.ai/open-api/v1";
    const secrets = { "hitem3d.accessKey": "AK123", "hitem3d.secretKey": "SK456" };
    beforeEach(() => clearHitem3dTokenCache());

    it("builds submit fields: GLB output, PBR only where supported", () => {
        const s = DEFAULT_SETTINGS.hitem3d;
        expect(buildSubmitFields(s)).toEqual({ request_type: "3", model: "hi3dv3.0", resolution: "2048quality", format: "2", rmbg: "1", pbr: "1" });
        expect(buildSubmitFields({ ...s, model: "hitem3dv1.5", resolution: "1024", face: 500000, removeBackground: false })).toEqual({ request_type: "3", model: "hitem3dv1.5", resolution: "1024", format: "2", rmbg: "0", face: "500000" });
        expect(buildSubmitFields({ ...s, requestType: "1" })).not.toHaveProperty("pbr");
    });

    it("signs in with Basic AK:SK, caches the token and re-signs on expiry", async () => {
        let tokenCalls = 0;
        let queryCalls = 0;
        const fetch = scriptedFetch([
            route("POST", `${base}/auth/token`, (call) => {
                tokenCalls++;
                expect(call.headers.authorization).toBe(`Basic ${Buffer.from("AK123:SK456").toString("base64")}`);
                return json({ code: 200, data: { accessToken: `tok${tokenCalls}`, tokenType: "Bearer" } });
            }),
            route("GET", /query-task\?task_id=h1$/, (call) => {
                queryCalls++;
                if (call.headers.authorization === "Bearer tok1" && queryCalls === 2) return json({ code: 401, msg: "login expired" });
                return json({ code: 200, data: { task_id: "h1", state: "processing" } });
            }),
        ]);
        const ctx = context(fetch, { hitem3d: { appId: "777" } }, secrets);
        expect((await hitem3d.poll(ctx, "h1")).state).toBe("running");
        expect(fetch.calls[1].headers.appid).toBe("777");
        // second poll gets "login expired" → re-auth → retry with tok2
        expect((await hitem3d.poll(ctx, "h1")).state).toBe("running");
        expect(tokenCalls).toBe(2);
        expect(fetch.calls.at(-1)!.headers.authorization).toBe("Bearer tok2");
    });

    it("accepts AK:SK in one field and a raw token", async () => {
        const fetch = scriptedFetch([
            route("POST", `${base}/auth/token`, () => json({ code: 200, data: { accessToken: "t" } })),
            route("GET", `${base}/balance`, (call) => json({ code: 200, data: { totalBalance: call.headers.authorization === "Bearer t" ? 14 : 0 } })),
        ]);
        expect((await hitem3d.test(context(fetch, {}, { "hitem3d.accessKey": "AK:SK" }))).balance).toBe("14 balance");
        clearHitem3dTokenCache();
        const raw = scriptedFetch([route("GET", `${base}/balance`, (call) => json({ code: 200, data: { totalBalance: call.headers.authorization === "Bearer rawtoken" ? 5 : 0 } }))]);
        expect((await hitem3d.test(context(raw, {}, { "hitem3d.accessKey": "rawtoken" }))).balance).toBe("5 balance");
    });

    it("submits multipart with the image and fields", async () => {
        const fetch = scriptedFetch([
            route("POST", `${base}/auth/token`, () => json({ code: 200, data: { accessToken: "t" } })),
            route("POST", `${base}/submit-task`, () => json({ code: 200, data: { task_id: "h9" }, msg: "success" })),
        ]);
        const res = await hitem3d.submit(context(fetch, {}, secrets), input);
        expect(res.remoteId).toBe("h9");
        const form = parseMultipart(fetch.calls[1].body, fetch.calls[1].headers["content-type"]);
        expect(form.files.images.filename).toBe("image.png");
        expect(form.fields).toMatchObject({ format: "2", model: "hi3dv3.0" });
    });

    it("maps documented and legacy query results", async () => {
        const replies = [
            { code: 200, data: { state: "queueing" } },
            { code: 200, data: { state: "success", url: "https://cdn/m.glb", cover_url: "https://cdn/c.png" } },
            { code: 200, data: { task_status: 4, task_result: { model_url: "https://cdn/legacy.glb", render_url: "r" } } },
            { code: 200, data: { state: "failed", task_msg: "nope" } },
            { code: 50010001, msg: "generate failed" },
        ];
        let i = 0;
        const fetch = scriptedFetch([route("POST", `${base}/auth/token`, () => json({ code: 200, data: { accessToken: "t" } })), route("GET", /query-task/, () => json(replies[i++]))]);
        const ctx = context(fetch, {}, secrets);
        expect(await hitem3d.poll(ctx, "h")).toMatchObject({ state: "queued", progress: 15 });
        expect((await hitem3d.poll(ctx, "h")).result).toMatchObject({ modelUrl: "https://cdn/m.glb", thumbnailUrl: "https://cdn/c.png" });
        expect((await hitem3d.poll(ctx, "h")).result?.modelUrl).toBe("https://cdn/legacy.glb");
        expect(await hitem3d.poll(ctx, "h")).toEqual({ state: "failed", error: "nope" });
        await expect(hitem3d.poll(ctx, "h")).rejects.toThrow(/credits refunded/);
    });

    it("recognises expired-token answers", () => {
        expect(isExpiredTokenResponse({ code: 401, msg: "login expired" })).toBe(true);
        expect(isExpiredTokenResponse({ code: 200, msg: "ok" })).toBe(false);
        expect(isExpiredTokenResponse({ code: 500, message: "invalid token" })).toBe(true);
    });
});

describe("ComfyUI", () => {
    const base = "http://127.0.0.1:8188";

    it("uploads, queues TRELLIS.2 with the alpha mask, and finds the GLB", async () => {
        let queued: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {};
        const fetch = scriptedFetch([
            route("POST", `${base}/upload/image`, () => json({ name: "ps3d-x.png", subfolder: "photoshop3d", type: "input" })),
            route("POST", `${base}/prompt`, (call) => {
                queued = JSON.parse(call.body as string).prompt;
                return json({ prompt_id: "p1", number: 1, node_errors: {} });
            }),
        ]);
        const ctx = context(fetch, { comfyui: { seed: 7 } });
        const res = await comfyui.submit(ctx, input);
        expect(res.remoteId).toBe("p1");
        expect(queued["122"].inputs.image).toBe("photoshop3d/ps3d-x.png");
        expect(queued["195"].class_type).toBe("InvertMask");
        expect(queued["192"]).toBeUndefined();
        expect(queued["3"].inputs.seed).toBe(7);
        expect(queued["900"].class_type).toBe("SaveGLB");
    });

    it("reports ComfyUI validation errors readably", async () => {
        const fetch = scriptedFetch([
            route("POST", `${base}/upload/image`, () => json({ name: "a.png" })),
            route("POST", `${base}/prompt`, () => json({ error: { message: "Prompt outputs failed validation" }, node_errors: { "40": { class_type: "UNETLoader", errors: [{ message: "Value not in list", details: "unet_name: 'trellis' not in []" }] } } }, 400)),
        ]);
        await expect(comfyui.submit(context(fetch), input)).rejects.toThrow(/UNETLoader: Value not in list/);
    });

    it("polls queue position, running time, and the finished output", async () => {
        let t = 1_000_000;
        let historyReply: unknown = {};
        let queueReply: unknown = { queue_running: [], queue_pending: [[1, "other"], [2, "p1"]] };
        const fetch = scriptedFetch([route("GET", `${base}/history/p1`, () => json(historyReply)), route("GET", `${base}/queue`, () => json(queueReply))]);
        const ctx = context(fetch, {}, {}, () => t);
        expect(await comfyui.poll(ctx, "p1", { submittedAt: t })).toMatchObject({ state: "queued", message: "1 jobs ahead in ComfyUI's queue" });
        queueReply = { queue_running: [[2, "p1"]], queue_pending: [] };
        const running = await comfyui.poll(ctx, "p1", { submittedAt: t });
        expect(running.state).toBe("running");
        t += 140_000;
        const later = await comfyui.poll(ctx, "p1", running.meta);
        expect(later.progress).toBe(50);
        historyReply = { p1: { status: { status_str: "success", completed: true, messages: [["execution_start", { timestamp: 5 }]] }, outputs: { "900": { "3d": [{ filename: "trellis2_00001_.glb", subfolder: "photoshop3d", type: "output" }] } } } };
        const done = await comfyui.poll(ctx, "p1", later.meta);
        expect(done.state).toBe("succeeded");
        expect(done.result?.modelUrl).toBe(`${base}/view?filename=trellis2_00001_.glb&subfolder=photoshop3d&type=output`);
    });

    it("lists past 3D outputs from history", async () => {
        const fetch = scriptedFetch([
            route("GET", `${base}/history?max_items=500`, () =>
                json({
                    a: { status: { status_str: "success", messages: [["execution_start", { timestamp: 10 }]] }, outputs: { "9": { images: [{ filename: "x.png" }] } } },
                    b: { status: { status_str: "success", messages: [["execution_start", { timestamp: 20 }]] }, outputs: { "900": { "3d": [{ filename: "m_00002_.glb", subfolder: "3d", type: "output" }] } } },
                    c: { status: { status_str: "success", messages: [["execution_start", { timestamp: 30 }]] }, outputs: { "5": { result: ["3d/old_00001_.glb [output]"] } } },
                }),
            ),
        ]);
        const page = await comfyui.list!(context(fetch), 1, 10);
        expect(page.items.map((i) => i.remoteId)).toEqual(["c", "b"]);
        expect(page.items[1].name).toBe("m_00002");
    });
});
