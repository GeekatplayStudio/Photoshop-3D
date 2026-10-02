/**
 * API keys and other credentials.
 *
 * They are kept in credentials.json in the shared user-data folder
 * (%APPDATA%\Geekatplay\3D Layers on Windows, ~/Library/Application Support/Geekatplay/3D Layers
 * on macOS): readable only by your OS user account, never written to settings.json, never
 * logged (see logger.ts redact), and kept across plugin updates — the same approach as the
 * GitHub and AWS command-line tools.
 *
 * Why not UXP secureStorage: it lives inside the plugin's UXP storage folder, which Adobe's
 * installer deletes whenever an installed copy is removed (verified with UPIA 8.5: the store
 * came back empty after an update), so every update would lose the keys. Keys found there
 * are migrated once (see migrateSecrets).
 */
import type { SecretKey } from "@shared/settings";
import { SECRET_KEYS } from "@shared/settings";
import { utf8Decode } from "@shared/bytes";
import type { FileStore } from "./fileStore";

export interface SecretStore {
    readonly kind: "file" | "secureStorage" | "memory";
    get(key: SecretKey): Promise<string>;
    set(key: SecretKey, value: string): Promise<void>;
}

export const CREDENTIALS_FILE = "credentials.json";

type CredentialsFile = { _note: string; keys: Partial<Record<SecretKey, string>> };

const NOTE = "API keys for Geekatplay 3D Layers. Keep this file private; delete a key here or in the plugin's Settings tab.";

export class FileSecretStore implements SecretStore {
    readonly kind = "file" as const;
    private cache: Partial<Record<SecretKey, string>> | null = null;

    constructor(
        private readonly store: FileStore,
        private readonly path = CREDENTIALS_FILE,
    ) {}

    private async all(): Promise<Partial<Record<SecretKey, string>>> {
        if (this.cache) return this.cache;
        const text = await this.store.readText(this.path);
        let keys: Partial<Record<SecretKey, string>> = {};
        if (text) {
            try {
                const parsed = JSON.parse(text) as Partial<CredentialsFile>;
                keys = parsed.keys && typeof parsed.keys === "object" ? parsed.keys : {};
            } catch {
                keys = {};
            }
        }
        this.cache = keys;
        return keys;
    }

    async get(key: SecretKey) {
        return (await this.all())[key] ?? "";
    }

    async set(key: SecretKey, value: string) {
        const all = { ...(await this.all()) };
        if (value.trim()) all[key] = value.trim();
        else delete all[key];
        // Written directly (no .tmp copy) so there is exactly one file holding keys.
        await this.store.writeText(this.path, JSON.stringify({ _note: NOTE, keys: all } satisfies CredentialsFile, null, 2));
        this.cache = all;
    }
}

type SecureStorage = {
    getItem(key: string): Promise<Uint8Array | string | null | undefined>;
    removeItem(key: string): Promise<void>;
};

/** Moves keys from UXP secureStorage (used by early builds) into the credentials file. */
export async function migrateSecrets(secure: SecureStorage | undefined, target: SecretStore): Promise<number> {
    if (!secure) return 0;
    let moved = 0;
    for (const key of SECRET_KEYS) {
        try {
            const raw = await secure.getItem(`photoshop3d.${key}`);
            const value = raw instanceof Uint8Array ? utf8Decode(raw) : typeof raw === "string" ? raw : "";
            if (value.trim() && !(await target.get(key))) {
                await target.set(key, value);
                moved++;
            }
            if (value) await secure.removeItem(`photoshop3d.${key}`).catch(() => undefined);
        } catch {
            // secureStorage unavailable or empty: nothing to migrate
        }
    }
    return moved;
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
