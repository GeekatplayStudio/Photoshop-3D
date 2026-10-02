/**
import { utf8Decode, utf8Encode } from "@shared/bytes";
 * File access for the host, behind a small interface.
 *
 * Paths are "/"-separated and relative to a root folder (the plugin data folder in
 * production). The UXP implementation uses the storage.localFileSystem Entry API,
 * which was verified in Photoshop 27; tests use MemoryFileStore.
 */
import { utf8Decode, utf8Encode } from "@shared/bytes";

export type DirEntry = { name: string; isFolder: boolean };

export interface FileStore {
    /** Native path of the root, for display and "Show in folder". */
    readonly rootPath: string;
    readText(path: string): Promise<string | null>;
    writeText(path: string, text: string): Promise<void>;
    readBytes(path: string): Promise<Uint8Array | null>;
    writeBytes(path: string, bytes: Uint8Array): Promise<void>;
    exists(path: string): Promise<boolean>;
    /** Deletes a file or a folder with its contents. Missing paths are ignored. */
    remove(path: string): Promise<void>;
    list(path: string): Promise<DirEntry[]>;
    nativePath(path: string): string;
    /** batchPlay `_path` token for a file (UXP only). */
    sessionToken?(path: string): Promise<string>;
}

export const splitPath = (path: string) => path.split("/").filter((p) => p && p !== ".");

/** Joins path segments with "/" and refuses to climb out of the root. */
export function joinPath(...parts: string[]): string {
    const segs = parts.flatMap(splitPath);
    if (segs.includes("..")) throw new Error(`Invalid path: ${parts.join("/")}`);
    return segs.join("/");
}

/** Reads JSON, falling back to the last good copy written by writeJson. */
export async function readJson<T>(store: FileStore, path: string): Promise<T | null> {
    for (const candidate of [path, `${path}.tmp`]) {
        const text = await store.readText(candidate);
        if (text == null) continue;
        try {
            return JSON.parse(text) as T;
        } catch {
            // corrupt (interrupted write); try the next copy
        }
    }
    return null;
}

/** Writes JSON via a temporary copy so a crash mid-write never loses the file. */
export async function writeJson(store: FileStore, path: string, value: unknown): Promise<void> {
    const text = JSON.stringify(value, null, 2);
    await store.writeText(`${path}.tmp`, text);
    await store.writeText(path, text);
}

/* ------------------------------------------------------------------ memory */

export class MemoryFileStore implements FileStore {
    readonly rootPath = "/memory";
    readonly files = new Map<string, Uint8Array>();

    private key(path: string) {
        return joinPath(path);
    }
    async readText(path: string) {
        const b = this.files.get(this.key(path));
        return b ? utf8Decode(b) : null;
    }
    async writeText(path: string, text: string) {
        this.files.set(this.key(path), utf8Encode(text));
    }
    async readBytes(path: string) {
        const b = this.files.get(this.key(path));
        return b ? b.slice() : null;
    }
    async writeBytes(path: string, bytes: Uint8Array) {
        this.files.set(this.key(path), bytes.slice());
    }
    async exists(path: string) {
        const k = this.key(path);
        return this.files.has(k) || [...this.files.keys()].some((f) => f.startsWith(`${k}/`));
    }
    async remove(path: string) {
        const k = this.key(path);
        for (const f of [...this.files.keys()]) if (f === k || f.startsWith(`${k}/`)) this.files.delete(f);
    }
    async list(path: string) {
        const k = this.key(path);
        const prefix = k ? `${k}/` : "";
        const seen = new Map<string, boolean>();
        for (const f of this.files.keys()) {
            if (!f.startsWith(prefix)) continue;
            const rest = f.slice(prefix.length).split("/");
            seen.set(rest[0], seen.get(rest[0]) || rest.length > 1);
        }
        return [...seen].map(([name, isFolder]) => ({ name, isFolder }));
    }
    nativePath(path: string) {
        return `${this.rootPath}/${this.key(path)}`;
    }
}

/* --------------------------------------------------------------------- UXP */

type Formats = { binary: unknown; utf8: unknown };

/** FileStore over a UXP folder entry. */
export class UxpFileStore implements FileStore {
    readonly rootPath: string;

    constructor(
        private readonly root: UxpFolder,
        private readonly formats: Formats,
        private readonly lfs?: UxpLocalFileSystem,
    ) {
        this.rootPath = root.nativePath.replace(/[\\/]+$/, "");
    }

    private async entry(path: string): Promise<UxpEntry | null> {
        let current: UxpEntry = this.root;
        for (const seg of splitPath(joinPath(path))) {
            if (!current.isFolder) return null;
            try {
                current = await (current as UxpFolder).getEntry(seg);
            } catch {
                return null;
            }
        }
        return current;
    }

    private async folder(path: string, create: boolean): Promise<UxpFolder | null> {
        let current: UxpFolder = this.root;
        for (const seg of splitPath(joinPath(path))) {
            let next: UxpEntry | null = null;
            try {
                next = await current.getEntry(seg);
            } catch {
                next = null;
            }
            if (!next) {
                if (!create) return null;
                next = await current.createFolder(seg);
            }
            if (!next.isFolder) throw new Error(`${seg} is a file, expected a folder (${path})`);
            current = next as UxpFolder;
        }
        return current;
    }

    private async file(path: string, create: boolean): Promise<UxpFile | null> {
        const segs = splitPath(joinPath(path));
        const name = segs.pop();
        if (!name) throw new Error("Empty file path");
        const dir = await this.folder(segs.join("/"), create);
        if (!dir) return null;
        if (create) return dir.createFile(name, { overwrite: true });
        try {
            const e = await dir.getEntry(name);
            return e.isFile ? (e as UxpFile) : null;
        } catch {
            return null;
        }
    }

    async readText(path: string) {
        const f = await this.file(path, false);
        return f ? ((await f.read({ format: this.formats.utf8 })) as string) : null;
    }
    async writeText(path: string, text: string) {
        const f = await this.file(path, true);
        await f!.write(text, { format: this.formats.utf8 });
    }
    async readBytes(path: string) {
        const f = await this.file(path, false);
        return f ? new Uint8Array((await f.read({ format: this.formats.binary })) as ArrayBuffer) : null;
    }
    async writeBytes(path: string, bytes: Uint8Array) {
        const f = await this.file(path, true);
        const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? (bytes.buffer as ArrayBuffer) : (bytes.slice().buffer as ArrayBuffer);
        await f!.write(buffer, { format: this.formats.binary });
    }
    async exists(path: string) {
        return (await this.entry(path)) !== null;
    }
    async remove(path: string) {
        const e = await this.entry(path);
        if (!e || e === this.root) return;
        await this.removeEntry(e);
    }
    private async removeEntry(e: UxpEntry): Promise<void> {
        if (e.isFolder) {
            for (const child of await (e as UxpFolder).getEntries()) await this.removeEntry(child);
        }
        await e.delete();
    }
    async list(path: string) {
        const dir = await this.folder(path, false);
        if (!dir) return [];
        return (await dir.getEntries()).map((e) => ({ name: e.name, isFolder: e.isFolder }));
    }
    nativePath(path: string) {
        const sep = this.rootPath.includes("\\") ? "\\" : "/";
        return [this.rootPath, ...splitPath(joinPath(path))].join(sep);
    }
    async sessionToken(path: string) {
        if (!this.lfs) throw new Error("No localFileSystem for session tokens");
        const f = await this.file(path, false);
        if (!f) throw new Error(`File not found: ${path}`);
        return this.lfs.createSessionToken(f);
    }
}
