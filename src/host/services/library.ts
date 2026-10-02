/**
 * The local model library: <data folder>/library/.
 *
 *   library/index.json            list of LibraryItem (the source of truth)
 *   library/<id>/model.glb        the model, exactly as downloaded
 *   library/<id>/thumb.png|jpg|webp  preview image (provider render or rendered locally)
 *   library/<id>/source.png       the layer pixels that generated it (when made here)
 *   library/<id>/info.json        human-readable copy of the item + provider metadata
 *
 * Models are downloaded once and then opened from disk, so re-posing a layer never
 * waits on the network and keeps working after a provider's links expire. The folder
 * sits next to the WebView UI copy, so the editor loads models with a relative URL.
 */
import { newId, slug, sniffFormat } from "@shared/bytes";
import type { LibraryItem, ModelOrigin } from "@shared/types";
import { joinPath, readJson, writeJson, type FileStore } from "../platform/fileStore";
import type { Logger } from "../platform/logger";

export const LIBRARY_DIR = "library";
const INDEX = `${LIBRARY_DIR}/index.json`;

type IndexFile = { version: 1; items: LibraryItem[] };

export type AddModelInput = {
    name: string;
    origin: ModelOrigin;
    remoteId?: string;
    model: Uint8Array;
    thumbnail?: Uint8Array;
    source?: Uint8Array;
    createdAt?: number;
    meta?: Record<string, unknown>;
};

const THUMB_EXT: Record<string, string> = { png: "png", jpg: "jpg", webp: "webp" };

export class Library {
    private items: LibraryItem[] = [];
    private listeners = new Set<(items: LibraryItem[]) => void>();
    private queue: Promise<unknown> = Promise.resolve();

    constructor(
        private readonly store: FileStore,
        private readonly log: Logger,
        private readonly now: () => number = Date.now,
    ) {}

    async load(): Promise<void> {
        const index = await readJson<IndexFile>(this.store, INDEX);
        this.items = Array.isArray(index?.items) ? index!.items.filter((i) => i && typeof i.id === "string" && typeof i.modelFile === "string") : [];
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
        await writeJson(this.store, INDEX, { version: 1, items: this.items } satisfies IndexFile);
        const snapshot = this.list();
        for (const fn of this.listeners) fn(snapshot);
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
        return this.serial(async () => {
            const item = this.items.find((i) => i.id === id);
            if (!item) return;
            await this.store.remove(this.path(item.id));
            this.items = this.items.filter((i) => i.id !== id);
            await this.persist();
            this.log.info(`Library: removed ${item.name} (${id})`);
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
