/**
 * Browse: the user's models on each service. Importing downloads the model (and its
 * preview) into the local library, where it stays even after the service's links expire.
 */
import { useCallback, useEffect, useState } from "react";
import { CloudDownload, Info, Loader2, Play, RefreshCw, Search } from "lucide-react";
import { PROVIDER_LABELS, type ProviderId, type RemoteItem } from "@shared/types";
import { bridge } from "../bridge/client";
import { Badge, Button, Empty, PasteButton, Section, Select, TextInput, timeAgo } from "../components/ui";
import { usePanel } from "./store";

const PAGE_SIZE = 24;

function statusTone(s: RemoteItem["status"]) {
    return s === "succeeded" ? "success" : s === "failed" || s === "expired" ? "danger" : s === "running" || s === "queued" ? "info" : "neutral";
}

function RemoteCard({ item, onImported }: { item: RemoteItem; onImported: (id: string) => void }) {
    const { run } = usePanel();
    const [busy, setBusy] = useState(false);
    const [imgFailed, setImgFailed] = useState(false);
    const importIt = async () => {
        setBusy(true);
        const lib = await run(() => bridge().call("remote.import", { providerId: item.providerId, remoteId: item.remoteId, name: item.name }), `Imported "${item.name}"`);
        setBusy(false);
        if (lib) onImported(lib.id);
    };
    return (
        <div className="rounded-md overflow-hidden border border-border bg-card flex flex-col" data-testid="remote-card">
            <div className="aspect-square bg-background flex items-center justify-center relative">
                {item.thumbnailUrl && !imgFailed ? (
                    <img src={item.thumbnailUrl} alt={item.name} className="w-full h-full object-contain" loading="lazy" referrerPolicy="no-referrer" onError={() => setImgFailed(true)} />
                ) : (
                    <CloudDownload size={22} className="text-muted-foreground" />
                )}
                <span className="absolute top-1 left-1">
                    <Badge tone={statusTone(item.status)}>{item.status === "running" && item.progress ? `${item.progress}%` : item.status}</Badge>
                </span>
            </div>
            <div className="p-1.5 space-y-1 flex-1 flex flex-col">
                <div className="text-[10px] truncate" title={item.name}>
                    {item.name}
                </div>
                <div className="text-[9px] text-muted-foreground truncate">
                    {timeAgo(item.createdAt)}
                    {item.kind ? ` · ${item.kind}` : ""}
                </div>
                <div className="mt-auto">
                    {item.libraryId ? (
                        <Button size="sm" className="w-full" icon={<Play size={10} />} onClick={() => void run(() => bridge().call("editor.placeModel", { libraryId: item.libraryId! }))}>
                            In library · Place
                        </Button>
                    ) : (
                        <Button size="sm" variant="primary" className="w-full" busy={busy} disabled={!item.hasModel} icon={<CloudDownload size={10} />} onClick={() => void importIt()} title={item.hasModel ? "Download into the local library" : "No downloadable model (not finished, failed or expired)"}>
                            Import
                        </Button>
                    )}
                </div>
            </div>
        </div>
    );
}

export function BrowseTab() {
    const { providers, run, toast } = usePanel();
    const browsable = providers.filter((p) => p.capabilities.browse);
    const [provider, setProvider] = useState<ProviderId>("meshy");
    const [items, setItems] = useState<RemoteItem[]>([]);
    const [page, setPage] = useState(1);
    const [hasMore, setHasMore] = useState(false);
    const [notice, setNotice] = useState<string | undefined>();
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [taskId, setTaskId] = useState("");
    const status = providers.find((p) => p.id === provider);

    const load = useCallback(
        async (p: number, replace: boolean) => {
            setLoading(true);
            setError(null);
            try {
                const res = await bridge().call("remote.list", { providerId: provider, page: p, pageSize: PAGE_SIZE });
                setItems((prev) => (replace ? res.items : [...prev, ...res.items.filter((i) => !prev.some((x) => x.remoteId === i.remoteId))]));
                setHasMore(res.hasMore);
                setNotice(res.notice);
                setPage(p);
            } catch (err) {
                setError((err as Error).message);
                if (replace) setItems([]);
            } finally {
                setLoading(false);
            }
        },
        [provider],
    );

    useEffect(() => {
        if (status?.configured) void load(1, true);
        else {
            setItems([]);
            setNotice(undefined);
        }
    }, [provider, status?.configured, load]);

    const markImported = (remoteId: string) => (libraryId: string) => setItems((list) => list.map((i) => (i.remoteId === remoteId ? { ...i, libraryId } : i)));

    return (
        <div className="p-2 space-y-2">
            <div className="flex gap-1">
                <Select value={provider} onChange={setProvider} options={browsable.map((p) => ({ value: p.id, label: p.label }))} data-testid="browse-provider" className="flex-1 min-w-0" />
                <Button size="md" icon={loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} onClick={() => void load(1, true)} disabled={loading || !status?.configured} title="Refresh" />
            </div>
            {notice && (
                <div className="flex gap-1.5 text-[10px] text-muted-foreground leading-snug">
                    <Info size={11} className="shrink-0 mt-px" />
                    {notice}
                </div>
            )}
            {!status?.configured ? (
                <Empty icon={<Search size={20} />} title={`${PROVIDER_LABELS[provider]} is not set up`}>
                    {status?.hint ?? "Add your key in Settings."}
                </Empty>
            ) : error ? (
                <Empty icon={<Info size={20} />} title="Could not load your models">
                    {error}
                </Empty>
            ) : items.length === 0 && !loading ? (
                <Empty icon={<Search size={20} />} title="Nothing here yet">
                    Models you generate with {PROVIDER_LABELS[provider]} appear here.
                </Empty>
            ) : (
                <div className="grid gap-1.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(104px, 1fr))" }}>
                    {items.map((item) => (
                        <RemoteCard key={item.remoteId} item={item} onImported={markImported(item.remoteId)} />
                    ))}
                </div>
            )}
            {hasMore && !error && (
                <Button className="w-full" busy={loading} onClick={() => void load(page + 1, false)}>
                    Load more
                </Button>
            )}

            <Section title="Track a task ID" defaultOpen={false}>
                <p className="text-[10px] text-muted-foreground leading-snug">Started a generation on the {PROVIDER_LABELS[provider]} website or another computer? Paste its task id to download the result here.</p>
                <div className="flex gap-1">
                    <TextInput value={taskId} onChange={(e) => setTaskId(e.target.value)} placeholder="task id" />
                    <PasteButton onPaste={setTaskId} />
                    <Button
                        disabled={!taskId.trim()}
                        onClick={() =>
                            void run(async () => {
                                await bridge().call("jobs.recover", { providerId: provider, remoteId: taskId.trim() });
                                setTaskId("");
                                toast("info", "Tracking the task — see the Create tab.");
                            })
                        }
                    >
                        Track
                    </Button>
                </div>
            </Section>
        </div>
    );
}
