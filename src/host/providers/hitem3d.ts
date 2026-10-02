/**
 * Hitem3D / Hi3D (https://docs.hi3d.ai, changelog: /en/api/api-reference/changelog) — open-api v1.
 * The API host is still api.hitem3d.ai; keys are created at platform.hi3d.ai.
 *
 * Auth: the Access Key + Secret Key are exchanged for a bearer token:
 *   POST /auth/token with "Authorization: Basic base64(AK:SK)" → data.accessToken, data.tokenType.
 * Tokens are cached in memory for 50 minutes and refreshed once when an API call answers
 * "login expired" (Hitem3D reports errors as HTTP 200 with a non-200 `code`).
 * A single value without ":" is used directly as a bearer token.
 *
 * - Create: POST /submit-task (multipart): images (PNG/JPEG/WebP, ≤ 20 MB), request_type, model,
 *           resolution, format=2 (GLB — the API's own default is OBJ), face, pbr, rmbg, shading
 *           (de-shading strength, Aug 2026) → data.task_id
 * - Poll:   GET  /query-task?task_id= → data.state created|queueing|processing|success|failed,
 *           data.url (model) and data.cover_url, both valid for 1 hour.
 * - Browse: there is no list endpoint; the plugin's own task history is shown instead.
 * - Test:   GET  /balance → data.totalBalance.
 */
import { bytesToBase64, utf8Encode } from "@shared/bytes";
import { hitem3dSupportsPbr } from "@shared/settings";
import { bodyOf, multipartBody, requestJson } from "../platform/http";
import { formatFromUrl, obj, str, toPercent, type ModelResult, type PollResult, type ProviderAdapter, type ProviderContext } from "./types";

const TOKEN_TTL_MS = 50 * 60 * 1000;
type CachedToken = { authorization: string; expiresAt: number };
const tokenCache = new Map<string, CachedToken>();

/** Test hook. */
export function clearHitem3dTokenCache() {
    tokenCache.clear();
}

type Credentials = { kind: "keys"; ak: string; sk: string } | { kind: "token"; token: string };

