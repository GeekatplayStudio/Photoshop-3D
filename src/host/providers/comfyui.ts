/**
 * ComfyUI (local or LAN server) — runs an image → 3D workflow.
 *
 * - Upload: POST /upload/image (multipart image, subfolder=photoshop3d, overwrite=true)
 * - Run:    POST /prompt { prompt, client_id } → prompt_id (validation errors come back as node_errors)
 * - Poll:   GET  /history/{id}; while absent, GET /queue tells queued vs running.
 *           ComfyUI reports no percentage over HTTP, so progress is estimated from elapsed time.
 * - Result: the first .glb/.gltf in the history outputs (SaveGLB reports outputs[node]["3d"]),
 *           downloaded through GET /view?filename=&subfolder=&type=output
 * - Browse: GET  /api/jobs?status=completed&sort_order=desc&limit&offset (jobs API, ComfyUI ≥ 0.6):
 *           a summary per job with its preview output; jobs whose preview is not the 3D file are
 *           read in full with GET /api/jobs/{id}. Older servers: GET /history?max_items=….
 *           ComfyUI keeps history in memory only, since the server last started.
 * - Cancel: POST /api/jobs/{id}/cancel (ComfyUI ≥ 0.26; only interrupts if that job is the one
 *           running). Older servers: POST /queue { delete } or POST /interrupt, which ComfyUI 0.38
 *           marks deprecated.
 * - Check:  GET  /object_info/<node> for the TRELLIS.2 nodes and the model files they can load.
 */
import type { RemoteItem, RemotePage } from "@shared/types";
import { HttpError, bodyOf, multipartBody, requestJson } from "../platform/http";
import {
    TRELLIS2_MODEL_ALTERNATIVES,
    TRELLIS2_MODEL_FILES,
    TRELLIS2_REQUIRED_NODES,
    buildTrellis2Workflow,
    historyError,
    isApiWorkflow,
    modelFilesFromOutputs,
    pickModelFile,
    prepareCustomWorkflow,
    promptError,
    type ComfyFile,
    type Trellis2Files,
} from "./comfyWorkflows";
import { obj, str, type ModelResult, type PollResult, type ProviderAdapter, type ProviderContext } from "./types";

