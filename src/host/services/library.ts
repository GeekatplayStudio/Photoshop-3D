/**
 * The local model library: <data folder>/library/.
 *
 *   library/index.json            list of LibraryItem (the source of truth)
 *   library/<id>/model.glb        the model, exactly as downloaded
 *   library/<id>/thumb.png|jpg|webp  preview image (provider render or rendered locally)
 *   library/<id>/source.png       the layer pixels that generated it (when made here)
 *   library/<id>/info.json        human-readable copy of the item + provider metadata
 *
 * Folders are virtual (shared/libraryFolders.ts): each item has a `folder` path and the index
 * keeps the folder list, so empty folders exist too. Moving models between folders only
 * changes the index.
 *
 * Models are downloaded once and then opened from disk, so re-posing a layer never
 * waits on the network and keeps working after a provider's links expire. The folder
 * sits next to the WebView UI copy, so the editor loads models with a relative URL.
 */
import { newId, slug, sniffFormat } from "@shared/bytes";
import { allFolders, cleanFolderName, joinFolder, normalizeFolder, parentFolder, relocateFolder, withAncestors } from "@shared/libraryFolders";
import type { LibraryItem, ModelOrigin } from "@shared/types";
import { joinPath, readJson, writeJson, type FileStore } from "../platform/fileStore";
import type { Logger } from "../platform/logger";

export const LIBRARY_DIR = "library";
const INDEX = `${LIBRARY_DIR}/index.json`;

type IndexFile = { version: 1; items: LibraryItem[]; folders?: string[] };

export type AddModelInput = {
    name: string;
    origin: ModelOrigin;
    remoteId?: string;
    model: Uint8Array;
    thumbnail?: Uint8Array;
    source?: Uint8Array;
    createdAt?: number;
    meta?: Record<string, unknown>;
    /** Library folder to add the model to ("" = top level). */
    folder?: string;
};

const THUMB_EXT: Record<string, string> = { png: "png", jpg: "jpg", webp: "webp" };

export class Library {
    private items: LibraryItem[] = [];
    /** Folders that exist even when empty; folders of items are added on read. */
    private folderList = new Set<string>();
    private listeners = new Set<(items: LibraryItem[]) => void>();
    private folderListeners = new Set<(folders: string[]) => void>();
    private queue: Promise<unknown> = Promise.resolve();

    constructor(
        private readonly store: FileStore,
        private readonly log: Logger,
        private readonly now: () => number = Date.now,
    ) {}

    async load(): Promise<void> {
        const index = await readJson<IndexFile>(this.store, INDEX);
        this.items = Array.isArray(index?.items) ? index!.items.filter((i) => i && typeof i.id === "string" && typeof i.modelFile === "string") : [];
        for (const item of this.items) {
            const folder = normalizeFolder(item.folder);
            if (folder) item.folder = folder;
            else delete item.folder;
        }
        this.folderList = new Set((Array.isArray(index?.folders) ? index!.folders : []).map(normalizeFolder).filter(Boolean));
        // Drop entries whose model file disappeared (deleted by hand).
        const present: LibraryItem[] = [];
        for (const item of this.items) {
            if (await this.store.exists(joinPath(LIBRARY_DIR, item.modelFile))) present.push(item);
            else this.log.warn(`Library: ${item.name} (${item.id}) is missing its model file; removing it from the index`);
        }
        if (present.length !== this.items.length) {
            this.items = present;
            await this.persist();
        }
    }

