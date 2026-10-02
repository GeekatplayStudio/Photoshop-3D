/**
 * Tripo (https://developers.tripo3d.ai) — API V3.
 *
 * Tripo's V2 API (api.tripo3d.ai/v2/openapi) stops accepting requests on
 * 2026-11-01, so this adapter targets V3 (https://openapi.tripo3d.ai/v3):
 *
 * - Upload: POST /files (multipart "file") → data.file_token. V3 rejects data URIs.
 * - Create: POST /generation/image-to-model { input: file_token, model, texture, pbr, … } → data.task_id
 * - Poll:   GET  /tasks/{id} → data.status queued|running|success|failed|cancelled (banned/expired
 *           are reported as failed), data.progress, data.output.model_url / rendered_image_url.
 * - Browse: Tripo has no "list my models" endpoint. GET /account/usage (limit/offset) lists the
 *           account's tasks; POST /tasks/list { task_ids } fetches their details and fresh URLs.
 * - Test:   GET  /account/balance → data.balance / data.frozen (decimals).
 * There is no cancel endpoint.
 */
import type { RemoteItem, RemoteStatus } from "@shared/types";
import { bodyOf, multipartBody, requestJson } from "../platform/http";
import { formatFromUrl, obj, str, toEpochMs, toPercent, type ModelResult, type PollResult, type ProviderAdapter, type ProviderContext } from "./types";

import { cleanKey } from "./meshy";

async function auth(ctx: ProviderContext): Promise<Record<string, string>> {
    const key = cleanKey(await ctx.secret("tripo.apiKey"));
    if (!key) throw new Error("Tripo: add your API key in Settings → Tripo.");
    return { Authorization: `Bearer ${key}` };
}

const base = (ctx: ProviderContext) => ctx.settings.tripo.baseUrl;

/** Unwraps { code: 0, data } and turns a non-zero code into an error. */
function unwrap(body: unknown, what: string): Record<string, unknown> {
    const b = obj(body);
    if (typeof b.code === "number" && b.code !== 0) {
        const msg = str(b.message) ?? str(b.msg) ?? `code ${b.code}`;
        const hint = str(b.suggestion);
        throw new Error(`Tripo ${what} failed: ${msg}${hint ? ` (${hint})` : ""}`);
    }
    return obj(b.data ?? b);
}

/** Request body for image-to-model from the user's settings (only documented fields). */
export function buildImageToModelBody(settings: ProviderContext["settings"]["tripo"], fileToken: string): Record<string, unknown> {
    const model = settings.model;
    const isV3 = /^v3\./.test(model);
    const isP = /^P\d/i.test(model);
    const body: Record<string, unknown> = {
        input: fileToken,
        model,
        texture: settings.texture || settings.pbr,
        pbr: settings.pbr,
        auto_size: settings.autoSize,
        orientation: settings.orientation,
    };
    if (settings.texture || settings.pbr) body.texture_quality = settings.textureQuality;
    if (settings.faceLimit > 0) body.face_limit = settings.faceLimit;
    if (isV3 && !isP) {
        body.geometry_quality = settings.geometryQuality;
        if (settings.smartLowPoly) body.smart_low_poly = true;
    }
    return body;
}

function mapStatus(status: unknown): RemoteStatus {
    switch (String(status ?? "").toLowerCase()) {
        case "queued":
            return "queued";
        case "running":
            return "running";
        case "success":
            return "succeeded";
        case "cancelled":
        case "canceled":
            return "cancelled";
        case "expired":
            return "expired";
        case "failed":
        case "banned":
            return "failed";
        default:
            return "unknown";
    }
}

function resultFrom(task: Record<string, unknown>): ModelResult | undefined {
    const out = obj(task.output);
    const url = str(out.model_url) ?? str(out.pbr_model) ?? str(out.model) ?? str(out.base_model);
    if (!url) return undefined;
    return {
        modelUrl: url,
        format: formatFromUrl(url),
        thumbnailUrl: str(out.rendered_image_url) ?? str(out.rendered_image) ?? str(out.generated_image_url),
        name: taskName(task),
        createdAt: toEpochMs(task.created_at ?? task.create_time),
        meta: { type: task.type, credits: task.credits_consumed ?? task.consumed_credit },
    };
}

function taskName(task: Record<string, unknown>): string {
    const input = obj(task.input);
    const prompt = str(input.prompt) ?? str(task.prompt);
    if (prompt) return prompt.slice(0, 60);
    const created = toEpochMs(task.created_at ?? task.create_time);
    return created ? `Tripo model ${new Date(created).toISOString().slice(0, 16).replace("T", " ")}` : "Tripo model";
}

async function getTask(ctx: ProviderContext, id: string): Promise<Record<string, unknown>> {
    return unwrap(await requestJson(ctx.fetch, `${base(ctx)}/tasks/${encodeURIComponent(id)}`, { headers: await auth(ctx), label: "Tripo", timeoutMs: 30_000 }, ctx.log), "task query");
}

/** Usage rows can come back as an array or wrapped in items/list/records. */
function usageRows(data: unknown): Record<string, unknown>[] {
    if (Array.isArray(data)) return data.map(obj);
    const d = obj(data);
    for (const k of ["items", "list", "records", "usage", "tasks", "data"]) if (Array.isArray(d[k])) return (d[k] as unknown[]).map(obj);
    return [];
}

