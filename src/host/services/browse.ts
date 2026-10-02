/**
 * Browsing the user's models on each service and importing them into the library.
 *
 * Providers with a list API (Meshy, Tripo via usage history, ComfyUI via /history)
 * answer directly. Hitem3D has none, so its page is built from the plugin's own task
 * history, refreshing each task's state (and fresh 1-hour preview links) on view.
 */
import type { ProviderId, RemoteItem, RemotePage } from "@shared/types";
import type { FetchLike } from "../platform/http";
import type { Logger } from "../platform/logger";
import type { ProviderAdapter, ProviderContext } from "../providers/types";
import type { TaskHistory } from "./history";
import { importModelResult } from "./importer";
import type { Library } from "./library";

export class BrowseService {
    constructor(
        private readonly deps: {
            library: Library;
            history: TaskHistory;
            log: Logger;
            fetch: FetchLike;
            provider: (id: ProviderId) => ProviderAdapter;
            context: () => ProviderContext;
        },
    ) {}

    async list(providerId: ProviderId, page: number, pageSize: number): Promise<RemotePage> {
        const provider = this.deps.provider(providerId);
        const ctx = this.deps.context();
        const configured = await provider.isConfigured(ctx);
        if (!configured.configured) throw new Error(configured.hint ?? `${provider.label} is not set up yet.`);
        const result = provider.list ? await provider.list(ctx, page, pageSize) : await this.fromHistory(provider, ctx, page, pageSize);
        for (const item of result.items) {
            const inLibrary = this.deps.library.findByRemote(providerId, item.remoteId);
            if (inLibrary) item.libraryId = inLibrary.id;
        }
        return result;
    }

    private async fromHistory(provider: ProviderAdapter, ctx: ProviderContext, page: number, pageSize: number): Promise<RemotePage> {
        const all = await this.deps.history.forProvider(provider.id);
        const start = (Math.max(1, page) - 1) * pageSize;
        const slice = all.slice(start, start + pageSize);
        const items: RemoteItem[] = await Promise.all(
            slice.map(async (entry) => {
                const base: RemoteItem = { providerId: provider.id, remoteId: entry.remoteId, name: entry.name, status: "unknown", createdAt: entry.createdAt, hasModel: false };
                try {
                    const res = await provider.poll(ctx, entry.remoteId, entry.meta);
                    return {
                        ...base,
                        status: res.state === "succeeded" ? "succeeded" : res.state,
                        progress: res.progress,
                        thumbnailUrl: res.result?.thumbnailUrl,
                        hasModel: res.state === "succeeded" && !!res.result,
                    };
                } catch (err) {
                    this.deps.log.warn(`Browse: ${provider.label} task ${entry.remoteId} could not be refreshed`, (err as Error).message);
                    return base;
                }
            }),
        );
        return {
            items,
            page,
            hasMore: start + pageSize < all.length,
            notice: `${provider.label} has no API to list your models, so this shows the tasks this plugin sent. Use "Track task ID" to add one started elsewhere.`,
        };
    }

    async import(providerId: ProviderId, remoteId: string, name?: string) {
        const existing = this.deps.library.findByRemote(providerId, remoteId);
        if (existing) return existing;
        const provider = this.deps.provider(providerId);
        const history = (await this.deps.history.forProvider(providerId)).find((h) => h.remoteId === remoteId);
        const result = await provider.resolve(this.deps.context(), remoteId, history?.meta);
        return importModelResult(this.deps.fetch, this.deps.library, this.deps.log, result, {
            origin: providerId,
            remoteId,
            name: name || result.name || history?.name || `${provider.label} model`,
        });
    }
}
