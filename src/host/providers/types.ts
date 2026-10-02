/**
 * The contract every 3D service implements.
 *
 * Adapters are plain objects with no Photoshop or UXP dependencies: they get a
 * `fetch`, the settings, a secret reader and a logger through ProviderContext, so
 * each one is unit-tested against recorded API responses (src/host/providers/*.test.ts).
 * Adding a new service = one file implementing ProviderAdapter + one line in registry.ts.
 */
import type { ProviderCapabilities, ProviderId, ProviderTestResult, RemotePage } from "@shared/types";
import type { SecretKey, Settings } from "@shared/settings";
import type { FetchLike } from "../platform/http";
import type { Logger } from "../platform/logger";
import type { FileStore } from "../platform/fileStore";

export type ProviderContext = {
    fetch: FetchLike;
    settings: Settings;
    secret(key: SecretKey): Promise<string>;
    log: Logger;
    /** Plugin data folder, for providers that keep small state files (e.g. Hitem3D task history). */
    store?: FileStore;
    now?: () => number;
};

export type SubmitInput = {
    /** PNG bytes of the layer or selection. */
    image: Uint8Array;
    width: number;
    height: number;
    /** True when the image has transparent pixels (a cut-out object). */
    hasAlpha: boolean;
    /** Human name for the task ("Chair - selection"). */
    name: string;
};

export type SubmitResult = {
    remoteId: string;
    /** Saved with the job; handed back to poll()/cancel(). */
    meta?: Record<string, unknown>;
};

/** A finished model ready to download. URLs are usually signed and short-lived. */
export type ModelResult = {
    modelUrl: string;
    format: "glb" | "gltf";
    thumbnailUrl?: string;
    /** Extra headers the download needs (none of the current providers require any). */
    headers?: Record<string, string>;
    name?: string;
    createdAt?: number;
    /** Small, credential-free summary kept in the library for transparency. */
    meta?: Record<string, unknown>;
};

export type PollState = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type PollResult = {
    state: PollState;
    /** 0-100 when the provider reports it. */
    progress?: number;
    message?: string;
    error?: string;
    result?: ModelResult;
    /** Updated meta to persist (e.g. a refine stage). */
    meta?: Record<string, unknown>;
};

export type Configured = { configured: boolean; hint?: string };

export interface ProviderAdapter {
    readonly id: ProviderId;
    readonly label: string;
    readonly capabilities: ProviderCapabilities;
    isConfigured(ctx: ProviderContext): Promise<Configured>;
    /** Checks the key/address and reports balance when possible. */
    test(ctx: ProviderContext): Promise<ProviderTestResult>;
    submit(ctx: ProviderContext, input: SubmitInput): Promise<SubmitResult>;
    poll(ctx: ProviderContext, remoteId: string, meta?: Record<string, unknown>): Promise<PollResult>;
    /** One page of the user's remote models, newest first (1-based pages). */
    list?(ctx: ProviderContext, page: number, pageSize: number): Promise<RemotePage>;
    /** Fresh download URLs for a remote model (for importing from Browse). */
    resolve(ctx: ProviderContext, remoteId: string, meta?: Record<string, unknown>): Promise<ModelResult>;
    cancel?(ctx: ProviderContext, remoteId: string, meta?: Record<string, unknown>): Promise<void>;
}

/** Converts 0-1 fractions and 0-100 numbers/strings to a clamped percentage. */
export function toPercent(value: unknown): number | undefined {
    const n = typeof value === "number" ? value : typeof value === "string" ? parseFloat(value) : NaN;
    if (!Number.isFinite(n)) return undefined;
    const pct = n > 0 && n <= 1 && !Number.isInteger(n) ? n * 100 : n;
    return Math.max(0, Math.min(100, Math.round(pct)));
}

/** Seconds or milliseconds or ISO string → epoch ms. */
export function toEpochMs(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value < 1e12 ? value * 1000 : value;
    if (typeof value === "string" && value.trim()) {
        const n = Number(value);
        if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
        const t = Date.parse(value);
        return Number.isFinite(t) ? t : undefined;
    }
    return undefined;
}

export const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
export const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** "model.glb?Expires=…" → "glb"; anything else defaults to glb. */
export function formatFromUrl(url: string): "glb" | "gltf" {
    const path = url.split("?")[0].toLowerCase();
    return path.endsWith(".gltf") ? "gltf" : "glb";
}
