/**
 * Importing 3D files from disk into the library.
 *
 * - GLB (and a .gltf with everything inline) is stored as it is.
 * - Every other format (FBX, OBJ, DAE, USDZ, STL, PLY, 3MF, 3DS, …) is converted to GLB by
 *   the panel's WebView (three.js loaders + GLTFExporter): the host returns an ImportSource
 *   with the file's URL and the material/texture files found next to it; the panel converts
 *   and calls addConverted (or importFailed).
 * - The library's Import folder (library/Import) is an inbox: model files copied there in
 *   the file manager are imported when the Library tab is open. A ledger (import-ledger.json)
 *   remembers what was imported, so files are not imported twice and are never moved or
 *   deleted.
 * - Folders: picked files go to the folder the user is looking at. An imported folder becomes a
 *   library folder of the same name, with its subfolders, and so do subfolders of the Import folder.
 *
 * The host only reads files that belong to an import it started (`sessions`).
 */
import { newId, utf8Decode } from "@shared/bytes";
import { baseName, extOf, isModelFile, isResourceFile, isSelfContainedGltf, stripExt, type ImportBatch, type ImportSource } from "@shared/modelFormats";
import { joinFolder, normalizeFolder, parentFolder } from "@shared/libraryFolders";
import type { LibraryItem } from "@shared/types";
import { readJson, writeJson, type FileStore } from "../platform/fileStore";
import type { Logger } from "../platform/logger";
import type { Library } from "./library";

export const IMPORT_DIR = "library/Import";
const LEDGER = "import-ledger.json";
const MAX_MODELS_PER_FOLDER = 500;
const MAX_RESOURCES = 1500;
const MAX_ENTRIES_VISITED = 20_000;
const FOLDER_DEPTH = 4;
const RESOURCE_DEPTH = 3;

export type FsEntry = { name: string; isFolder: boolean; size?: number; modified?: number };

/** Native-path file access (UXP fullAccess in Photoshop, memory in tests). */
export type ImportFs = {
    /** Entries of a folder; size/modified only when `withMeta` (one extra call per file in UXP). */
    list(folder: string, withMeta?: boolean): Promise<FsEntry[]>;
    readBytes(path: string): Promise<Uint8Array>;
    /** URL the WebView can read the file from. */
    fileUrl(path: string): string;
    sep: string;
};

type Session = { path: string; allowed: Set<string>; folder: string; inboxKey?: string; inboxStamp?: string };
type LedgerEntry = { stamp: string; libraryId?: string; error?: string; at: number };
type LedgerFile = { version: 1; files: Record<string, LedgerEntry> };

const README = `Copy 3D model files into this folder (or into folders inside it) and they are added to the
Geekatplay 3D Layers library automatically while the Library tab is open.

Formats: GLB, glTF, FBX, OBJ (with its .mtl and textures), DAE, USDZ/USD, 3DS, STL, PLY, 3MF, AMF, VRML, VOX.
Keep textures next to the model (or in a subfolder); they are packed into the library's GLB.

Files here are never moved or deleted. Each file is imported once; to import it again, rename it.
`;

export class ModelImporter {
    private sessions = new Map<string, Session>();
    private scanning: Promise<ImportBatch> | null = null;

    constructor(
        private readonly deps: {
            fs: ImportFs;
            library: Library;
            store: FileStore;
            log: Logger;
            /** Native path of library/Import. */
            inboxPath: string;
            now?: () => number;
        },
    ) {}

    private now() {
        return this.deps.now?.() ?? Date.now();
    }

    private join(dir: string, name: string) {
        return `${dir.replace(/[\\/]+$/, "")}${this.deps.fs.sep}${name}`;
    }

    private dirOf(path: string) {
        const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
        return i > 0 ? path.slice(0, i) : path;
    }

    /** Imports picked files into a library folder ("" = top level). */
    async importFiles(paths: string[], into = ""): Promise<ImportBatch> {
        return this.importPlaced(paths.map((path) => ({ path, folder: normalizeFolder(into) })));
    }