/** A route this ComfyUI does not have yet (older version): fall back to the older route. */
const isMissingRoute = (err: unknown) => err instanceof HttpError && (err.status === 404 || err.status === 405);
const fileTitle = (f: ComfyFile) => f.filename.replace(/\.(glb|gltf)$/i, "").replace(/_+$/, "");
const BROWSE_NOTICE = "ComfyUI remembers jobs only since it was last started. Older models are in ComfyUI's output folder — use Library → Import file.";

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
                const { problems, warnings } = await checkTrellis2Details(ctx);
                if (problems.length) return { ok: false, message: `Connected (${parts.join(", ")}), but TRELLIS.2 is not ready: ${problems.join("; ")}.` };
                if (warnings.length) return { ok: true, message: `Connected: ${parts.join(", ")}. Note: ${warnings.join("; ")}.` };
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
            const useAlphaMask = input.hasAlpha && !c.removeBackground;
            // If the loaders cannot be inspected, queue with the template's file names; ComfyUI's own
            // validation then names anything missing.
            const { files, missing } = await resolveTrellis2Files(ctx).catch((err: Error) => {
                ctx.log.warn("ComfyUI: could not read the installed model files; using the template's names", err.message);
                return { files: undefined, missing: [] as string[] };
            });
            if (!useAlphaMask && missing.includes(TRELLIS2_MODEL_FILES.backgroundRemoval)) {
                throw new Error(`This image has no transparency, so ComfyUI must remove its background, but the background-removal model (${TRELLIS2_MODEL_FILES.backgroundRemoval}) is not installed. Cut the object out on a transparent layer, or install the model (Settings → ComfyUI → Test connection lists what is missing).`);
            }
            workflow = buildTrellis2Workflow({ image, useAlphaMask, textureSize: c.textureSize, faceCount: c.faceCount, seed, files });
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
        return (await listFromJobs(ctx, page, pageSize)) ?? listFromHistory(ctx, page, pageSize);
    },

    async resolve(ctx, remoteId) {
        const entry = await getHistory(ctx, remoteId);
        if (!entry) throw new Error("ComfyUI no longer has this job in its history.");
        const result = resultFromEntry(ctx, remoteId, entry);
        if (!result) throw new Error("This ComfyUI job has no .glb output.");
        return result;
    },

    async cancel(ctx, remoteId) {
        try {
            // Cancels a queued job or interrupts it if it is the one running; harmless if it already finished.
            await requestJson(ctx.fetch, `${base(ctx)}/api/jobs/${encodeURIComponent(remoteId)}/cancel`, { method: "POST", label: "ComfyUI", timeoutMs: 20_000 }, ctx.log);
            return;
        } catch (err) {
            if (!isMissingRoute(err)) throw err;
        }
        // ComfyUI before 0.26 has no jobs cancel route.
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

/** Browse through the jobs API (ComfyUI ≥ 0.6); null when this server does not have it. */
async function listFromJobs(ctx: ProviderContext, page: number, pageSize: number): Promise<RemotePage | null> {
    const offset = (Math.max(1, page) - 1) * pageSize;
    let body: Record<string, unknown>;
    try {
        body = obj(await requestJson(ctx.fetch, `${base(ctx)}/api/jobs?${query({ status: "completed", sort_order: "desc", limit: String(pageSize), offset: String(offset) })}`, { label: "ComfyUI", timeoutMs: 30_000 }, ctx.log));
    } catch (err) {
        if (isMissingRoute(err)) return null;
        throw err;
    }
    if (!Array.isArray(body.jobs)) return null;
    const items: RemoteItem[] = [];
    for (const raw of body.jobs) {
        const job = obj(raw);
        const id = str(job.id);
        if (!id) continue;
        const preview = obj(job.preview_output);
        let file: ComfyFile | undefined =
            preview.mediaType === "3d" && /\.(glb|gltf)$/i.test(str(preview.filename) ?? "") ? { filename: String(preview.filename), subfolder: str(preview.subfolder) ?? "", type: str(preview.type) ?? "output" } : undefined;
        if (!file && Number(job.outputs_count) > 1) {
            // The summary shows one output; a job that also saved images can still have a GLB.
            const full = obj(await requestJson(ctx.fetch, `${base(ctx)}/api/jobs/${encodeURIComponent(id)}`, { label: "ComfyUI", timeoutMs: 20_000 }, ctx.log));
            const files = modelFilesFromOutputs(full.outputs);
            file = files.find((f) => f.type === "output") ?? files[0];
        }
        if (!file) continue;
        const started = Number(job.execution_start_time ?? job.create_time);
        items.push({ providerId: "comfyui", remoteId: id, name: fileTitle(file), status: "succeeded", createdAt: Number.isFinite(started) ? started : undefined, hasModel: true, kind: file.subfolder || "output" });
    }
    return { items, page, hasMore: obj(body.pagination).has_more === true, notice: BROWSE_NOTICE };
}

/** Browse through /history (ComfyUI before the jobs API). */
async function listFromHistory(ctx: ProviderContext, page: number, pageSize: number): Promise<RemotePage> {
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
            name: fileTitle(files[0]),
            status: error ? "failed" : "succeeded",
            createdAt: startTimestamp(entry),
            hasModel: !error,
            kind: files.length > 1 ? `${files.length} files` : files[0].subfolder || "output",
        });
    }
    all.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    const start = (Math.max(1, page) - 1) * pageSize;
    return { items: all.slice(start, start + pageSize), page, hasMore: start + pageSize < all.length, notice: BROWSE_NOTICE };
}

const TRELLIS2_LOADERS = { unet: ["UNETLoader", "unet_name"], shapeVae: ["VAELoader", "vae_name"], textureVae: ["VAELoader", "vae_name"], clipVision: ["CLIPVisionLoader", "clip_name"], backgroundRemoval: ["LoadBackgroundRemovalModel", "bg_removal_name"] } as const;

