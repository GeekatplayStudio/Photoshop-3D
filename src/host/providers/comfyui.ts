/**
 * ComfyUI (local or LAN server) — runs an image → 3D workflow.
 *
 * - Upload: POST /upload/image (multipart image, subfolder=photoshop3d, overwrite=true)
 * - Run:    POST /prompt { prompt, client_id } → prompt_id (validation errors come back as node_errors)
 * - Poll:   GET  /history/{id}; while absent, GET /queue tells queued vs running.
 *           ComfyUI reports no percentage over HTTP, so progress is estimated from elapsed time.
 * - Result: the first .glb/.gltf in the history outputs (SaveGLB reports outputs[node]["3d"]),
 *           downloaded through GET /view?filename=&subfolder=&type=output
 * - Browse: GET  /history?max_items=… → every past prompt that produced a 3D file.
 *           ComfyUI keeps history in memory only, since the server last started.
 * - Cancel: POST /queue { delete } for queued prompts, POST /interrupt for the running one.
 */
import type { RemoteItem } from "@shared/types";
import { HttpError, bodyOf, multipartBody, requestJson } from "../platform/http";
import {
    TRELLIS2_MODEL_FILES,
    TRELLIS2_REQUIRED_NODES,
    buildTrellis2Workflow,
    historyError,
    isApiWorkflow,
    modelFilesFromOutputs,
    prepareCustomWorkflow,
    promptError,
    type ComfyFile,
} from "./comfyWorkflows";
import { obj, str, type ModelResult, type PollResult, type ProviderAdapter, type ProviderContext } from "./types";

const CLIENT_ID = `photoshop3d-${Math.random().toString(36).slice(2, 10)}`;
const base = (ctx: ProviderContext) => ctx.settings.comfyui.url;

const query = (params: Record<string, string>) =>
    Object.entries(params)
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join("&");

export const viewUrl = (baseUrl: string, f: ComfyFile) => `${baseUrl}/view?${query({ filename: f.filename, subfolder: f.subfolder, type: f.type || "output" })}`;

function newSeed(ctx: ProviderContext): number {
    const s = ctx.settings.comfyui.seed;
    return s >= 0 ? s : Math.floor(Math.random() * 2 ** 32);
}

async function getHistory(ctx: ProviderContext, promptId: string): Promise<Record<string, unknown> | null> {
    const body = obj(await requestJson(ctx.fetch, `${base(ctx)}/history/${encodeURIComponent(promptId)}`, { label: "ComfyUI", timeoutMs: 20_000 }, ctx.log));
    return body[promptId] ? obj(body[promptId]) : null;
}

function resultFromEntry(ctx: ProviderContext, promptId: string, entry: Record<string, unknown>): ModelResult | undefined {
    const files = modelFilesFromOutputs(entry.outputs);
    const file = files.find((f) => f.type === "output") ?? files[0];
    if (!file) return undefined;
    return {
        modelUrl: viewUrl(base(ctx), file),
        format: /\.gltf$/i.test(file.filename) ? "gltf" : "glb",
        name: file.filename.replace(/\.(glb|gltf)$/i, "").replace(/_+$/, ""),
        createdAt: startTimestamp(entry),
        meta: { promptId, file: `${file.subfolder ? `${file.subfolder}/` : ""}${file.filename}` },
    };
}

function startTimestamp(entry: Record<string, unknown>): number | undefined {
    const messages = obj(entry.status).messages;
    if (!Array.isArray(messages)) return undefined;
    for (const m of messages) {
        if (Array.isArray(m) && m[0] === "execution_start" && typeof obj(m[1]).timestamp === "number") return obj(m[1]).timestamp as number;
    }
    return undefined;
}

/** Expected run time used for the progress estimate. */
const expectedSeconds = (ctx: ProviderContext) => (ctx.settings.comfyui.workflow === "trellis2" ? 280 : 180);