export async function readCredentials(ctx: ProviderContext): Promise<Credentials | null> {
    const clean = (v: string) => v.replace(/["']/g, "").trim();
    let ak = clean(await ctx.secret("hitem3d.accessKey"));
    let sk = clean(await ctx.secret("hitem3d.secretKey"));
    if (!ak && !sk) return null;
    if (ak && !sk && ak.includes(":")) [ak, sk] = ak.split(":", 2).map((s) => s.trim());
    if (/^bearer\s+/i.test(ak)) return { kind: "token", token: ak.replace(/^bearer\s+/i, "") };
    if (ak && sk) return { kind: "keys", ak, sk };
    return ak ? { kind: "token", token: ak } : null;
}

const base64Ascii = (text: string) => bytesToBase64(utf8Encode(text));

/** True for Hitem3D's "your token is no good" answers (HTTP 401/403 or code 401 / "login expired"). */
export function isExpiredTokenResponse(body: unknown): boolean {
    const b = obj(body);
    const code = String(b.code ?? "");
    const msg = String(b.msg ?? b.message ?? "");
    return code === "401" || code === "403" || /login expired|token expired|invalid token/i.test(msg);
}

/** Plain-language meaning of Hitem3D's documented error codes (API reference, Sep 2026). */
export const HITEM3D_ERRORS: Record<string, string> = {
    "40010000": "the Access Key / Secret Key were rejected",
    "30010000": "your Hitem3D balance is too low",
    "50010001": "generation failed (credits refunded)",
    "10000000": "Hitem3D had an internal error; try again later",
    "10031001": "the image is larger than Hitem3D's 20 MB limit",
    "10031002": "the face count is outside the range Hitem3D accepts (Settings → Hitem3D → Face count)",
    "10031003": "this resolution is not available for the chosen model",
    "10031005": "Hitem3D accepts only PNG, JPEG and WebP images",
    "10031006": "Hitem3D does not know this model",
    "10031010": "the image arrived empty",
    "10031017": "this model cannot texture an existing mesh",
};

/** Hitem3D's upload limit per image. */
export const HITEM3D_MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** Throws for a non-success Hitem3D envelope; returns `data`. */
function unwrap(body: unknown, what: string): Record<string, unknown> {
    const b = obj(body);
    const code = b.code;
    if (code !== undefined && code !== null && String(code) !== "200" && String(code) !== "0") {
        const msg = str(b.msg) ?? str(b.message) ?? `code ${String(code)}`;
        const known = HITEM3D_ERRORS[String(code)];
        throw new Error(`Hitem3D ${what} failed: ${known ? `${known} (${msg})` : msg} [code ${String(code)}]`);
    }
    return obj(b.data);
}

async function authorization(ctx: ProviderContext, force = false): Promise<string> {
    const creds = await readCredentials(ctx);
    if (!creds) throw new Error("Hitem3D: add your Access Key and Secret Key in Settings → Hitem3D.");
    if (creds.kind === "token") return `Bearer ${creds.token}`;
    const cacheKey = `${ctx.settings.hitem3d.baseUrl}|${creds.ak}`;
    const now = ctx.now?.() ?? Date.now();
    const cached = tokenCache.get(cacheKey);
    if (!force && cached && cached.expiresAt > now) return cached.authorization;

    const body = await requestJson(
        ctx.fetch,
        `${ctx.settings.hitem3d.baseUrl}/auth/token`,
        {
            method: "POST",
            headers: { Authorization: `Basic ${base64Ascii(`${creds.ak}:${creds.sk}`)}`, Accept: "application/json", "Content-Type": "application/json" },
            body: "{}",
            label: "Hitem3D auth",
            timeoutMs: 30_000,
        },
        ctx.log,
    );
    const data = unwrap(body, "sign-in");
    const token = str(data.accessToken) ?? str(data.access_token) ?? str(data.token);
    if (!token) throw new Error("Hitem3D sign-in returned no token.");
    const type = str(data.tokenType) ?? str(data.token_type) ?? "Bearer";
    const value = `${type} ${token}`;
    tokenCache.set(cacheKey, { authorization: value, expiresAt: now + TOKEN_TTL_MS });
    return value;
}

/** Calls the API with a token, refreshing it once if Hitem3D says it expired. */
async function call(ctx: ProviderContext, path: string, init: { method?: string; body?: BodyInit; contentType?: string; timeoutMs?: number }, what: string): Promise<Record<string, unknown>> {
    const send = async (auth: string) => {
        const headers: Record<string, string> = { Authorization: auth, Accept: "application/json" };
        if (init.contentType) headers["Content-Type"] = init.contentType;
        if (ctx.settings.hitem3d.appId) headers.Appid = ctx.settings.hitem3d.appId;
        return requestJson(ctx.fetch, `${ctx.settings.hitem3d.baseUrl}${path}`, { method: init.method ?? "GET", headers, body: init.body, label: "Hitem3D", timeoutMs: init.timeoutMs ?? 30_000 }, ctx.log);
    };
    let body = await send(await authorization(ctx));
    if (isExpiredTokenResponse(body) && (await readCredentials(ctx))?.kind === "keys") {
        ctx.log.info("Hitem3D token expired; signing in again");
        body = await send(await authorization(ctx, true));
    }
    if (isExpiredTokenResponse(body)) throw new Error("Hitem3D: sign-in expired or the token is invalid. Check the keys in Settings → Hitem3D.");
    return unwrap(body, what);
}

/** Multipart fields for submit-task from the user's settings. */
export function buildSubmitFields(settings: ProviderContext["settings"]["hitem3d"]): Record<string, string> {
    const fields: Record<string, string> = {
        request_type: settings.requestType,
        model: settings.model,
        resolution: settings.resolution,
        format: "2", // GLB; Hitem3D defaults to OBJ
        rmbg: settings.removeBackground ? "1" : "0",
    };
    if (settings.face > 0) fields.face = String(settings.face);
    if (hitem3dSupportsPbr(settings.model) && settings.requestType !== "1") fields.pbr = settings.pbr ? "1" : "0";
    // De-shading (v2.0, v2.1, v3.0). Only sent when changed from Hitem3D's default of 0.5.
    if (hitem3dSupportsPbr(settings.model) && settings.requestType !== "1" && settings.shading !== 0.5) fields.shading = settings.shading.toFixed(1);
    return fields;
}

const STATE_PROGRESS: Record<string, number> = { created: 5, queueing: 15, processing: 50 };

function resultFrom(data: Record<string, unknown>, remoteId: string): ModelResult | undefined {
    const taskResult = obj(data.task_result);
    const url = str(data.url) ?? str(data.model_url) ?? str(taskResult.model_url) ?? str(taskResult.url) ?? str(data.download_url);
    if (!url) return undefined;
    return {
        modelUrl: url,
        format: formatFromUrl(url),
        thumbnailUrl: str(data.cover_url) ?? str(taskResult.cover_url) ?? str(data.render_url) ?? str(taskResult.render_url),
        name: `Hitem3D ${remoteId.slice(0, 8)}`,
        meta: { assetId: data.id },
    };
}

export const hitem3d: ProviderAdapter = {
    id: "hitem3d",
    label: "Hitem3D",
    // Browse is served from the plugin's task history (no list endpoint).
    capabilities: { generate: true, browse: true, cancel: false },

    async isConfigured(ctx) {
        return (await readCredentials(ctx)) ? { configured: true } : { configured: false, hint: "Add your Hitem3D Access Key and Secret Key in Settings." };
    },

    async test(ctx) {
        try {
            const data = await call(ctx, "/balance", {}, "balance");
            const balance = data.totalBalance ?? data.balance;
            return { ok: true, message: "Connected to Hitem3D.", balance: balance !== undefined ? `${String(balance)} balance` : undefined };
        } catch (err) {
            return { ok: false, message: (err as Error).message };
        }
    },

    async submit(ctx, input) {
        if (input.image.byteLength > HITEM3D_MAX_UPLOAD_BYTES) {
            throw new Error(`The image is ${Math.round(input.image.byteLength / 1e6)} MB; Hitem3D accepts up to 20 MB. Lower Settings → Generation → Max image size, or crop the layer.`);
        }
        const fields = buildSubmitFields(ctx.settings.hitem3d);
        const form = multipartBody([{ name: "images", value: input.image, filename: "image.png", contentType: "image/png" }, ...Object.entries(fields).map(([name, value]) => ({ name, value }))]);
        const data = await call(ctx, "/submit-task", { method: "POST", body: bodyOf(form.body), contentType: form.contentType, timeoutMs: 180_000 }, "task creation");
        const id = str(data.task_id) ?? str(data.taskId) ?? str(data.id);
        if (!id) throw new Error("Hitem3D did not return a task id.");
        return { remoteId: id, meta: { model: ctx.settings.hitem3d.model, resolution: ctx.settings.hitem3d.resolution } };
    },

    async poll(ctx, remoteId, meta): Promise<PollResult> {
        const data = await call(ctx, `/query-task?task_id=${encodeURIComponent(remoteId)}`, {}, "task query");
        const state = String(data.state ?? "").toLowerCase();
        const legacyStatus = data.task_status;
        const result = resultFrom(data, remoteId);
        const previous = typeof meta?.progress === "number" ? meta.progress : 0;
        if (state === "success" || legacyStatus === 4 || (result && state !== "failed")) {
            return result ? { state: "succeeded", progress: 100, result } : { state: "failed", error: "Hitem3D finished but returned no model URL." };
        }
        if (state === "failed" || legacyStatus === -1) {
            return { state: "failed", error: str(data.task_msg) ?? str(data.message) ?? "Hitem3D generation failed (credits are refunded)." };
        }
        const reported = toPercent(data.process_pct ?? data.progress ?? data.percent);
        const progress = Math.max(previous, reported ?? STATE_PROGRESS[state] ?? 10);
        return {
            state: state === "created" || state === "queueing" ? "queued" : "running",
            progress,
            message: state ? `Hitem3D: ${state}` : "Hitem3D is generating",
            meta: { ...(meta ?? {}), progress },
        };
    },

    async resolve(ctx, remoteId) {
        const data = await call(ctx, `/query-task?task_id=${encodeURIComponent(remoteId)}`, {}, "task query");
        const result = resultFrom(data, remoteId);
        if (!result) throw new Error(`Hitem3D task ${remoteId} has no downloadable model (state ${String(data.state ?? "unknown")}).`);
        return result;
    },
};