/** Node definitions from /object_info (a missing node answers {}). */
async function nodeDefs(ctx: ProviderContext, names: readonly string[]): Promise<Record<string, unknown>> {
    const defs: Record<string, unknown> = {};
    await Promise.all(
        [...new Set(names)].map(async (name) => {
            try {
                Object.assign(defs, obj(await requestJson(ctx.fetch, `${base(ctx)}/object_info/${name}`, { label: "ComfyUI", timeoutMs: 15_000 }, ctx.log)));
            } catch (err) {
                if (!(err instanceof HttpError)) throw err;
            }
        }),
    );
    return defs;
}

/** Choices of a COMBO input: ["COMBO", { options }] (current) or [[…]] (older servers). */
function comboOptions(defs: Record<string, unknown>, node: string, input: string): string[] {
    const spec = obj(obj(obj(defs[node]).input).required)[input];
    if (!Array.isArray(spec)) return [];
    if (Array.isArray(spec[0])) return spec[0] as string[];
    const o = obj(spec[1]).options;
    return Array.isArray(o) ? (o as string[]) : [];
}

/**
 * The model files this ComfyUI has for each TRELLIS.2 slot (the template's file, also in a
 * subfolder, or an accepted alternative), and the expected names of those it lacks. When a
 * loader cannot be inspected, the template's name is assumed.
 */
async function resolveTrellis2Files(ctx: ProviderContext, defs?: Record<string, unknown>): Promise<{ files: Trellis2Files; missing: string[] }> {
    const d = defs ?? (await nodeDefs(ctx, Object.values(TRELLIS2_LOADERS).map(([node]) => node)));
    const files = { ...TRELLIS2_MODEL_FILES } as Trellis2Files;
    const missing: string[] = [];
    for (const slot of Object.keys(TRELLIS2_LOADERS) as (keyof Trellis2Files)[]) {
        const [node, input] = TRELLIS2_LOADERS[slot];
        const options = comboOptions(d, node, input);
        if (!options.length) {
            if (slot === "backgroundRemoval" && d[node] !== undefined) missing.push(TRELLIS2_MODEL_FILES[slot]);
            continue;
        }
        const picked = pickModelFile(options, TRELLIS2_MODEL_FILES[slot], TRELLIS2_MODEL_ALTERNATIVES[slot]);
        if (picked) {
            files[slot] = picked;
            if (picked !== TRELLIS2_MODEL_FILES[slot]) ctx.log.info(`ComfyUI TRELLIS.2: using ${picked} for ${slot}`);
        } else missing.push(TRELLIS2_MODEL_FILES[slot]);
    }
    return { files, missing };
}

/**
 * What stops the built-in TRELLIS.2 workflow on this server: missing nodes or model files
 * (`problems`, empty = ready), and the background-removal model, which only opaque images need
 * (`warnings`).
 */
export async function checkTrellis2(ctx: ProviderContext): Promise<string[]> {
    return (await checkTrellis2Details(ctx)).problems;
}

export async function checkTrellis2Details(ctx: ProviderContext): Promise<{ problems: string[]; warnings: string[] }> {
    const problems: string[] = [];
    const warnings: string[] = [];
    const defs = await nodeDefs(ctx, [...TRELLIS2_REQUIRED_NODES, ...Object.values(TRELLIS2_LOADERS).map(([node]) => node)]);
    const missingNodes = TRELLIS2_REQUIRED_NODES.filter((n) => !defs[n]);
    if (missingNodes.length) problems.push(`update ComfyUI (missing nodes: ${missingNodes.join(", ")})`);
    const { missing } = await resolveTrellis2Files(ctx, defs);
    const bg = TRELLIS2_MODEL_FILES.backgroundRemoval;
    const required = missing.filter((f) => f !== bg);
    if (required.length) problems.push(`download model files: ${required.join(", ")}`);
    if (missing.includes(bg) || !defs.LoadBackgroundRemovalModel) warnings.push(`the background-removal model (${bg}) is missing, so only layers with transparency will work`);
    return { problems, warnings };
}
