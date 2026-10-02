/**
 * HTTP helpers for provider calls.
 *
 * All network traffic goes through the UXP host's fetch, which (unlike the WebView)
 * is not subject to browser CORS — Tripo's API, for example, rejects browser
 * origins. Errors carry the provider's own message so the UI can show something
 * actionable, and every request/response is logged without credentials.
 */
import type { Logger } from "./logger";
import { utf8Encode } from "@shared/bytes";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class HttpError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly body: unknown,
        readonly url: string,
        /** How long the service asked us to wait (Retry-After / X-RateLimit-Reset), if it said. */
        readonly retryAfterMs?: number,
    ) {
        super(message);
        this.name = "HttpError";
    }
}

type HeaderBag = { get(name: string): string | null } | undefined;
const header = (headers: HeaderBag, name: string): string | null => {
    try {
        return headers?.get(name) ?? null;
    } catch {
        return null;
    }
};

/**
 * Milliseconds the service asked us to wait: `Retry-After` (seconds or an HTTP date, sent by
 * Meshy and Tripo with 429) or `X-RateLimit-Reset` (seconds, or epoch seconds/milliseconds).
 */
export function retryAfterMs(headers: HeaderBag, now = Date.now()): number | undefined {
    const retryAfter = header(headers, "retry-after");
    if (retryAfter) {
        const seconds = Number(retryAfter);
        if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
        const at = Date.parse(retryAfter);
        if (!Number.isNaN(at)) return Math.max(0, at - now);
    }
    const reset = Number(header(headers, "x-ratelimit-reset") ?? NaN);
    if (Number.isFinite(reset)) return Math.max(0, reset > 1e12 ? reset - now : reset > 1e9 ? reset * 1000 - now : reset * 1000);
    return undefined;
}

/** Endpoints a service has marked deprecated; each is logged once per session. */
const reportedDeprecations = new Set<string>();

/**
 * Services announce retirements with a `Deprecation` header (RFC 9745; Meshy sends it with a
 * `Link` to the migration notes). Logging it means a retirement shows up in the log long
 * before the endpoint stops working.
 */
function reportDeprecation(headers: HeaderBag, label: string, method: string, url: string, log?: Logger) {
    const deprecation = header(headers, "deprecation");
    if (!deprecation || !log) return;
    let path = url;
    try {
        const u = new URL(url);
        path = `${u.host}${u.pathname}`;
    } catch {
        // keep the raw URL
    }
    const key = `${method} ${path}`;
    if (reportedDeprecations.has(key)) return;
    reportedDeprecations.add(key);
    const link = header(headers, "link");
    const sunset = header(headers, "sunset");
    log.warn(`${label}: the service marked ${method} ${path} as deprecated (Deprecation: ${deprecation}${sunset ? `; Sunset: ${sunset}` : ""}${link ? `; ${link}` : ""}). Please report this at https://github.com/GeekatplayStudio/Photoshop-3D/issues so the plugin can be updated.`);
}

export type RequestOptions = {
    method?: string;
    headers?: Record<string, string>;
    body?: BodyInit | null;
    /** Milliseconds before the request is abandoned. */
    timeoutMs?: number;
    /** Provider label used in error messages ("Meshy"). */
    label?: string;
};

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Extracts a human message from typical API error bodies. */
export function errorMessageFrom(body: unknown): string | undefined {
    if (!body) return undefined;
    if (typeof body === "string") return body.trim().slice(0, 300) || undefined;
    if (typeof body !== "object") return undefined;
    const b = body as Record<string, unknown>;
    const pick = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    const nested = b.error && typeof b.error === "object" ? (b.error as Record<string, unknown>) : undefined;
    return pick(b.message) ?? pick(b.msg) ?? pick(nested?.message) ?? pick(b.error) ?? pick(b.detail) ?? pick(b.suggestion);
}

export async function requestJson<T = unknown>(fetchFn: FetchLike, url: string, opts: RequestOptions, log?: Logger): Promise<T> {
    const label = opts.label ?? "Request";
    const method = opts.method ?? "GET";
    const started = Date.now();
    let res: Response;
    try {
        res = await withTimeout(fetchFn(url, { method, headers: opts.headers, body: opts.body ?? undefined }), opts.timeoutMs ?? 60_000, `${label} ${method}`);
    } catch (err) {
        log?.warn(`${label} ${method} ${url} failed`, String((err as Error).message ?? err));
        throw new Error(`${label}: cannot reach ${new URL(url).host} (${(err as Error).message ?? err})`);
    }
    const text = await res.text();
    let body: unknown = text;
    try {
        body = text ? JSON.parse(text) : null;
    } catch {
        // non-JSON body (HTML error page, plain text)
    }
    log?.debug(`${label} ${method} ${url} → ${res.status} in ${Date.now() - started} ms`, typeof body === "string" ? body.slice(0, 300) : body);
    reportDeprecation(res.headers, label, method, url, log);
    if (!res.ok) {
        const detail = errorMessageFrom(body) ?? res.statusText;
        const wait = retryAfterMs(res.headers);
        throw new HttpError(`${label} error ${res.status}${detail ? `: ${detail}` : ""}${errorExtras(body, detail, res.status)}`, res.status, body, url, wait);
    }
    return body as T;
}