export const comfyui: ProviderAdapter = {
    id: "comfyui",
    label: "ComfyUI",
    capabilities: { generate: true, browse: true, cancel: true },

    async isConfigured(ctx) {
        const c = ctx.settings.comfyui;
        if (c.workflow === "custom" && !isApiWorkflow(c.customWorkflow)) return { configured: false, hint: "Choose a ComfyUI workflow (API format) in Settings → ComfyUI." };
        return { configured: !!c.url };
    },

    async test(ctx) {
        try {
            const stats = obj(await requestJson(ctx.fetch, `${base(ctx)}/system_stats`, { label: "ComfyUI", timeoutMs: 8000 }, ctx.log));
            const system = obj(stats.system);
            const device = obj(Array.isArray(stats.devices) ? stats.devices[0] : undefined);
            const parts = [`ComfyUI ${str(system.comfyui_version) ?? ""}`.trim(), str(device.name)?.replace(/^cuda:\d+\s*/, "").split(" : ")[0]].filter(Boolean);
            if (ctx.settings.comfyui.workflow === "trellis2") {
                const problems = await checkTrellis2(ctx);
                if (problems.length) return { ok: false, message: `Connected (${parts.join(", ")}), but TRELLIS.2 is not ready: ${problems.join("; ")}.` };
            }
            return { ok: true, message: `Connected: ${parts.join(", ")}.` };
        } catch (err) {
            return { ok: false, message: `${(err as Error).message}. Is ComfyUI running at ${base(ctx)}?` };
        }
    },

    async submit(ctx, input) {
        const c = ctx.settings.comfyui;
        const form = multipartBody([
            { name: "image", value: input.image, filename: `ps3d-${Date.now().toString(36)}.png`, contentType: "image/png" },
            { name: "subfolder", value: "photoshop3d" },
            { name: "type", value: "input" },
            { name: "overwrite", value: "true" },
        ]);
        const uploaded = obj(
            await requestJson(ctx.fetch, `${base(ctx)}/upload/image`, { method: "POST", headers: { "Content-Type": form.contentType }, body: bodyOf(form.body), label: "ComfyUI upload", timeoutMs: 120_000 }, ctx.log),
        );
        const name = str(uploaded.name);
        if (!name) throw new Error("ComfyUI upload returned no file name.");
        const image = str(uploaded.subfolder) ? `${uploaded.subfolder}/${name}` : name;

        const seed = newSeed(ctx);
        let workflow: unknown;
        if (c.workflow === "custom") {
            if (!isApiWorkflow(c.customWorkflow)) throw new Error("No custom ComfyUI workflow is set. Choose one in Settings → ComfyUI (save it with Workflow → Export (API)).");
            workflow = prepareCustomWorkflow(c.customWorkflow, image, c.imageNodeId, seed);
        } else {
            workflow = buildTrellis2Workflow({ image, useAlphaMask: input.hasAlpha && !c.removeBackground, textureSize: c.textureSize, faceCount: c.faceCount, seed });
        }

        let res: Response;
        try {
            res = await ctx.fetch(`${base(ctx)}/prompt`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: workflow, client_id: CLIENT_ID }) });
        } catch (err) {
            throw new Error(`Cannot reach ComfyUI at ${base(ctx)} (${(err as Error).message}).`);
        }
        const text = await res.text();
        let body: unknown = text;
        try {
            body = JSON.parse(text);
        } catch {
            // plain-text error
        }
        if (!res.ok) throw new Error(promptError(body));
        const promptId = str(obj(body).prompt_id);
        if (!promptId) throw new Error("ComfyUI did not return a prompt id.");
        ctx.log.info(`ComfyUI queued ${c.workflow} workflow`, { promptId, seed });
        return { remoteId: promptId, meta: { workflow: c.workflow, submittedAt: ctx.now?.() ?? Date.now() } };
    },

    async poll(ctx, remoteId, meta): Promise<PollResult> {
        const entry = await getHistory(ctx, remoteId);
        const now = ctx.now?.() ?? Date.now();
        const submittedAt = typeof meta?.submittedAt === "number" ? meta.submittedAt : now;
        if (entry) {
            const error = historyError(entry);
            if (error) return { state: error.startsWith("Cancelled") ? "cancelled" : "failed", error };
            const status = obj(entry.status);
            if (status.completed === false && status.status_str !== "success") return { state: "running", message: "ComfyUI is finishing" };
            const result = resultFromEntry(ctx, remoteId, entry);
            return result ? { state: "succeeded", progress: 100, result } : { state: "failed", error: "The workflow finished but saved no .glb file. Add a Save GLB node to it." };
        }
        const queue = obj(await requestJson(ctx.fetch, `${base(ctx)}/queue`, { label: "ComfyUI", timeoutMs: 20_000 }, ctx.log));
        const ids = (list: unknown) => (Array.isArray(list) ? list.map((q) => (Array.isArray(q) ? String(q[1]) : "")) : []);
        const running = ids(queue.queue_running);
        const pending = ids(queue.queue_pending);
        const timeoutMs = ctx.settings.comfyui.timeoutMinutes * 60_000;
        if (now - submittedAt > timeoutMs) return { state: "failed", error: `ComfyUI did not finish within ${ctx.settings.comfyui.timeoutMinutes} minutes.` };
        if (running.includes(remoteId)) {
            const startedAt = typeof meta?.startedAt === "number" ? meta.startedAt : now;
            const elapsed = (now - startedAt) / 1000;
            const progress = Math.min(95, Math.round((elapsed / expectedSeconds(ctx)) * 100));
            const mm = Math.floor(elapsed / 60);
            const ss = String(Math.floor(elapsed % 60)).padStart(2, "0");
            return { state: "running", progress, message: `Running on ComfyUI (${mm}:${ss})`, meta: { ...(meta ?? {}), startedAt } };
        }
        const position = pending.indexOf(remoteId);
        if (position >= 0) return { state: "queued", progress: 0, message: position === 0 ? "Next in ComfyUI's queue" : `${position} jobs ahead in ComfyUI's queue` };
        // Not in history and not queued: ComfyUI restarted or the prompt was deleted.
        if (now - submittedAt > 60_000) return { state: "failed", error: "ComfyUI no longer knows this job (was the server restarted?)." };
        return { state: "queued", message: "Waiting for ComfyUI" };
    },

    async list(ctx, page, pageSize) {
        const body = obj(await requestJson(ctx.fetch, `${base(ctx)}/history?max_items=500`, { label: "ComfyUI", timeoutMs: 30_000 }, ctx.log));
        const all: RemoteItem[] = [];
        for (const [promptId, value] of Object.entries(body)) {
            const entry = obj(value);
            const files = modelFilesFromOutputs(entry.outputs);
            if (!files.length) continue;
            const error = historyError(entry);
            all.push({
                providerId: "comfyui",
                remoteId: promptId,
                name: files[0].filename.replace(/\.(glb|gltf)$/i, "").replace(/_+$/, ""),
                status: error ? "failed" : "succeeded",
                createdAt: startTimestamp(entry),
                hasModel: !error,
                kind: files.length > 1 ? `${files.length} files` : files[0].subfolder || "output",
            });
        }
        all.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
        const start = (Math.max(1, page) - 1) * pageSize;
        return {
            items: all.slice(start, start + pageSize),
            page,
            hasMore: start + pageSize < all.length,
            notice: "ComfyUI remembers jobs only since it was last started. Older models are in ComfyUI's output folder — use Library → Import file.",
        };
    },

    async resolve(ctx, remoteId) {
        const entry = await getHistory(ctx, remoteId);
        if (!entry) throw new Error("ComfyUI no longer has this job in its history.");
        const result = resultFromEntry(ctx, remoteId, entry);
        if (!result) throw new Error("This ComfyUI job has no .glb output.");
        return result;
    },

    async cancel(ctx, remoteId) {
        const queue = obj(await requestJson(ctx.fetch, `${base(ctx)}/queue`, { label: "ComfyUI", timeoutMs: 20_000 }, ctx.log));
        const running = Array.isArray(queue.queue_running) ? queue.queue_running.map((q) => (Array.isArray(q) ? String(q[1]) : "")) : [];
        const json = { "Content-Type": "application/json" };
        if (running.includes(remoteId)) {
            await requestJson(ctx.fetch, `${base(ctx)}/interrupt`, { method: "POST", headers: json, body: JSON.stringify({ prompt_id: remoteId }), label: "ComfyUI", timeoutMs: 20_000 }, ctx.log);
        } else {
            await requestJson(ctx.fetch, `${base(ctx)}/queue`, { method: "POST", headers: json, body: JSON.stringify({ delete: [remoteId] }), label: "ComfyUI", timeoutMs: 20_000 }, ctx.log);
        }
    },
};

