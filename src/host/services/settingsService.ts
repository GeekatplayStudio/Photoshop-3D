/**
 * Loads, validates, saves and broadcasts settings (settings.json + secret store).
 */
import { DEFAULT_SETTINGS, SECRET_KEYS, mergeSettings, sanitizeSettings, secretPreview, type DeepPartial, type PublicSettings, type SecretKey, type Settings } from "@shared/settings";
import { readJson, writeJson, type FileStore } from "../platform/fileStore";
import type { Logger } from "../platform/logger";
import type { SecretStore } from "../platform/secrets";

export const SETTINGS_FILE = "settings.json";

export class SettingsService {
    private current: Settings = DEFAULT_SETTINGS;
    private listeners = new Set<(s: PublicSettings) => void>();

    constructor(
        private readonly store: FileStore,
        private readonly secrets: SecretStore,
        private readonly log: Logger,
    ) {}

    async load(): Promise<Settings> {
        const raw = await readJson<unknown>(this.store, SETTINGS_FILE);
        this.current = sanitizeSettings(raw ?? {});
        if (!raw) await this.save();
        return this.current;
    }

    get value(): Settings {
        return this.current;
    }

    secret(key: SecretKey): Promise<string> {
        return this.secrets.get(key);
    }

    get secretStorageKind() {
        return this.secrets.kind;
    }

    async publicSettings(): Promise<PublicSettings> {
        const secrets = {} as PublicSettings["secrets"];
        for (const key of SECRET_KEYS) {
            const v = await this.secrets.get(key);
            secrets[key] = { set: !!v, preview: secretPreview(v) };
        }
        return { ...this.current, secrets };
    }

    onChange(fn: (s: PublicSettings) => void): () => void {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    private async save() {
        await writeJson(this.store, SETTINGS_FILE, this.current);
    }

    private async emit() {
        const pub = await this.publicSettings();
        for (const fn of this.listeners) fn(pub);
        return pub;
    }

    async update(patch: DeepPartial<Settings>): Promise<PublicSettings> {
        this.current = mergeSettings(this.current, patch);
        await this.save();
        this.log.info("Settings updated", Object.keys(patch));
        return this.emit();
    }

    /** Internal updates (update-check timestamps) that should not spam the UI. */
    async updateQuietly(patch: DeepPartial<Settings>): Promise<void> {
        this.current = mergeSettings(this.current, patch);
        await this.save();
    }

    async setSecret(key: SecretKey, value: string): Promise<PublicSettings> {
        if (!SECRET_KEYS.includes(key)) throw new Error(`Unknown secret: ${key}`);
        await this.secrets.set(key, value);
        this.log.info(`Credential ${key} ${value.trim() ? "saved" : "cleared"} (${this.secrets.kind})`);
        return this.emit();
    }

    async reset(): Promise<PublicSettings> {
        this.current = sanitizeSettings({ updates: { lastCheckAt: this.current.updates.lastCheckAt } });
        await this.save();
        this.log.info("Settings reset to defaults (credentials kept)");
        return this.emit();
    }
}
