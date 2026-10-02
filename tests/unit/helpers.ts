/**
 * Test helpers: a scripted fetch, a provider context, and small fixtures.
 */
import { DEFAULT_SETTINGS, mergeSettings, type DeepPartial, type SecretKey, type Settings } from "../../src/shared/settings";
import { MemoryLogger } from "../../src/host/platform/logger";
import type { ProviderContext } from "../../src/host/providers/types";
import type { FetchLike } from "../../src/host/platform/http";

export type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
export type Route = { match: (url: string, method: string) => boolean; reply: (call: Call) => Response | Promise<Response> };

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

export function bytes(data: Uint8Array, status = 200): Response {
    return new Response(data as BodyInit, { status });
}

/** A fetch that answers from `routes` in order of definition and records every call. */
export function scriptedFetch(routes: Route[]): FetchLike & { calls: Call[] } {
    const calls: Call[] = [];
    const fn = (async (input: string, init?: RequestInit) => {
        const method = (init?.method ?? "GET").toUpperCase();
        const headers: Record<string, string> = {};
        new Headers(init?.headers).forEach((v, k) => (headers[k.toLowerCase()] = v));
        const call: Call = { url: input, method, headers, body: init?.body };
        calls.push(call);
        const route = routes.find((r) => r.match(input, method));
        if (!route) throw new Error(`No route for ${method} ${input}`);
        return route.reply(call);
    }) as FetchLike & { calls: Call[] };
    fn.calls = calls;
    return fn;
}

export const route = (method: string, test: string | RegExp, reply: Route["reply"]): Route => ({
    match: (url, m) => m === method && (typeof test === "string" ? url === test : test.test(url)),
    reply,
});

export function context(fetch: FetchLike, patch: DeepPartial<Settings> = {}, secrets: Partial<Record<SecretKey, string>> = {}, now = () => 1_790_000_000_000): ProviderContext & { log: MemoryLogger } {
    return {
        fetch,
        settings: mergeSettings(DEFAULT_SETTINGS, patch),
        secret: async (k) => secrets[k] ?? "",
        log: new MemoryLogger(),
        now,
    };
}

/** Decodes a multipart body built by multipartBody() into fields and files. */
export function parseMultipart(body: unknown, contentType: string): { fields: Record<string, string>; files: Record<string, { filename: string; bytes: Uint8Array }> } {
    const boundary = /boundary=(.+)$/.exec(contentType)![1];
    const raw = new Uint8Array(body as ArrayBuffer);
    const text = Buffer.from(raw).toString("latin1");
    const fields: Record<string, string> = {};
    const files: Record<string, { filename: string; bytes: Uint8Array }> = {};
    for (const part of text.split(`--${boundary}`).slice(1, -1)) {
        const [head, ...rest] = part.split("\r\n\r\n");
        const content = rest.join("\r\n\r\n").replace(/\r\n$/, "");
        const name = /name="([^"]+)"/.exec(head)![1];
        const filename = /filename="([^"]*)"/.exec(head)?.[1];
        if (filename !== undefined) files[name] = { filename, bytes: new Uint8Array(Buffer.from(content, "latin1")) };
        else fields[name] = Buffer.from(content, "latin1").toString("utf8");
    }
    return { fields, files };
}

/** Smallest valid GLB header + empty JSON chunk (enough for format sniffing). */
export function fakeGlb(size = 64): Uint8Array {
    const b = new Uint8Array(size);
    b.set([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0]);
    return b;
}

export const PNG_1PX = new Uint8Array(
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"),
);