    list(): LibraryItem[] {
        return [...this.items].sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite) || b.importedAt - a.importedAt);
    }

    get(id: string): LibraryItem | undefined {
        return this.items.find((i) => i.id === id);
    }

    findByRemote(origin: ModelOrigin, remoteId: string): LibraryItem | undefined {
        return this.items.find((i) => i.origin === origin && i.remoteId === remoteId);
    }

    onChange(fn: (items: LibraryItem[]) => void): () => void {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    onFoldersChange(fn: (folders: string[]) => void): () => void {
        this.folderListeners.add(fn);
        return () => this.folderListeners.delete(fn);
    }

    /** Every folder: the stored ones, the folders of models, and all their parents. Sorted. */
    folders(): string[] {
        return allFolders(this.folderList, this.items);
    }

    /** Creates a folder (and its parents). Returns the folder list. */
    async createFolder(parent: string, name: string): Promise<string[]> {
        const clean = cleanFolderName(name);
        if (!clean) throw new Error("Type a folder name.");
        const path = joinFolder(normalizeFolder(parent), clean);
        return this.serial(async () => {
            if (this.folders().some((f) => f.toLowerCase() === path.toLowerCase())) throw new Error(`There is already a folder named "${clean}" here.`);
            for (const a of withAncestors(path)) this.folderList.add(a);
            await this.persist();
            this.log.info(`Library: created folder ${path}`);
            return this.folders();
        });
    }

    /** Renames the last part of a folder path; its subfolders and models move with it. */
    async renameFolder(path: string, name: string): Promise<string[]> {
        const from = normalizeFolder(path);
        const clean = cleanFolderName(name);
        if (!from) throw new Error("The top level of the library cannot be renamed.");
        if (!clean) throw new Error("Type a folder name.");
        const to = joinFolder(parentFolder(from), clean);
        if (to === from) return this.folders();
        return this.serial(async () => {
            const taken = this.folders().some((f) => f.toLowerCase() === to.toLowerCase() && f.toLowerCase() !== from.toLowerCase());
            if (taken) throw new Error(`There is already a folder named "${clean}" here.`);
            this.folderList = relocateFolder(this.folderList, this.items, from, to);
            await this.persist();
            this.log.info(`Library: renamed folder ${from} → ${to}`);
            return this.folders();
        });
    }

    /** Deletes a folder. Its models and subfolders move to its parent; no model is deleted. */
    async deleteFolder(path: string): Promise<string[]> {
        const folder = normalizeFolder(path);
        if (!folder) throw new Error("The top level of the library cannot be deleted.");
        return this.serial(async () => {
            const parent = parentFolder(folder);
            this.folderList = relocateFolder(this.folderList, this.items, folder, parent);
            await this.persist();
            this.log.info(`Library: deleted folder ${folder}; its contents moved to ${parent || "the top level"}`);
            return this.folders();
        });
    }

    /** Moves models into a folder ("" = top level); the folder is created if needed. */
    async move(ids: string[], folder: string): Promise<void> {
        const target = normalizeFolder(folder);
        return this.serial(async () => {
            let n = 0;
            for (const item of this.items) {
                if (!ids.includes(item.id)) continue;
                if (target) item.folder = target;
                else delete item.folder;
                n++;
            }
            for (const a of withAncestors(target)) this.folderList.add(a);
            await this.persist();
            this.log.info(`Library: moved ${n} model${n === 1 ? "" : "s"} to ${target || "the top level"}`);
        });
    }

    /** Library-relative path → data-folder path. */
    path(file: string): string {
        return joinPath(LIBRARY_DIR, file);
    }

    /** Serialises index writes so concurrent jobs cannot lose entries. */
    private serial<T>(fn: () => Promise<T>): Promise<T> {
        const run = this.queue.then(fn, fn);
        this.queue = run.catch(() => undefined);
        return run;
    }

    private async persist() {
        await writeJson(this.store, INDEX, { version: 1, items: this.items, folders: [...this.folderList].sort() } satisfies IndexFile);
        const snapshot = this.list();
        for (const fn of this.listeners) fn(snapshot);
        const folders = this.folders();
        for (const fn of this.folderListeners) fn(folders);
    }

    async add(input: AddModelInput): Promise<LibraryItem> {
        const kind = sniffFormat(input.model);
        if (kind !== "glb" && kind !== "gltf") throw new Error(`The downloaded file is not a glTF/GLB model (looks like ${kind ?? "unknown data"}).`);
        return this.serial(async () => {
            const id = newId("lib");
            const dir = id;
            const modelFile = `${dir}/model.${kind}`;
            await this.store.writeBytes(this.path(modelFile), input.model);
            let thumbFile: string | undefined;
            if (input.thumbnail) {
                const t = sniffFormat(input.thumbnail);
                if (t && THUMB_EXT[t]) {
                    thumbFile = `${dir}/thumb.${THUMB_EXT[t]}`;
                    await this.store.writeBytes(this.path(thumbFile), input.thumbnail);
                }
            }
            let sourceFile: string | undefined;
            if (input.source) {
                sourceFile = `${dir}/source.png`;
                await this.store.writeBytes(this.path(sourceFile), input.source);
            }
            const now = this.now();
            const item: LibraryItem = {
                id,
                name: input.name.trim() || "3D model",
                origin: input.origin,
                remoteId: input.remoteId,
                modelFile,
                thumbFile,
                sourceFile,
                format: kind,
                sizeBytes: input.model.byteLength,
                createdAt: input.createdAt ?? now,
                importedAt: now,
                meta: input.meta,
            };
            const folder = normalizeFolder(input.folder);
            if (folder) {
                item.folder = folder;
                for (const a of withAncestors(folder)) this.folderList.add(a);
            }
            await this.store.writeText(this.path(`${dir}/info.json`), JSON.stringify(item, null, 2));
            this.items.push(item);
            await this.persist();
            this.log.info(`Library: added ${item.name} (${item.id}, ${item.origin}${item.remoteId ? ` ${item.remoteId}` : ""}, ${item.sizeBytes} bytes)`);
            return item;
        });
    }

    async update(id: string, patch: { name?: string; favorite?: boolean }): Promise<LibraryItem> {
        return this.serial(async () => {
            const item = this.items.find((i) => i.id === id);
            if (!item) throw new Error("That model is no longer in the library.");
            if (typeof patch.name === "string" && patch.name.trim()) item.name = patch.name.trim().slice(0, 120);
            if (typeof patch.favorite === "boolean") item.favorite = patch.favorite;
            await this.persist();
            return item;
        });
    }

    async setThumbnail(id: string, png: Uint8Array): Promise<LibraryItem> {
        if (sniffFormat(png) !== "png") throw new Error("Thumbnail must be a PNG.");
        return this.serial(async () => {
            const item = this.items.find((i) => i.id === id);
            if (!item) throw new Error("That model is no longer in the library.");
            if (item.thumbFile && !item.thumbFile.endsWith(".png")) await this.store.remove(this.path(item.thumbFile));
            item.thumbFile = `${item.id}/thumb.png`;
            await this.store.writeBytes(this.path(item.thumbFile), png);
            await this.persist();
            return item;
        });
    }

    async remove(id: string): Promise<void> {
        return this.removeMany([id]);
    }

    /** Deletes models and their files. Layers already placed keep their pixels. */
    async removeMany(ids: string[]): Promise<void> {
        return this.serial(async () => {
            const gone = this.items.filter((i) => ids.includes(i.id));
            if (!gone.length) return;
            for (const item of gone) {
                // Remember the folder so removing its last model does not make it disappear.
                if (item.folder) for (const a of withAncestors(item.folder)) this.folderList.add(a);
                await this.store.remove(this.path(item.id));
            }
            this.items = this.items.filter((i) => !ids.includes(i.id));
            await this.persist();
            this.log.info(`Library: removed ${gone.map((i) => `${i.name} (${i.id})`).join(", ")}`);
        });
    }

    async readFile(file: string): Promise<Uint8Array> {
        const bytes = await this.store.readBytes(this.path(file));
        if (!bytes) throw new Error(`Library file not found: ${file}`);
        return bytes;
    }

    /** Suggested file stem for exports ("wooden-chair"). */
    static stem(item: LibraryItem): string {
        return slug(item.name);
    }
}
