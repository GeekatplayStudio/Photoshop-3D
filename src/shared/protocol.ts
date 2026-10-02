/**
 * The bridge between the WebView UI and the UXP host.
 *
 * UXP gives a WebView exactly one channel: `webview.postMessage(obj)` towards the
 * page and `window.uxpHost.postMessage(obj)` back, with JSON-serialised payloads.
 * On top of that this file defines a tiny request/response protocol:
 *
 *   page → host   { t: "req", id, method, params }
 *   host → page   { t: "res", id, ok: true, result } | { t: "res", id, ok: false, error }
 *   host → page   { t: "evt", name, data }            (push notifications)
 *
 * `HostApi` lists every method with its params and result types; both sides are
 * type-checked against it. Binary data (renders, thumbnails) travels as base64
 * strings — measured at ~50 MB/s through the bridge, far below any real cost.
 */
import type {
    AppInfo,
    Job,
    LayerState,
    LibraryItem,
    PlaceResult,
    ProviderId,
    ProviderStatus,
    ProviderTestResult,
    PsContext,
    RemotePage,
    SendSource,
    UpdateInfo,
} from "./types";
import type { DeepPartial, PublicSettings, SecretKey, Settings } from "./settings";
import type { LightingDefaults, ThreeDSettings } from "./threeD";

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Data the 3D editor page needs to start. */
export type EditorInit = {
    mode: "new" | "update";
    model: {
        libraryId: string;
        name: string;
        /** URL the editor can load directly, or null when it must call `library.readFile`. */
        url: string | null;
        file: string;
        sizeBytes: number;
    };
    settings: ThreeDSettings;
    lighting: LightingDefaults;
    rememberLighting: boolean;
    /** Size of the target document, used to suggest an export resolution. */
    document?: { title: string; width: number; height: number };
};

/** What the editor sends back when the user clicks OK. */
export type EditorResult = {
    pngBase64: string;
    width: number;
    height: number;
    settings: ThreeDSettings;
    /** Bounding box of non-transparent pixels in the render (for fitting to a source area). */
    contentBounds?: { left: number; top: number; right: number; bottom: number };
};

export type HostApi = {
    "app.info": [void, AppInfo];

    "settings.get": [void, PublicSettings];
    "settings.update": [DeepPartial<Settings>, PublicSettings];
    "settings.setSecret": [{ key: SecretKey; value: string }, PublicSettings];
    "settings.reset": [void, PublicSettings];
    "settings.pickWorkflow": [void, PublicSettings | null];

    "providers.status": [void, ProviderStatus[]];
    "providers.test": [{ providerId: ProviderId }, ProviderTestResult];

    "ps.context": [void, PsContext];
    "ps.sourcePreview": [{ source: SendSource }, { dataUrl: string; width: number; height: number; label: string } | null];

    "generate.start": [{ providerId: ProviderId; source: SendSource; name?: string }, Job];

    "jobs.list": [void, Job[]];
    "jobs.cancel": [{ id: string }, Job];
    "jobs.retry": [{ id: string }, Job];
    "jobs.dismiss": [{ id: string }, void];
    "jobs.recover": [{ providerId: ProviderId; remoteId: string; name?: string }, Job];

    "remote.list": [{ providerId: ProviderId; page: number; pageSize: number }, RemotePage];
    "remote.import": [{ providerId: ProviderId; remoteId: string; name?: string }, LibraryItem];

    "library.list": [void, LibraryItem[]];
    "library.update": [{ id: string; name?: string; favorite?: boolean }, LibraryItem];
    "library.remove": [{ id: string }, void];
    "library.importFile": [void, LibraryItem | null];
    "library.saveThumbnail": [{ id: string; pngBase64: string }, LibraryItem];
    "library.readFile": [{ file: string }, { base64: string }];
    "library.revealFolder": [void, void];

    /** Opens the modal 3D editor for a library model and places the result in the active document. */
    "editor.placeModel": [{ libraryId: string; atSource?: string }, PlaceResult | null];
    /** Opens the modal 3D editor for the active 3D layer and updates it on OK. */
    "editor.editActiveLayer": [void, PlaceResult | null];
    "layer.state": [void, LayerState | null];
    "layer.detach3D": [void, void];

    /* --- only called by the editor page inside the modal dialog --- */
    "editor.getInit": [void, EditorInit];
    "editor.complete": [EditorResult, void];
    "editor.cancel": [void, void];
    "editor.rememberLighting": [LightingDefaults, void];

    "update.check": [{ force?: boolean }, UpdateInfo];
    "update.install": [void, { started: boolean; message: string }];
    "update.skip": [{ version: string }, void];

    "shell.openExternal": [{ url: string }, void];
    "log.write": [{ level: LogLevel; message: string; data?: unknown }, void];
    "log.tail": [{ lines: number }, string];
    "log.reveal": [void, void];
};

export type HostMethod = keyof HostApi;
export type ParamsOf<M extends HostMethod> = HostApi[M][0];
export type ResultOf<M extends HostMethod> = HostApi[M][1];

/** Push notifications from the host. */
export type HostEvents = {
    "jobs.changed": Job[];
    "library.changed": LibraryItem[];
    "ps.context": PsContext;
    "settings.changed": PublicSettings;
    "update.available": UpdateInfo;
    "theme.changed": { theme: string };
    "toast": { kind: "info" | "success" | "error"; message: string };
};
export type HostEventName = keyof HostEvents;

export type RequestMessage = { t: "req"; id: number; method: HostMethod; params: unknown };
export type ResponseMessage =
    | { t: "res"; id: number; ok: true; result: unknown }
    | { t: "res"; id: number; ok: false; error: { message: string; code?: string } };
export type EventMessage = { t: "evt"; name: HostEventName; data: unknown };
export type BridgeMessage = RequestMessage | ResponseMessage | EventMessage;

export function isBridgeMessage(value: unknown): value is BridgeMessage {
    if (!value || typeof value !== "object") return false;
    const t = (value as { t?: unknown }).t;
    return t === "req" || t === "res" || t === "evt";
}