export const tripo: ProviderAdapter = {
    id: "tripo",
    label: "Tripo",
    capabilities: { generate: true, browse: true, cancel: false },

    async isConfigured(ctx) {
        const key = cleanKey(await ctx.secret("tripo.apiKey"));
        return key ? { configured: true } : { configured: false, hint: "Add your Tripo API key in Settings." };
    },

    async test(ctx) {
        try {
            const data = unwrap(await requestJson(ctx.fetch, `${base(ctx)}/account/balance`, { headers: await auth(ctx), label: "Tripo", timeoutMs: 20_000 }, ctx.log), "balance");
            const balance = typeof data.balance === "number" ? data.balance : Number(data.balance);
            const frozen = typeof data.frozen === "number" ? data.frozen : Number(data.frozen);
            return {
                ok: true,
                message: "Connected to Tripo (API v3).",
                balance: Number.isFinite(balance) ? `${balance} credits${Number.isFinite(frozen) && frozen > 0 ? ` (${frozen} reserved)` : ""}` : undefined,
            };
        } catch (err) {
            return { ok: false, message: (err as Error).message };
        }
    },

    async submit(ctx, input) {
        const h = await auth(ctx);
        const form = multipartBody([{ name: "file", value: input.image, filename: "image.png", contentType: "image/png" }]);
        const uploaded = unwrap(
            await requestJson(ctx.fetch, `${base(ctx)}/files`, { method: "POST", headers: { ...h, "Content-Type": form.contentType }, body: bodyOf(form.body), label: "Tripo upload", timeoutMs: 180_000 }, ctx.log),
            "upload",
        );
        const token = str(uploaded.file_token) ?? str(uploaded.image_token) ?? str(uploaded.token);
        if (!token) throw new Error("Tripo upload did not return a file token.");

        const body = buildImageToModelBody(ctx.settings.tripo, token);
        const created = unwrap(
            await requestJson(ctx.fetch, `${base(ctx)}/generation/image-to-model`, { method: "POST", headers: { ...h, "Content-Type": "application/json" }, body: JSON.stringify(body), label: "Tripo", timeoutMs: 60_000 }, ctx.log),
            "task creation",
        );
        const id = str(created.task_id) ?? str(created.id);
        if (!id) throw new Error("Tripo did not return a task id.");
        return { remoteId: id, meta: { model: ctx.settings.tripo.model } };
    },

    async poll(ctx, remoteId): Promise<PollResult> {
        const task = await getTask(ctx, remoteId);
        const state = mapStatus(task.status);
        const progress = toPercent(task.progress);
        switch (state) {
            case "succeeded": {
                const result = resultFrom(task);
                return result ? { state: "succeeded", progress: 100, result } : { state: "failed", error: "Tripo finished but returned no model URL." };
            }
            case "failed":
            case "expired": {
                const code = task.error_code !== undefined ? ` (code ${String(task.error_code)})` : "";
                return { state: "failed", error: `${str(task.error_message) ?? `Tripo task ${state}`}${code}` };
            }
            case "cancelled":
                return { state: "cancelled" };
            case "queued":
                return { state: "queued", progress, message: "Waiting in Tripo's queue" };
            case "running":
                return { state: "running", progress, message: "Tripo is generating" };
            default:
                return { state: "running", progress, message: `Tripo status: ${String(task.status ?? "unknown")}` };
        }
    },

    async list(ctx, page, pageSize) {
        const h = await auth(ctx);
        const limit = Math.max(1, Math.min(200, pageSize));
        const offset = (Math.max(1, page) - 1) * limit;
        const usage = await requestJson(ctx.fetch, `${base(ctx)}/account/usage?limit=${limit}&offset=${offset}`, { headers: h, label: "Tripo", timeoutMs: 30_000 }, ctx.log);
        const rows = usageRows(obj(usage).data ?? usage);
        const modelRows = rows.filter((r) => str(r.task_id) && /model|refine|texture|multiview|convert|stylize/i.test(String(r.type ?? "model")));
        const ids = [...new Set(modelRows.map((r) => str(r.task_id)!))].slice(0, 100);
        let details: Record<string, Record<string, unknown>> = {};
        if (ids.length) {
            try {
                const batch = unwrap(
                    await requestJson(ctx.fetch, `${base(ctx)}/tasks/list`, { method: "POST", headers: { ...h, "Content-Type": "application/json" }, body: JSON.stringify({ task_ids: ids }), label: "Tripo", timeoutMs: 30_000 }, ctx.log),
                    "task list",
                );
                const tasks = obj(batch.tasks);
                details = Object.fromEntries(Object.entries(tasks).map(([k, v]) => [k, obj(v)]));
            } catch (err) {
                ctx.log.warn("Tripo batch task query failed; showing usage rows only", (err as Error).message);
            }
        }
        const items: RemoteItem[] = modelRows.map((row) => {
            const id = str(row.task_id)!;
            const task = details[id] ?? {};
            const status = mapStatus(task.status ?? row.status);
            const out = obj(task.output);
            return {
                providerId: "tripo",
                remoteId: id,
                name: Object.keys(task).length ? taskName(task) : `Tripo ${String(row.type ?? "task")}`,
                status,
                progress: toPercent(task.progress),
                createdAt: toEpochMs(task.created_at ?? row.created_at),
                thumbnailUrl: str(out.rendered_image_url) ?? str(out.rendered_image),
                hasModel: status === "succeeded" && !!(str(out.model_url) ?? str(out.pbr_model) ?? str(out.model)),
                kind: str(task.type) ?? str(row.type),
            };
        });
        return {
            items,
            page,
            hasMore: rows.length >= limit,
            notice: "Tripo has no model-list API; this view is built from your account usage history.",
        };
    },

    async resolve(ctx, remoteId) {
        const task = await getTask(ctx, remoteId);
        const result = resultFrom(task);
        if (!result) throw new Error(`Tripo task ${remoteId} has no downloadable model (status ${String(task.status ?? "unknown")}).`);
        return result;
    },
};

