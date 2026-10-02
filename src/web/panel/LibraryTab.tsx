/**
 * Library: every model downloaded or imported on this computer, stored in the plugin
 * data folder. Pick one to preview it in 3D and pose it into the active document.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, FolderInput, FolderOpen, Import, Loader2, Pencil, Play, RefreshCw, Search, Star, Trash2, X } from "lucide-react";
import { SUPPORTED_FORMATS_TEXT, type ImportBatch } from "@shared/modelFormats";
import { formatBytes } from "@shared/bytes";
import { PROVIDER_LABELS, type LibraryItem, type ModelOrigin } from "@shared/types";
import { bridge } from "../bridge/client";
import { ModelPreview } from "../components/ModelPreview";
import { ModelThumb } from "../components/ModelThumb";
import { Badge, Button, Empty, Select, TextInput, timeAgo } from "../components/ui";
import { renderModelThumbnail } from "../three/thumbnail";
import { modelUrl } from "../three/modelSource";
import { describeReport, enqueueImport, processImportBatch } from "./importModels";
import { usePanel } from "./store";

/** How often the Import folder is checked while the Library tab is open. */
const INBOX_SCAN_MS = 6000;

type Filter = "all" | "favorites" | ModelOrigin;

function Details({ item, onClose }: { item: LibraryItem; onClose: () => void }) {
    const { info, ps, run } = usePanel();
    const [renaming, setRenaming] = useState(false);
    const [name, setName] = useState(item.name);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const base = info?.libraryBaseUrl ?? null;

    const rerenderThumb = () =>
        run(async () => {
            const dataUrl = await renderModelThumbnail(await modelUrl(base, item.modelFile), 512);
            await bridge().call("library.saveThumbnail", { id: item.id, pngBase64: dataUrl.replace(/^data:[^,]*,/, "") });
        }, "Preview updated");

    return (
        <div className="border border-border rounded-md bg-card p-2 space-y-2" data-testid="library-details">
            <div className="flex items-center gap-1">
                {renaming ? (
                    <form
                        className="flex-1 flex gap-1"
                        onSubmit={(e) => {
                            e.preventDefault();
                            void run(() => bridge().call("library.update", { id: item.id, name })).then(() => setRenaming(false));
                        }}
                    >
                        <TextInput autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
                        <Button size="sm" type="submit">
                            Save
                        </Button>
                    </form>
                ) : (
                    <div className="flex-1 min-w-0 text-xs font-semibold truncate" title={item.name}>
                        {item.name}
                    </div>
                )}
                <Button size="sm" variant="ghost" icon={<X size={12} />} onClick={onClose} title="Close" />
            </div>
            <ModelPreview baseUrl={base} file={item.modelFile} className="w-full aspect-square" />
            <div className="flex flex-wrap gap-1 text-[10px] text-muted-foreground">
                <Badge>{PROVIDER_LABELS[item.origin]}</Badge>
                <span>{formatBytes(item.sizeBytes)}</span>
                <span>· added {timeAgo(item.importedAt)}</span>
                {item.remoteId && <span className="select-text">· task {item.remoteId.slice(0, 16)}</span>}
            </div>
            <Button variant="primary" className="w-full" icon={<Play size={13} />} disabled={!ps?.hasDocument} title={ps?.hasDocument ? undefined : "Open a document first"} onClick={() => void run(() => bridge().call("editor.placeModel", { libraryId: item.id }))} data-testid="place-model">
                Pose, light & place in document
            </Button>
            <div className="grid grid-cols-2 gap-1">
                <Button size="sm" icon={<Star size={11} className={item.favorite ? "fill-current text-warning" : ""} />} onClick={() => void run(() => bridge().call("library.update", { id: item.id, favorite: !item.favorite }))}>
                    {item.favorite ? "Unfavorite" : "Favorite"}
                </Button>
                <Button size="sm" icon={<Pencil size={11} />} onClick={() => setRenaming(true)}>
                    Rename
                </Button>
                <Button size="sm" icon={<RefreshCw size={11} />} onClick={() => void rerenderThumb()}>
                    Re-render preview
                </Button>
                {confirmDelete ? (
                    <Button size="sm" variant="danger" icon={<Trash2 size={11} />} onClick={() => void run(() => bridge().call("library.remove", { id: item.id }), "Model deleted").then(onClose)}>
                        Really delete?
                    </Button>
                ) : (
                    <Button size="sm" icon={<Trash2 size={11} />} onClick={() => setConfirmDelete(true)}>
                        Delete
                    </Button>
                )}
            </div>
            <p className="text-[10px] text-muted-foreground leading-snug">Layers already placed keep their pixels if you delete a model, but can only be re-posed after the model is imported again.</p>
        </div>
    );
}

