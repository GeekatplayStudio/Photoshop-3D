/**
 * Plugin settings: defaults, validation and the public (secret-free) view.
 *
 * Settings live in settings.json in the shared user-data folder. API keys never go
 * there: they are kept in credentials.json (see src/host/platform/secrets.ts) and only
 * "is set" + a short preview cross the bridge. `sanitizeSettings` is the single gate every load and
 * every update goes through, so a hand-edited or old settings file can never put
 * the plugin into an invalid state.
 */
import type { ProviderId, SendSource } from "./types";
import { PROVIDER_IDS } from "./types";
import { DEFAULT_LIGHTING, ENVIRONMENTS, type LightingDefaults } from "./threeD";

export const SECRET_KEYS = ["meshy.apiKey", "tripo.apiKey", "hitem3d.accessKey", "hitem3d.secretKey"] as const;
export type SecretKey = (typeof SECRET_KEYS)[number];

/*
 * Model lists as documented by each provider on 2026-10-02 (see docs/PROVIDERS.md).
 * The Settings tab also accepts any other id, so a new provider model never needs
 * a plugin update to be usable.
 */
export const MESHY_AI_MODELS = ["latest", "meshy-7.1", "meshy-6", "meshy-6-lite"] as const;
export const TRIPO_MODEL_VERSIONS = ["v3.1-20260211", "v3.0-20250812", "v2.5-20250123", "P1-20260311"] as const;
export const HITEM3D_MODELS = ["hi3dv3.0", "hitem3dv2.1", "hitem3dv2.0", "hitem3dv1.5", "scene-portraitv2.1", "scene-portraitv2.0", "scene-portraitv1.5"] as const;

/** Allowed Hitem3D resolutions per model (docs.hitem3d.ai create-task). */
export const HITEM3D_RESOLUTIONS: Record<string, string[]> = {
    "hi3dv3.0": ["2048quality", "2048master"],
    "hitem3dv2.1": ["1536fast", "1536pro"],
    "hitem3dv2.0": ["1536", "1536pro"],
    "hitem3dv1.5": ["512", "1024", "1536", "1536pro"],
    "scene-portraitv2.1": ["1536profast", "1536pro"],
    "scene-portraitv2.0": ["1536pro"],
    "scene-portraitv1.5": ["1536"],
};
export const HITEM3D_DEFAULT_RESOLUTION: Record<string, string> = {
    "hi3dv3.0": "2048quality",
    "hitem3dv2.1": "1536fast",
    "hitem3dv2.0": "1536",
    "hitem3dv1.5": "1024",
    "scene-portraitv2.1": "1536profast",
    "scene-portraitv2.0": "1536pro",
    "scene-portraitv1.5": "1536",
};
/** PBR is only accepted by the v2.0, v2.1 and v3.0 models. */
export const hitem3dSupportsPbr = (model: string) => /v(2\.[01]|3\.0)$/.test(model);

export type Settings = {
    version: 1;
    defaultProvider: ProviderId;
    meshy: {
        baseUrl: string;
        aiModel: string;
        /** Geometry detail; 2k/4k need meshy-7.1 or latest. */
        geometryResolution: "standard" | "2k" | "4k";
        textureResolution: "2k" | "4k" | "8k";
        shouldTexture: boolean;
        enablePbr: boolean;
        shouldRemesh: boolean;
        topology: "triangle" | "quad";
        /** Remesh target, 0 = provider default (30,000). */
        targetPolycount: number;
        /** meshy-6 only: bake out the lighting visible in the photo. */
        removeLighting: boolean;
        imageEnhancement: boolean;
    };
    tripo: {
        baseUrl: string;
        model: string;
        texture: boolean;
        pbr: boolean;
        textureQuality: "standard" | "detailed" | "extreme";
        geometryQuality: "standard" | "detailed";
        /** 0 = provider default. */
        faceLimit: number;
        smartLowPoly: boolean;
        autoSize: boolean;
        orientation: "default" | "align_image";
    };
    hitem3d: {
        baseUrl: string;
        /** Optional Appid header some accounts use. */
        appId: string;
        model: string;
        resolution: string;
        /** "3" = geometry + texture, "1" = geometry only. */
        requestType: "1" | "3";
        /** 0 = provider default, otherwise 100000-5000000. */
        face: number;
        pbr: boolean;
        /** Let Hitem3D remove the background before generating. */
        removeBackground: boolean;
    };
    comfyui: {
        url: string;
        workflow: "trellis2" | "custom";
        customWorkflowName: string;
        /** API-format workflow JSON (Workflow > Export (API) in ComfyUI). */
        customWorkflow: Record<string, unknown> | null;
        /** LoadImage node that receives the layer; "" = detect automatically. */
        imageNodeId: string;
        removeBackground: boolean;
        textureSize: number;
        faceCount: number;
        /** -1 = random each run. */
        seed: number;
        timeoutMinutes: number;
    };
    send: {
        source: SendSource;
        /** Longest edge of the image sent to providers; larger sources are scaled down. */
        maxEdge: number;
    };
    editor: {
        defaultResolution: number;
        /** Double-clicking a 3D layer's thumbnail opens the 3D editor instead of the .psb. */
        interceptDoubleClick: boolean;
        rememberLighting: boolean;
        lighting: LightingDefaults;
    };
    updates: {
        autoCheck: boolean;
        checkIntervalHours: number;
        includePrerelease: boolean;
        /** "owner/name" of the GitHub repository releases come from. */
        repo: string;
        lastCheckAt: number;
        skippedVersion: string;
    };
    library: {
        autoThumbnails: boolean;
    };
    ui: {
        /** The first-run "Getting started" card was closed. */
        welcomeDismissed: boolean;
    };
};