    private async importPlaced(files: { path: string; folder: string }[]): Promise<ImportBatch> {
        const batch: ImportBatch = { imported: [], toConvert: [], failed: [] };
        const paths = files.map((f) => f.path);
        for (const { path, folder } of files) await this.importOne(path, batch, folder);
        this.deps.log.info(`Import: ${batch.imported.length} stored, ${batch.toConvert.length} to convert, ${batch.failed.length} failed`, paths);
        return batch;
    }

    /**
     * Imports every model file in a folder and its subfolders. The folder becomes a library
     * folder of the same name inside `into`, with the same subfolders.
     */
    async importFolder(folder: string, into = ""): Promise<ImportBatch> {
        const models = (await this.walk(folder, FOLDER_DEPTH)).filter((f) => isModelFile(f.path)).slice(0, MAX_MODELS_PER_FOLDER);
        if (!models.length) return { imported: [], toConvert: [], failed: [{ name: folder, error: "No 3D model files were found in this folder." }] };
        const target = joinFolder(normalizeFolder(into), baseName(folder.replace(/[\\/]+$/, "")));
        return this.importPlaced(models.map((m) => ({ path: m.path, folder: joinFolder(target, parentFolder(m.relative)) })));
    }

    /** Imports new or changed model files from the Import folder. */
    scanInbox(): Promise<ImportBatch> {
        // One scan at a time: the panel asks again every few seconds.
        this.scanning ??= this.doScanInbox().finally(() => (this.scanning = null));
        return this.scanning;
    }

    private async doScanInbox(): Promise<ImportBatch> {
        const batch: ImportBatch = { imported: [], toConvert: [], failed: [] };
        if (!(await this.deps.store.exists(`${IMPORT_DIR}/README.txt`))) await this.deps.store.writeText(`${IMPORT_DIR}/README.txt`, README);
        const ledger = (await readJson<LedgerFile>(this.deps.store, LEDGER)) ?? { version: 1, files: {} };
        const pending = new Set([...this.sessions.values()].map((s) => s.inboxKey).filter(Boolean));
        const files = (await this.walk(this.deps.inboxPath, FOLDER_DEPTH, true)).filter((f) => isModelFile(f.path));
        let changed = false;
        for (const file of files) {
            const key = file.relative.toLowerCase();
            const stamp = `${file.size ?? "?"}:${file.modified ?? "?"}`;
            if (pending.has(key) || ledger.files[key]?.stamp === stamp) continue;
            const before = batch.toConvert.length;
            // A subfolder of the Import folder becomes a library folder.
            const item = await this.importOne(file.path, batch, normalizeFolder(parentFolder(file.relative)));
            if (batch.toConvert.length > before) {
                const source = batch.toConvert[batch.toConvert.length - 1];
                Object.assign(this.sessions.get(source.id)!, { inboxKey: key, inboxStamp: stamp });
            } else {
                ledger.files[key] = { stamp, libraryId: item?.id, error: item ? undefined : batch.failed[batch.failed.length - 1]?.error, at: this.now() };
                changed = true;
            }
        }
        if (changed) await writeJson(this.deps.store, LEDGER, ledger);
        if (batch.imported.length || batch.toConvert.length || batch.failed.length) this.deps.log.info(`Import folder: ${batch.imported.length} stored, ${batch.toConvert.length} to convert, ${batch.failed.length} failed`);
        return batch;
    }

    private async importOne(path: string, batch: ImportBatch, folder: string): Promise<LibraryItem | undefined> {
        const name = stripExt(path);
        const ext = extOf(path);
        try {
            if (!isModelFile(path)) throw new Error("not a supported 3D file");
            if (ext === "glb") {
                const item = await this.deps.library.add({ name, origin: "local", model: await this.deps.fs.readBytes(path), folder, meta: { importedFrom: path, sourceFormat: ext } });
                batch.imported.push(item);
                return item;
            }
            if (ext === "gltf") {
                const bytes = await this.deps.fs.readBytes(path);
                let json: unknown;
                try {
                    json = JSON.parse(utf8Decode(bytes));
                } catch {
                    throw new Error("this .gltf file is not valid JSON");
                }
                if (isSelfContainedGltf(json)) {
                    const item = await this.deps.library.add({ name, origin: "local", model: bytes, folder, meta: { importedFrom: path, sourceFormat: ext } });
                    batch.imported.push(item);
                    return item;
                }
            }
            const resources = await this.resourcesNear(path);
            const id = newId("imp");
            this.sessions.set(id, { path, folder, allowed: new Set([path, ...resources.map((r) => r.path)]) });
            const source: ImportSource = { id, name, ext, url: this.deps.fs.fileUrl(path), path, resources };
            batch.toConvert.push(source);
        } catch (err) {
            const error = (err as Error).message;
            this.deps.log.warn(`Import of ${path} failed`, error);
            batch.failed.push({ name: `${name}.${ext}`, error });
        }
        return undefined;
    }