export function LibraryTab() {
    const { library, info, settings, run, toast } = usePanel();
    const [importStatus, setImportStatus] = useState<string | null>(null);

    /** Converts what the host could not store directly, then reports the result once. */
    const finishImport = useCallback(
        async (batch: ImportBatch | null | undefined) => {
            if (!batch) return;
            if (batch.toConvert.length) setImportStatus(`Converting ${batch.toConvert.length} file${batch.toConvert.length === 1 ? "" : "s"}…`);
            const report = await processImportBatch(batch, setImportStatus);
            const summary = describeReport(report);
            if (summary) toast(summary.kind, summary.message);
        },
        [toast],
    );

    const importFrom = (folder: boolean) =>
        void run(() =>
            enqueueImport(async () => {
                setImportStatus(folder ? "Choose a folder…" : "Choose 3D files…");
                try {
                    const batch = await bridge().call("library.pickImport", { folder });
                    if (batch) setImportStatus("Reading files…");
                    await finishImport(batch);
                } finally {
                    setImportStatus(null);
                }
            }),
        );

    // Files copied into the Import folder are added while this tab is open.
    useEffect(() => {
        let stopped = false;
        const scan = () =>
            enqueueImport(async () => {
                if (stopped) return;
                const batch = await bridge().call("library.scanInbox");
                if (batch.imported.length || batch.toConvert.length || batch.failed.length) await finishImport(batch);
            }).catch((err: Error) => void bridge().call("log.write", { level: "warn", message: "Import folder scan failed", data: err.message }));
        void scan();
        const timer = window.setInterval(() => void scan(), INBOX_SCAN_MS);
        return () => {
            stopped = true;
            window.clearInterval(timer);
        };
    }, [finishImport]);
    const [query, setQuery] = useState("");
    const [filter, setFilter] = useState<Filter>("all");
    const [selected, setSelected] = useState<string | null>(null);
    const clickTimer = useRef<number | null>(null);
    const base = info?.libraryBaseUrl ?? null;

    const items = useMemo(() => {
        const q = query.trim().toLowerCase();
        return library.filter((i) => (filter === "all" ? true : filter === "favorites" ? i.favorite : i.origin === filter) && (!q || i.name.toLowerCase().includes(q) || (i.remoteId ?? "").toLowerCase().includes(q)));
    }, [library, query, filter]);
    const selectedItem = library.find((i) => i.id === selected);

    return (
        <div className="p-2 space-y-2">
            <div className="flex gap-1">
                <div className="relative flex-1">
                    <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
                    <TextInput value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search models" className="pl-6" />
                </div>
                <Select
                    value={filter}
                    onChange={setFilter}
                    className="w-28 shrink-0"
                    options={[
                        { value: "all", label: "All" },
                        { value: "favorites", label: "Favorites" },
                        ...(["meshy", "tripo", "hitem3d", "comfyui", "local"] as const).map((o) => ({ value: o, label: PROVIDER_LABELS[o] })),
                    ]}
                />
            </div>
            <div className="flex flex-wrap gap-1">
                <Button size="sm" icon={<Import size={11} />} disabled={!!importStatus} onClick={() => importFrom(false)} title={`Add 3D files to the library: ${SUPPORTED_FORMATS_TEXT}`} data-testid="import-files">
                    Import files…
                </Button>
                <Button size="sm" variant="ghost" icon={<FolderInput size={11} />} disabled={!!importStatus} onClick={() => importFrom(true)} title="Add every 3D file in a folder (and its subfolders)">
                    Import folder…
                </Button>
                <Button size="sm" variant="ghost" icon={<FolderOpen size={11} />} onClick={() => void run(() => bridge().call("library.revealFolder"))} title={info?.libraryFolder}>
                    Show folder
                </Button>
                <span className="ml-auto self-center text-[10px] text-muted-foreground">{library.length} models</span>
            </div>
            {importStatus ? (
                <div className="flex items-center gap-1.5 rounded-md bg-secondary px-2 py-1.5 text-[11px]" role="status" data-testid="import-status">
                    <Loader2 size={12} className="animate-spin shrink-0" />
                    <span className="truncate">{importStatus}</span>
                </div>
            ) : (
                <p className="text-[10px] leading-snug text-muted-foreground">
                    {SUPPORTED_FORMATS_TEXT}. Or copy files into the{" "}
                    <button type="button" className="text-primary hover:underline" onClick={() => void run(() => bridge().call("library.revealInbox"))} title={info?.importFolder}>
                        Import folder
                    </button>
                    : they are added automatically.
                </p>
            )}

            {selectedItem && <Details key={selectedItem.id} item={selectedItem} onClose={() => setSelected(null)} />}

            {items.length === 0 ? (
                <Empty icon={<Box size={22} />} title={library.length ? "No matches" : "Your library is empty"}>
                    {library.length ? "Try another search or filter." : "Generate a model on the Create tab, import one from Browse, or import 3D files (GLB, FBX, OBJ and more)."}
                </Empty>
            ) : (
                <div className="grid gap-1.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))" }} data-testid="library-grid">
                    {items.map((item) => (
                        <button
                            key={item.id}
                            type="button"
                            onClick={() => {
                                // Wait to see if this is a double-click before showing details (which shifts the grid).
                                if (clickTimer.current) window.clearTimeout(clickTimer.current);
                                clickTimer.current = window.setTimeout(() => setSelected(item.id === selected ? null : item.id), 220);
                            }}
                            onDoubleClick={() => {
                                if (clickTimer.current) window.clearTimeout(clickTimer.current);
                                void run(() => bridge().call("editor.placeModel", { libraryId: item.id }));
                            }}
                            className={`text-left rounded-md overflow-hidden border bg-card hover:border-primary transition-colors ${item.id === selected ? "border-primary" : "border-border"}`}
                            title={`${item.name}\nDouble-click to pose and place`}
                            data-testid="library-card"
                        >
                            <ModelThumb item={item} baseUrl={base} autoRender={settings?.library.autoThumbnails ?? true} className="aspect-square" />
                            <div className="px-1.5 py-1 flex items-center gap-1">
                                {item.favorite && <Star size={9} className="fill-current text-warning shrink-0" />}
                                <span className="text-[10px] truncate flex-1">{item.name}</span>
                            </div>
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