export const DEFAULT_REPO = "GeekatplayStudio/Photoshop-3D";

export const DEFAULT_SETTINGS: Settings = {
    version: 1,
    defaultProvider: "meshy",
    meshy: {
        baseUrl: "https://api.meshy.ai",
        aiModel: "latest",
        geometryResolution: "standard",
        textureResolution: "2k",
        shouldTexture: true,
        enablePbr: true,
        shouldRemesh: false,
        topology: "triangle",
        targetPolycount: 0,
        removeLighting: true,
        imageEnhancement: true,
    },
    tripo: {
        baseUrl: "https://openapi.tripo3d.ai/v3",
        model: "v3.1-20260211",
        texture: true,
        pbr: true,
        textureQuality: "standard",
        geometryQuality: "standard",
        faceLimit: 0,
        smartLowPoly: false,
        autoSize: false,
        orientation: "default",
    },
    hitem3d: {
        baseUrl: "https://api.hitem3d.ai/open-api/v1",
        appId: "",
        model: "hi3dv3.0",
        resolution: "2048quality",
        requestType: "3",
        face: 0,
        pbr: true,
        removeBackground: true,
    },
    comfyui: {
        url: "http://127.0.0.1:8188",
        workflow: "trellis2",
        customWorkflowName: "",
        customWorkflow: null,
        imageNodeId: "",
        removeBackground: false,
        textureSize: 2048,
        faceCount: 300000,
        seed: -1,
        timeoutMinutes: 30,
    },
    send: {
        source: "auto",
        maxEdge: 2048,
    },
    editor: {
        defaultResolution: 2048,
        interceptDoubleClick: true,
        rememberLighting: true,
        lighting: DEFAULT_LIGHTING,
    },
    updates: {
        autoCheck: true,
        checkIntervalHours: 12,
        includePrerelease: false,
        repo: DEFAULT_REPO,
        lastCheckAt: 0,
        skippedVersion: "",
    },
    library: {
        autoThumbnails: true,
    },
    ui: {
        welcomeDismissed: false,
    },
};

export type DeepPartial<T> = T extends Array<unknown> ? T : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

export type SecretInfo = { set: boolean; preview: string };
export type PublicSettings = Settings & { secrets: Record<SecretKey, SecretInfo> };

/* ---------------------------------------------------------- validation */

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
const str = (v: unknown, d: string) => (typeof v === "string" ? v : d);
const num = (v: unknown, d: number, min: number, max: number) => {
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};
const int = (v: unknown, d: number, min: number, max: number) => Math.round(num(v, d, min, max));
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], d: T): T => (allowed.includes(v as T) ? (v as T) : d);
/** http(s) URL without trailing slashes; anything else falls back to the default. */
export const normalizeUrl = (v: unknown, d: string) => {
    if (typeof v !== "string" || !v.trim()) return d;
    let url = v.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
    try {
        return new URL(url).toString().replace(/\/+$/, "");
    } catch {
        return d;
    }
};
const color = (v: unknown, d: string) => (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : d);
const vec = (v: unknown, d: { x: number; y: number; z: number }) =>
    isObj(v) ? { x: num(v.x, d.x, -1000, 1000), y: num(v.y, d.y, -1000, 1000), z: num(v.z, d.z, -1000, 1000) } : { ...d };

