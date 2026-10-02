/**
 * Every task this plugin submitted, per provider (<data folder>/history.json).
 *
 * Hitem3D has no "list my tasks" API, so Browse shows this history for it; for the
 * other services it is a local audit trail of what was sent where and when.
 */
import type { ProviderId } from "@shared/types";
import { readJson, writeJson, type FileStore } from "../platform/fileStore";

export const HISTORY_FILE = "history.json";
const MAX_ENTRIES = 1000;

export type HistoryEntry = {
    providerId: ProviderId;
    remoteId: string;
    name: string;
    createdAt: number;
    meta?: Record<string, unknown>;
};

export class TaskHistory {
    private entries: HistoryEntry[] = [];
    private loaded = false;

    constructor(private readonly store: FileStore) {}

    private async ensure() {
        if (this.loaded) return;
        const data = await readJson<{ entries?: HistoryEntry[] }>(this.store, HISTORY_FILE);
        this.entries = Array.isArray(data?.entries) ? data!.entries : [];
        this.loaded = true;
    }

    async record(entry: HistoryEntry): Promise<void> {
        await this.ensure();
        this.entries = [entry, ...this.entries.filter((e) => !(e.providerId === entry.providerId && e.remoteId === entry.remoteId))].slice(0, MAX_ENTRIES);
        await writeJson(this.store, HISTORY_FILE, { entries: this.entries });
    }

    async forProvider(providerId: ProviderId): Promise<HistoryEntry[]> {
        await this.ensure();
        return this.entries.filter((e) => e.providerId === providerId).sort((a, b) => b.createdAt - a.createdAt);
    }
}
