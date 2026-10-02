/**
 * Meshy (https://docs.meshy.ai) — Image to 3D.
 *
 * - Create: POST /openapi/v1/image-to-3d with the layer as a PNG data URI (Meshy
 *   accepts data URIs, so there is no upload step). Response: { result: taskId }.
 *   alpha_thumbnail=true asks for a transparent preview (alpha_thumbnail_url). The
 *   Smart Topology model (meshy-t2) is sent with model_type "smart-topology".
 * - Poll:   GET  /openapi/v1/image-to-3d/{id} → status PENDING|IN_PROGRESS|SUCCEEDED|FAILED|CANCELED,
 *           progress 0-100, model_urls.glb, alpha_thumbnail_url / thumbnail_url, task_error.message.
 * - Rate limits answer 429 with Retry-After (honoured by the job queue); retired endpoints
 *   carry a Deprecation header, which is logged (see platform/http.ts).
 * - Browse: GET  /openapi/v1/image-to-3d, /openapi/v1/multi-image-to-3d and
 *           /openapi/v2/text-to-3d with page_num/page_size/sort_by=-created_at
 *           (each returns a bare array of tasks). Only tasks created through the API
 *           with this key are listed; Meshy keeps assets 3 days (expires_at).
 * - Cancel: DELETE the task (Meshy refunds PENDING tasks; running ones return 409).
 * - Test:   GET  /openapi/v1/balance → { balance }.
 */
import { bytesToBase64 } from "@shared/bytes";
import { MESHY_SMART_TOPOLOGY_MODEL } from "@shared/settings";
import type { RemoteItem, RemoteStatus } from "@shared/types";
import { HttpError, requestJson } from "../platform/http";
import { formatFromUrl, obj, str, toEpochMs, toPercent, type ModelResult, type PollResult, type ProviderAdapter, type ProviderContext } from "./types";

export type MeshyKind = "image-to-3d" | "multi-image-to-3d" | "text-to-3d";

const KIND_PATH: Record<MeshyKind, string> = {
    "image-to-3d": "/openapi/v1/image-to-3d",
    "multi-image-to-3d": "/openapi/v1/multi-image-to-3d",
    "text-to-3d": "/openapi/v2/text-to-3d",
};