function sanitizeLighting(raw: unknown): LightingDefaults {
    const r = isObj(raw) ? raw : {};
    const d = DEFAULT_LIGHTING;
    return {
        lightPosition: vec(r.lightPosition, d.lightPosition),
        lightIntensity: num(r.lightIntensity, d.lightIntensity, 0, 10),
        lightColor: color(r.lightColor, d.lightColor),
        ambientIntensity: num(r.ambientIntensity, d.ambientIntensity, 0, 5),
        environment: oneOf(r.environment, ENVIRONMENTS as unknown as string[], d.environment),
        envIntensity: num(r.envIntensity, d.envIntensity, 0, 5),
        castShadowEnabled: bool(r.castShadowEnabled, d.castShadowEnabled),
        castShadowBlur: num(r.castShadowBlur, d.castShadowBlur, 0, 100),
        castShadowIntensity: num(r.castShadowIntensity, d.castShadowIntensity, 0, 1),
        contactShadowEnabled: bool(r.contactShadowEnabled, d.contactShadowEnabled),
        contactShadowBlur: num(r.contactShadowBlur, d.contactShadowBlur, 0, 50),
        contactShadowIntensity: num(r.contactShadowIntensity, d.contactShadowIntensity, 0, 1),
    };
}

/** Returns valid settings from anything (old files, partial objects, garbage). */
export function sanitizeSettings(raw: unknown): Settings {
    const r = isObj(raw) ? raw : {};
    const d = DEFAULT_SETTINGS;
    const m = isObj(r.meshy) ? r.meshy : {};
    const t = isObj(r.tripo) ? r.tripo : {};
    const h = isObj(r.hitem3d) ? r.hitem3d : {};
    const c = isObj(r.comfyui) ? r.comfyui : {};
    const s = isObj(r.send) ? r.send : {};
    const e = isObj(r.editor) ? r.editor : {};
    const u = isObj(r.updates) ? r.updates : {};
    const l = isObj(r.library) ? r.library : {};
    const ui = isObj(r.ui) ? r.ui : {};

    const hModel = oneOf(h.model, HITEM3D_MODELS as unknown as string[], d.hitem3d.model);
    const hRes = HITEM3D_RESOLUTIONS[hModel].includes(h.resolution as string) ? (h.resolution as string) : HITEM3D_DEFAULT_RESOLUTION[hModel];
    const hFace = int(h.face, 0, 0, 5_000_000);

    const workflow = isObj(c.customWorkflow) ? c.customWorkflow : null;

    return {
        version: 1,
        defaultProvider: oneOf(r.defaultProvider, PROVIDER_IDS, d.defaultProvider),
        meshy: {
            baseUrl: normalizeUrl(m.baseUrl, d.meshy.baseUrl),
            aiModel: typeof m.aiModel === "string" && m.aiModel.trim() ? m.aiModel.trim() : d.meshy.aiModel,
            geometryResolution: oneOf(m.geometryResolution, ["standard", "2k", "4k"] as const, d.meshy.geometryResolution),
            textureResolution: oneOf(m.textureResolution, ["2k", "4k", "8k"] as const, d.meshy.textureResolution),
            shouldTexture: bool(m.shouldTexture, d.meshy.shouldTexture),
            enablePbr: bool(m.enablePbr, d.meshy.enablePbr),
            shouldRemesh: bool(m.shouldRemesh, d.meshy.shouldRemesh),
            topology: oneOf(m.topology, ["triangle", "quad"] as const, d.meshy.topology),
            targetPolycount: int(m.targetPolycount, 0, 0, 300_000),
            removeLighting: bool(m.removeLighting, d.meshy.removeLighting),
            imageEnhancement: bool(m.imageEnhancement, d.meshy.imageEnhancement),
        },
        tripo: {
            baseUrl: normalizeUrl(t.baseUrl, d.tripo.baseUrl),
            model: typeof t.model === "string" && t.model.trim() ? t.model.trim() : d.tripo.model,
            texture: bool(t.texture, d.tripo.texture),
            pbr: bool(t.pbr, d.tripo.pbr),
            textureQuality: oneOf(t.textureQuality, ["standard", "detailed", "extreme"] as const, d.tripo.textureQuality),
            geometryQuality: oneOf(t.geometryQuality, ["standard", "detailed"] as const, d.tripo.geometryQuality),
            faceLimit: int(t.faceLimit, 0, 0, 2_000_000),
            smartLowPoly: bool(t.smartLowPoly, d.tripo.smartLowPoly),
            autoSize: bool(t.autoSize, d.tripo.autoSize),
            orientation: oneOf(t.orientation, ["default", "align_image"] as const, d.tripo.orientation),
        },
        hitem3d: {
            baseUrl: normalizeUrl(h.baseUrl, d.hitem3d.baseUrl),
            appId: str(h.appId, "").trim(),
            model: hModel,
            resolution: hRes,
            requestType: oneOf(h.requestType, ["1", "3"] as const, d.hitem3d.requestType),
            face: hFace === 0 ? 0 : Math.max(100_000, hFace),
            pbr: bool(h.pbr, d.hitem3d.pbr),
            removeBackground: bool(h.removeBackground, d.hitem3d.removeBackground),
        },
        comfyui: {
            url: normalizeUrl(c.url, d.comfyui.url),
            workflow: oneOf(c.workflow, ["trellis2", "custom"] as const, d.comfyui.workflow),
            customWorkflowName: str(c.customWorkflowName, ""),
            customWorkflow: workflow,
            imageNodeId: str(c.imageNodeId, ""),
            removeBackground: bool(c.removeBackground, d.comfyui.removeBackground),
            textureSize: int(c.textureSize, d.comfyui.textureSize, 512, 8192),
            faceCount: int(c.faceCount, d.comfyui.faceCount, 10_000, 5_000_000),
            seed: int(c.seed, -1, -1, 2 ** 48),
            timeoutMinutes: int(c.timeoutMinutes, d.comfyui.timeoutMinutes, 1, 240),
        },
        send: {
            source: oneOf(s.source, ["auto", "layer", "selection"] as const, d.send.source),
            maxEdge: int(s.maxEdge, d.send.maxEdge, 256, 4096),
        },
        editor: {
            defaultResolution: int(e.defaultResolution, d.editor.defaultResolution, 256, 8192),
            interceptDoubleClick: bool(e.interceptDoubleClick, d.editor.interceptDoubleClick),
            rememberLighting: bool(e.rememberLighting, d.editor.rememberLighting),
            lighting: sanitizeLighting(e.lighting),
        },
        updates: {
            autoCheck: bool(u.autoCheck, d.updates.autoCheck),
            checkIntervalHours: int(u.checkIntervalHours, d.updates.checkIntervalHours, 1, 24 * 30),
            includePrerelease: bool(u.includePrerelease, d.updates.includePrerelease),
            repo: typeof u.repo === "string" && /^[\w.-]+\/[\w.-]+$/.test(u.repo.trim()) ? u.repo.trim() : d.updates.repo,
            lastCheckAt: int(u.lastCheckAt, 0, 0, Number.MAX_SAFE_INTEGER),
            skippedVersion: str(u.skippedVersion, ""),
        },
        library: {
            autoThumbnails: bool(l.autoThumbnails, d.library.autoThumbnails),
        },
        ui: {
            welcomeDismissed: bool(ui.welcomeDismissed, d.ui.welcomeDismissed),
        },
    };
}

/** Deep-merges a patch into settings (arrays and the workflow object are replaced, not merged). */
export function mergeSettings(current: Settings, patch: DeepPartial<Settings>): Settings {
    const merge = (a: unknown, b: unknown): unknown => {
        if (!isObj(a) || !isObj(b)) return b === undefined ? a : b;
        const out: Record<string, unknown> = { ...a };
        for (const [k, v] of Object.entries(b)) {
            out[k] = k === "customWorkflow" ? v : merge(a[k], v);
        }
        return out;
    };
    return sanitizeSettings(merge(current, patch));
}

/** "msy_…a1b2": enough to recognise a key without revealing it. */
export function secretPreview(value: string): string {
    const v = value.trim();
    if (!v) return "";
    if (v.length <= 8) return "•".repeat(v.length);
    return `${v.slice(0, 4)}…${v.slice(-4)}`;
}
