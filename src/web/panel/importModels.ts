/**
 * Runs an import batch from the host: models stored as they were are already in the library;
 * the others are converted here (src/web/three/convert.ts) one at a time and handed back.
 * Imports never overlap: a manual import waits for an Import-folder scan and vice versa.
 */
import { base64ToBytes, bytesToBase64 } from "@shared/bytes";
import type { ImportBatch, ImportSource } from "@shared/modelFormats";
import { bridge } from "../bridge/client";

export type ImportReport = { added: number; failed: { name: string; error: string }[]; notes: string[] };

let queue: Promise<unknown> = Promise.resolve();

/** Serialises imports (manual and Import-folder). */
export function enqueueImport<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
}

/** Reads an import's file: directly when the WebView may, otherwise through the host. */
async function readImportBytes(id: string, url: string, path: string): Promise<Uint8Array> {
    try {
        const res = await fetch(url);
        if (res.ok) return new Uint8Array(await res.arrayBuffer());
    } catch {
        // file:// not readable here; ask the host
    }
    const { base64 } = await bridge().call("library.readImportFile", { id, path });
    return base64ToBytes(base64);
}

async function convertOne(source: ImportSource, onStatus: (message: string) => void): Promise<string[]> {
    // The loaders are large; they load the first time something is converted.
    const { convertToGlb } = await import("../three/convert");
    const result = await convertToGlb(source, (url, path) => readImportBytes(source.id, url, path), onStatus);
    onStatus(`Adding ${source.name} to the library`);
    await bridge().call("library.addConverted", { id: source.id, name: source.name, glbBase64: bytesToBase64(result.glb), sourceFormat: source.ext, notes: result.notes });
    return result.notes;
}

export async function processImportBatch(batch: ImportBatch, onStatus: (message: string | null) => void): Promise<ImportReport> {
    const report: ImportReport = { added: batch.imported.length, failed: [...batch.failed], notes: [] };
    const total = batch.toConvert.length;
    for (const [i, source] of batch.toConvert.entries()) {
        const label = `${source.name}.${source.ext}`;
        try {
            const notes = await convertOne(source, (m) => onStatus(total > 1 ? `${m} (${i + 1} of ${total})` : m));
            report.added++;
            if (notes.length) report.notes.push(`${label}: ${notes.join("; ")}`);
        } catch (err) {
            const error = (err as Error).message || String(err);
            report.failed.push({ name: label, error });
            void bridge()
                .call("library.importFailed", { id: source.id, error })
                .catch(() => undefined);
        }
    }
    onStatus(null);
    return report;
}

/** One line for a toast. */
export function describeReport(report: ImportReport): { kind: "success" | "error" | "info"; message: string } | null {
    const { added, failed, notes } = report;
    if (!added && !failed.length) return null;
    const parts: string[] = [];
    if (added) parts.push(`Added ${added} model${added === 1 ? "" : "s"} to the library.`);
    if (failed.length) parts.push(`Could not import ${failed.map((f) => `${f.name} (${f.error})`).join(", ")}.`);
    if (notes.length) parts.push(notes.join(" "));
    return { kind: failed.length && !added ? "error" : failed.length || notes.length ? "info" : "success", message: parts.join(" ") };
}