/** Accepts "msy_…", "Bearer msy_…" or a quoted key pasted from docs. */
export const cleanKey = (key: string) =>
    key
        .replace(/["']/g, "")
        .trim()
        .replace(/^bearer\s+/i, "")
        .trim();

async function headers(ctx: ProviderContext): Promise<Record<string, string>> {
    const key = cleanKey(await ctx.secret("meshy.apiKey"));
    if (!key) throw new Error("Meshy: add your API key in Settings → Meshy.");
    return { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

const base = (ctx: ProviderContext) => ctx.settings.meshy.baseUrl;
const kindOf = (meta?: Record<string, unknown>): MeshyKind => {
    const k = meta?.kind;
    return k === "multi-image-to-3d" || k === "text-to-3d" ? k : "image-to-3d";
};

/** Request body for image-to-3d from the user's settings (only documented fields, per model). */
export function buildImageTo3dBody(settings: ProviderContext["settings"]["meshy"], dataUri: string): Record<string, unknown> {
    const model = settings.aiModel;
    if (model === MESHY_SMART_TOPOLOGY_MODEL) {
        // Smart Topology: clean low-poly topology; target_polycount 100–15,000 (Meshy default 4,000).
        const body: Record<string, unknown> = {
            image_url: dataUri,
            model_type: "smart-topology",
            ai_model: model,
            should_texture: settings.shouldTexture,
            enable_pbr: settings.shouldTexture && settings.enablePbr,
            target_formats: ["glb"],
            alpha_thumbnail: true,
        };
        if (settings.targetPolycount > 0) body.target_polycount = Math.min(15_000, Math.max(100, settings.targetPolycount));
        return body;
    }
    const body: Record<string, unknown> = {
        image_url: dataUri,
        ai_model: model,
        should_texture: settings.shouldTexture,
        enable_pbr: settings.shouldTexture && settings.enablePbr,
        should_remesh: settings.shouldRemesh,
        target_formats: ["glb"],
        alpha_thumbnail: true,
    };
    if (settings.shouldRemesh) {
        body.topology = settings.topology;
        if (settings.targetPolycount > 0) body.target_polycount = Math.max(100, settings.targetPolycount);
    }
    if (settings.shouldTexture && settings.textureResolution !== "2k" && model !== "meshy-6-lite") body.texture_resolution = settings.textureResolution;
    if (settings.geometryResolution !== "standard" && (model === "latest" || model === "meshy-7.1")) body.geometry_resolution = settings.geometryResolution;
    if (model === "meshy-6") body.remove_lighting = settings.removeLighting;
    if (model === "meshy-6" || model === "meshy-7.1" || model === "latest") body.image_enhancement = settings.imageEnhancement;
    return body;
}

function mapStatus(status: unknown): RemoteStatus {
    switch (String(status ?? "").toUpperCase()) {
        case "PENDING":
            return "queued";
        case "IN_PROGRESS":
            return "running";
        case "SUCCEEDED":
            return "succeeded";
        case "FAILED":
            return "failed";
        case "CANCELED":
        case "CANCELLED":
            return "cancelled";
        case "EXPIRED":
            return "expired";
        default:
            return "unknown";
    }
}

function resultFrom(task: Record<string, unknown>, kind: MeshyKind): ModelResult | undefined {
    const urls = obj(task.model_urls);
    const glb = str(urls.glb);
    if (!glb) return undefined;
    return {
        modelUrl: glb,
        format: formatFromUrl(glb),
        thumbnailUrl: thumbnailOf(task),
        name: taskName(task, kind),
        createdAt: toEpochMs(task.created_at),
        meta: { kind, aiModel: task.ai_model, expiresAt: toEpochMs(task.expires_at), credits: task.consumed_credits },
    };
}

/** The transparent preview when Meshy made one (alpha_thumbnail), else the regular one. */
const thumbnailOf = (task: Record<string, unknown>) => str(task.alpha_thumbnail_url) ?? str(task.thumbnail_url);

function taskName(task: Record<string, unknown>, kind: MeshyKind): string {
    const prompt = str(task.prompt) ?? str(task.texture_prompt);
    if (prompt) return prompt.slice(0, 60);
    const created = toEpochMs(task.created_at);
    const label = kind === "text-to-3d" ? "Text to 3D" : kind === "multi-image-to-3d" ? "Multi-image to 3D" : "Image to 3D";
    return created ? `${label} ${new Date(created).toISOString().slice(0, 16).replace("T", " ")}` : label;
}

export const meshy: ProviderAdapter = {
    id: "meshy",
    label: "Meshy",
    capabilities: { generate: true, browse: true, cancel: true },

    async isConfigured(ctx) {
        const key = cleanKey(await ctx.secret("meshy.apiKey"));
        return key ? { configured: true } : { configured: false, hint: "Add your Meshy API key in Settings." };
    },

    async test(ctx) {
        try {
            const body = await requestJson<{ balance?: number }>(ctx.fetch, `${base(ctx)}/openapi/v1/balance`, { headers: await headers(ctx), label: "Meshy", timeoutMs: 20_000 }, ctx.log);
            return { ok: true, message: "Connected to Meshy.", balance: body?.balance !== undefined ? `${body.balance} credits` : undefined };
        } catch (err) {
            return { ok: false, message: (err as Error).message };
        }
    },

    async submit(ctx, input) {
        const dataUri = `data:image/png;base64,${bytesToBase64(input.image)}`;
        const body = buildImageTo3dBody(ctx.settings.meshy, dataUri);
        const res = await requestJson<{ result?: string; id?: string }>(
            ctx.fetch,
            `${base(ctx)}${KIND_PATH["image-to-3d"]}`,
            { method: "POST", headers: await headers(ctx), body: JSON.stringify(body), label: "Meshy", timeoutMs: 120_000 },
            ctx.log,
        );
        const id = str(res?.result) ?? str(res?.id);
        if (!id) throw new Error("Meshy did not return a task id.");
        return { remoteId: id, meta: { kind: "image-to-3d", aiModel: ctx.settings.meshy.aiModel } };
    },

    async poll(ctx, remoteId, meta): Promise<PollResult> {
        const kind = kindOf(meta);
        const task = obj(await requestJson(ctx.fetch, `${base(ctx)}${KIND_PATH[kind]}/${encodeURIComponent(remoteId)}`, { headers: await headers(ctx), label: "Meshy", timeoutMs: 30_000 }, ctx.log));
        const state = mapStatus(task.status);
        const progress = toPercent(task.progress);
        const errorMessage = str(obj(task.task_error).message);
        switch (state) {
            case "succeeded": {
                const result = resultFrom(task, kind);
                return result ? { state: "succeeded", progress: 100, result } : { state: "failed", error: "Meshy finished but returned no GLB file." };
            }
            case "failed":
            case "expired":
                return { state: "failed", error: errorMessage ?? `Meshy task ${state}.` };
            case "cancelled":
                return { state: "cancelled" };
            case "queued": {
                const ahead = typeof task.preceding_tasks === "number" ? task.preceding_tasks : undefined;
                return { state: "queued", progress, message: ahead ? `${ahead} tasks ahead in Meshy's queue` : "Waiting in Meshy's queue" };
            }
            default:
                return { state: "running", progress, message: "Meshy is generating" };
        }
    },

    async list(ctx, page, pageSize) {
        const h = await headers(ctx);
        const size = Math.max(1, Math.min(100, pageSize));
        const kinds: MeshyKind[] = ["image-to-3d", "multi-image-to-3d", "text-to-3d"];
        const now = ctx.now?.() ?? Date.now();
        const results = await Promise.all(
            kinds.map(async (kind) => {
                try {
                    const url = `${base(ctx)}${KIND_PATH[kind]}?page_num=${page}&page_size=${size}&sort_by=-created_at`;
                    const body = await requestJson<unknown>(ctx.fetch, url, { headers: h, label: "Meshy", timeoutMs: 30_000 }, ctx.log);
                    const tasks = Array.isArray(body) ? body : Array.isArray(obj(body).result) ? (obj(body).result as unknown[]) : [];
                    return { kind, tasks: tasks.map(obj), error: null as Error | null };
                } catch (err) {
                    // An auth error must reach the user; a missing endpoint for one kind must not hide the others.
                    if (err instanceof HttpError && (err.status === 401 || err.status === 403) && kind === "image-to-3d") throw err;
                    return { kind, tasks: [] as Record<string, unknown>[], error: err as Error };
                }
            }),
        );
        const items: RemoteItem[] = [];
        for (const { kind, tasks } of results) {
            for (const task of tasks) {
                const id = str(task.id);
                if (!id) continue;
                let status = mapStatus(task.status);
                const expiresAt = toEpochMs(task.expires_at);
                const glb = str(obj(task.model_urls).glb);
                if (status === "succeeded" && expiresAt && expiresAt < now) status = "expired";
                items.push({
                    providerId: "meshy",
                    remoteId: id,
                    name: taskName(task, kind),
                    status,
                    progress: toPercent(task.progress),
                    createdAt: toEpochMs(task.created_at),
                    thumbnailUrl: thumbnailOf(task),
                    hasModel: status === "succeeded" && !!glb,
                    kind: str(task.type) ?? kind,
                });
            }
        }
        items.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
        const hasMore = results.some((r) => r.tasks.length >= size);
        const failed = results.filter((r) => r.error).map((r) => r.kind);
        return {
            items,
            page,
            hasMore,
            notice: failed.length ? `Could not load Meshy ${failed.join(", ")} tasks.` : "Meshy lists tasks created with this API key. Assets are kept for 3 days.",
        };
    },

    async resolve(ctx, remoteId, meta) {
        const kinds: MeshyKind[] = meta?.kind ? [kindOf(meta)] : ["image-to-3d", "multi-image-to-3d", "text-to-3d"];
        let lastError: unknown;
        for (const kind of kinds) {
            try {
                const task = obj(await requestJson(ctx.fetch, `${base(ctx)}${KIND_PATH[kind]}/${encodeURIComponent(remoteId)}`, { headers: await headers(ctx), label: "Meshy", timeoutMs: 30_000 }, ctx.log));
                const result = resultFrom(task, kind);
                if (result) return result;
                throw new Error(`Meshy task ${remoteId} has no GLB (status ${String(task.status ?? "unknown")}).`);
            } catch (err) {
                lastError = err;
                if (!(err instanceof HttpError && err.status === 404)) break;
            }
        }
        throw lastError instanceof Error ? lastError : new Error(`Meshy task ${remoteId} not found.`);
    },

    async cancel(ctx, remoteId, meta) {
        const kind = kindOf(meta);
        try {
            await requestJson(ctx.fetch, `${base(ctx)}${KIND_PATH[kind]}/${encodeURIComponent(remoteId)}`, { method: "DELETE", headers: await headers(ctx), label: "Meshy", timeoutMs: 30_000 }, ctx.log);
        } catch (err) {
            if (err instanceof HttpError && err.status === 409) throw new Error("Meshy already started this task and cannot cancel it; it will finish on Meshy's side.");
            throw err;
        }
    },
};
