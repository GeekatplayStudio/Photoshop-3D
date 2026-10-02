/**
 * API keys and other credentials.
 *
 * In Photoshop they live in UXP secureStorage, which the OS encrypts per user
 * (DPAPI on Windows, Keychain on macOS); they are never written to settings.json
 * or the log. If secureStorage is unavailable (very old UXP), keys fall back to
 * secrets.json in the plugin data folder, and the Settings tab says so.
 */
import type { SecretKey } from "@shared/settings";
import { utf8Decode } from "@shared/bytes";
import type { FileStore } from "./fileStore";
import { readJson, writeJson } from "./fileStore";

export interface SecretStore {
    readonly kind: "secureStorage" | "file" | "memory";
    get(key: SecretKey): Promise<string>;
    set(key: SecretKey, value: string): Promise<void>;
}

const PREFIX = "photoshop3d.";

type SecureStorage = {
    getItem(key: string): Promise<Uint8Array | string | null | undefined>;
    setItem(key: string, value: string | Uint8Array): Promise<void>;
    removeItem(key: string): Promise<void>;
};

export class UxpSecretStore implements SecretStore {
    readonly kind = "secureStorage" as const;
    private cache = new Map<SecretKey, string>();

    constructor(private readonly secure: SecureStorage) {}

    async get(key: SecretKey): Promise<string> {
        if (this.cache.has(key)) return this.cache.get(key)!;
        let value = "";
        try {
            const raw = await this.secure.getItem(PREFIX + key);
            if (raw instanceof Uint8Array) value = utf8Decode(raw);
            else if (typeof raw === "string") value = raw;
            else if (raw && typeof raw === "object" && "byteLength" in (raw as object)) value = utf8Decode(new Uint8Array(raw as ArrayBuffer));
        } catch {
            value = "";
        }
        this.cache.set(key, value);
        return value;
    }

    async set(key: SecretKey, value: string): Promise<void> {
        const v = value.trim();
        if (v) await this.secure.setItem(PREFIX + key, v);
        else await this.secure.removeItem(PREFIX + key).catch(() => undefined);
        this.cache.set(key, v);
    }
}

export class FileSecretStore implements SecretStore {
    readonly kind = "file" as const;
    constructor(private readonly store: FileStore, private readonly path = "secrets.json") {}

    private async all(): Promise<Record<string, string>> {
        return (await readJson<Record<string, string>>(this.store, this.path)) ?? {};
    }
    async get(key: SecretKey) {
        return (await this.all())[key] ?? "";
    }
    async set(key: SecretKey, value: string) {
        const all = await this.all();
        if (value.trim()) all[key] = value.trim();
        else delete all[key];
        await writeJson(this.store, this.path, all);
    }
}

export class MemorySecretStore implements SecretStore {
    readonly kind = "memory" as const;
    readonly values = new Map<SecretKey, string>();
    constructor(initial: Partial<Record<SecretKey, string>> = {}) {
        for (const [k, v] of Object.entries(initial)) this.values.set(k as SecretKey, v as string);
    }
    async get(key: SecretKey) {
        return this.values.get(key) ?? "";
    }
    async set(key: SecretKey, value: string) {
        this.values.set(key, value.trim());
    }
}
