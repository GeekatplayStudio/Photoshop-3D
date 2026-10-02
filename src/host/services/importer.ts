/**
 * Turns a provider ModelResult into a library entry: download the model (and its
 * preview, best effort) right away — provider links are signed and expire within
 * hours (Hitem3D: 1 h, Tripo: ~24 h, Meshy: 3 days).
 */
import { sniffFormat, utf8Decode } from "@shared/bytes";
import type { LibraryItem, ModelOrigin } from "@shared/types";
import { downloadBytes, safeUrl, type FetchLike } from "../platform/http";
import type { Logger } from "../platform/logger";
import type { ModelResult } from "../providers/types";
import type { Library } from "./library";

export type ImportOptions = {
    origin: ModelOrigin;
    remoteId?: string;
    name: string;
    source?: Uint8Array;
    onProgress?: (message: string) => void;
};

export async function importModelResult(fetchFn: FetchLike, library: Library, log: Logger, result: ModelResult, opts: ImportOptions): Promise<LibraryItem> {
    opts.onProgress?.("Downloading model");
    const model = await downloadBytes(fetchFn, result.modelUrl, { headers: result.headers, label: "Model download" }, log);
    const kind = sniffFormat(model);
    if (kind === "zip") throw new Error("The service returned a ZIP archive instead of a GLB. Choose GLB output for this service.");
    if (kind === "gltf" && /"uri"\s*:\s*"(?!data:)/.test(utf8Decode(model.subarray(0, Math.min(model.length, 2_000_000))))) {
        throw new Error("This .gltf references external files, which cannot be stored on their own. Use GLB output instead.");
    }

    let thumbnail: Uint8Array | undefined;
    if (result.thumbnailUrl) {
        opts.onProgress?.("Downloading preview");
        try {
            thumbnail = await downloadBytes(fetchFn, result.thumbnailUrl, { label: "Preview download", timeoutMs: 60_000, maxBytes: 20 * 1024 * 1024 }, log);
        } catch (err) {
            // The preview is a convenience; the WebView renders one from the model instead.
            log.warn(`Preview ${safeUrl(result.thumbnailUrl)} could not be downloaded`, (err as Error).message);
        }
    }

    opts.onProgress?.("Saving to library");
    return library.add({
        name: opts.name || result.name || "3D model",
        origin: opts.origin,
        remoteId: opts.remoteId,
        model,
        thumbnail,
        source: opts.source,
        createdAt: result.createdAt,
        meta: result.meta,
    });
}