    /** Material, texture and buffer files in the model's folder and its subfolders. */
    private async resourcesNear(path: string): Promise<ImportSource["resources"]> {
        const dir = this.dirOf(path);
        const files = await this.walk(dir, RESOURCE_DEPTH);
        return files
            .filter((f) => isResourceFile(f.path))
            .slice(0, MAX_RESOURCES)
            .map((f) => ({ name: f.relative, url: this.deps.fs.fileUrl(f.path), path: f.path }));
    }

    /** Files under a folder, breadth first, up to `depth` levels of subfolders. */
    private async walk(root: string, depth: number, withMeta = false): Promise<{ path: string; relative: string; size?: number; modified?: number }[]> {
        const out: { path: string; relative: string; size?: number; modified?: number }[] = [];
        let visited = 0;
        let level: { dir: string; rel: string }[] = [{ dir: root, rel: "" }];
        for (let d = 0; d <= depth && level.length; d++) {
            const next: typeof level = [];
            for (const { dir, rel } of level) {
                let entries: FsEntry[];
                try {
                    entries = await this.deps.fs.list(dir, withMeta);
                } catch (err) {
                    if (d === 0) throw err;
                    continue;
                }
                for (const e of entries) {
                    if (++visited > MAX_ENTRIES_VISITED) return out;
                    if (e.name.startsWith(".")) continue;
                    const relative = rel ? `${rel}/${e.name}` : e.name;
                    if (e.isFolder) next.push({ dir: this.join(dir, e.name), rel: relative });
                    else out.push({ path: this.join(dir, e.name), relative, size: e.size, modified: e.modified });
                }
            }
            level = next;
        }
        return out;
    }

    /** Bytes of a file that belongs to an import (the panel's fallback when it cannot read the file itself). */
    async readFile(id: string, path: string): Promise<Uint8Array> {
        const session = this.sessions.get(id);
        if (!session?.allowed.has(path)) throw new Error("That file is not part of this import.");
        return this.deps.fs.readBytes(path);
    }

    async addConverted(id: string, name: string, glb: Uint8Array, sourceFormat: string, notes?: string[]): Promise<LibraryItem> {
        const session = this.sessions.get(id);
        if (!session) throw new Error("This import is no longer active. Import the file again.");
        const item = await this.deps.library.add({
            name: name.trim() || stripExt(session.path),
            origin: "local",
            model: glb,
            folder: session.folder,
            meta: { importedFrom: session.path, sourceFormat, convertedToGlb: true, ...(notes?.length ? { notes } : {}) },
        });
        this.sessions.delete(id);
        await this.settleInbox(session, { libraryId: item.id });
        this.deps.log.info(`Imported ${session.path} (${sourceFormat} → GLB, ${glb.byteLength} bytes) as ${item.id}`);
        return item;
    }

    async importFailed(id: string, error: string): Promise<void> {
        const session = this.sessions.get(id);
        if (!session) return;
        this.sessions.delete(id);
        this.deps.log.warn(`Import of ${session.path} failed`, error);
        await this.settleInbox(session, { error });
    }

    private async settleInbox(session: Session, result: { libraryId?: string; error?: string }) {
        if (!session.inboxKey) return;
        const ledger = (await readJson<LedgerFile>(this.deps.store, LEDGER)) ?? { version: 1, files: {} };
        ledger.files[session.inboxKey] = { stamp: session.inboxStamp ?? "", ...result, at: this.now() };
        await writeJson(this.deps.store, LEDGER, ledger);
    }
}