/**
 * The parts of an error body worth showing besides the message: the service's own error
 * code, its suggestion, and the request id its support asks for (Tripo sends all three).
 */
export function errorExtras(body: unknown, shown: string | undefined, status: number): string {
    if (!body || typeof body !== "object") return "";
    const b = body as Record<string, unknown>;
    const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : undefined);
    const suggestion = text(b.suggestion);
    const code = text(b.code);
    const requestId = text(b.request_id) ?? text(b.requestId) ?? text(b.trace_id);
    const parts: string[] = [];
    if (code && code !== "0" && code !== String(status)) parts.push(`code ${code}`);
    if (requestId) parts.push(`request ${requestId}`);
    return `${suggestion && suggestion !== shown ? ` (${suggestion})` : ""}${parts.length ? ` [${parts.join(", ")}]` : ""}`;
}

export type DownloadOptions = {
    headers?: Record<string, string>;
    timeoutMs?: number;
    maxBytes?: number;
    label?: string;
};

/** Downloads a file into memory. Signed provider URLs expire, so this runs as soon as a result is ready. */
export async function downloadBytes(fetchFn: FetchLike, url: string, opts: DownloadOptions = {}, log?: Logger): Promise<Uint8Array> {
    const label = opts.label ?? "Download";
    const started = Date.now();
    let res: Response;
    try {
        res = await withTimeout(fetchFn(url, { headers: opts.headers }), opts.timeoutMs ?? 10 * 60_000, label);
    } catch (err) {
        throw new Error(`${label}: cannot download ${safeUrl(url)} (${(err as Error).message ?? err})`);
    }
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new HttpError(`${label} failed with HTTP ${res.status}${res.status === 403 ? " (the link may have expired)" : ""}`, res.status, text.slice(0, 300), url);
    }
    const buffer = await withTimeout(res.arrayBuffer(), opts.timeoutMs ?? 10 * 60_000, label);
    const bytes = new Uint8Array(buffer);
    const max = opts.maxBytes ?? 512 * 1024 * 1024;
    if (bytes.byteLength > max) throw new Error(`${label}: file is ${Math.round(bytes.byteLength / 1e6)} MB, over the ${Math.round(max / 1e6)} MB limit`);
    log?.debug(`${label} ${safeUrl(url)} ${bytes.byteLength} bytes in ${Date.now() - started} ms`);
    return bytes;
}

/** URL without its query string (signed URLs carry credentials there). */
export function safeUrl(url: string): string {
    const q = url.indexOf("?");
    return q === -1 ? url : `${url.slice(0, q)}?…`;
}

/**
 * Builds a multipart/form-data body by hand. UXP's fetch accepts ArrayBuffer
 * bodies everywhere, while FormData support differs between versions.
 */
export function multipartBody(parts: { name: string; value: string | Uint8Array; filename?: string; contentType?: string }[]): { body: Uint8Array; contentType: string } {
    const boundary = `----ps3d${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
    const chunks: Uint8Array[] = [];
    for (const p of parts) {
        let head = `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"`;
        if (p.filename !== undefined) head += `; filename="${p.filename}"`;
        head += "\r\n";
        if (p.contentType) head += `Content-Type: ${p.contentType}\r\n`;
        head += "\r\n";
        chunks.push(utf8Encode(head));
        chunks.push(typeof p.value === "string" ? utf8Encode(p.value) : p.value);
        chunks.push(utf8Encode("\r\n"));
    }
    chunks.push(utf8Encode(`--${boundary}--\r\n`));
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const body = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) {
        body.set(c, o);
        o += c.length;
    }
    return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Body for fetch from a Uint8Array view (ArrayBuffer of exactly the view's bytes). */
export function bodyOf(bytes: Uint8Array): ArrayBuffer {
    return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? (bytes.buffer as ArrayBuffer) : (bytes.slice().buffer as ArrayBuffer);
}