/** Missing node types or model files for the built-in TRELLIS.2 workflow (empty = ready). */
export async function checkTrellis2(ctx: ProviderContext): Promise<string[]> {
    const problems: string[] = [];
    const defs: Record<string, unknown> = {};
    await Promise.all(
        [...TRELLIS2_REQUIRED_NODES, "UNETLoader", "VAELoader", "CLIPVisionLoader"].map(async (name) => {
            try {
                Object.assign(defs, obj(await requestJson(ctx.fetch, `${base(ctx)}/object_info/${name}`, { label: "ComfyUI", timeoutMs: 15_000 }, ctx.log)));
            } catch (err) {
                if (!(err instanceof HttpError)) throw err;
            }
        }),
    );
    const missingNodes = TRELLIS2_REQUIRED_NODES.filter((n) => !defs[n]);
    if (missingNodes.length) problems.push(`update ComfyUI (missing nodes: ${missingNodes.join(", ")})`);
    const options = (node: string, input: string): string[] => {
        const spec = obj(obj(obj(defs[node]).input).required)[input];
        if (!Array.isArray(spec)) return [];
        if (Array.isArray(spec[0])) return spec[0] as string[];
        const o = obj(spec[1]).options;
        return Array.isArray(o) ? (o as string[]) : [];
    };
    const f = TRELLIS2_MODEL_FILES;
    const missingFiles = [
        [f.unet, options("UNETLoader", "unet_name")],
        [f.shapeVae, options("VAELoader", "vae_name")],
        [f.textureVae, options("VAELoader", "vae_name")],
        [f.clipVision, options("CLIPVisionLoader", "clip_name")],
    ]
        .filter(([file, list]) => (list as string[]).length > 0 && !(list as string[]).includes(file as string))
        .map(([file]) => file as string);
    if (missingFiles.length) problems.push(`download model files: ${missingFiles.join(", ")}`);
    return problems;
}
