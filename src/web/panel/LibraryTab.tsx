/**
 * Library: every model downloaded or imported on this computer, stored in the plugin
 * data folder, organised in (virtual) folders. Pick one to preview it in 3D and pose it into
 * the active document.
 *
 * - Click a card for its details; Ctrl/Cmd+click and Shift+click select several.
 * - Drag cards onto a folder tile or the path above the grid to move them.
 * - Drag 3D files or folders from File Explorer / Finder onto the tab to import them.
 * - Delete removes the selected models (after a confirmation); Esc clears the selection.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from "react";
import { Box, ChevronRight, Folder, FolderInput, FolderOpen, FolderPlus, Import, Loader2, Pencil, Play, RefreshCw, Search, Star, Trash2, Upload, X } from "lucide-react";
import { SUPPORTED_FORMATS_TEXT, type ImportBatch } from "@shared/modelFormats";
import { childFolders, folderLabel, folderName, isInFolder, parentFolder } from "@shared/libraryFolders";
import { formatBytes } from "@shared/bytes";
import { PROVIDER_LABELS, type LibraryItem, type ModelOrigin } from "@shared/types";
import { bridge } from "../bridge/client";
import { ModelPreview } from "../components/ModelPreview";
import { ModelThumb } from "../components/ModelThumb";
import { Badge, Button, Empty, Select, TextInput, timeAgo } from "../components/ui";
import { renderModelThumbnail } from "../three/thumbnail";
import { modelUrl } from "../three/modelSource";
import { collectDropped, describeReport, enqueueImport, importDropped, isFileDrag, processImportBatch, supportsFileDrop, type ImportReport } from "./importModels";
import { usePanel } from "./store";

/** How often the Import folder is checked while the Library tab is open. */
const INBOX_SCAN_MS = 6000;
/** Drag payload for library cards (model ids). */
const CARD_MIME = "application/x-ps3d-models";

type Filter = "all" | "favorites" | ModelOrigin;

const folderOptions = (folders: string[]) => [{ value: "", label: "Library (top level)" }, ...folders.map((f) => ({ value: f, label: f.split("/").join(" › ") }))];

function Details({ item, onClose }: { item: LibraryItem; onClose: () => void }) {
    const { info, ps, run, folders } = usePanel();
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
            <div className="flex items-center gap-1">
                <Folder size={11} className="text-muted-foreground shrink-0" />
                <Select value={item.folder ?? ""} options={folderOptions(folders)} onChange={(folder) => void run(() => bridge().call("library.move", { ids: [item.id], folder }))} aria-label="Folder" data-testid="details-folder" />
            </div>
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
                    <Button size="sm" variant="danger" icon={<Trash2 size={11} />} onClick={() => void run(() => bridge().call("library.remove", { id: item.id }), "Model removed").then(onClose)}>
                        Really remove?
                    </Button>
                ) : (
                    <Button size="sm" icon={<Trash2 size={11} />} onClick={() => setConfirmDelete(true)}>
                        Remove
                    </Button>
                )}
            </div>
            <p className="text-[10px] text-muted-foreground leading-snug">Removing deletes the model from this computer. Layers already placed keep their pixels, but can only be re-posed after the model is imported again.</p>
        </div>
    );
}

/** A folder in the grid: opens on click, takes dropped cards, can be renamed or deleted. */
function FolderTile({ path, count, onOpen, onDropCards }: { path: string; count: number; onOpen: () => void; onDropCards: (ids: string[], folder: string) => void }) {
    const { run } = usePanel();
    const [over, setOver] = useState(false);
    const [renaming, setRenaming] = useState(false);
    const [name, setName] = useState(folderName(path));
    const [confirmDelete, setConfirmDelete] = useState(false);
    return (
        <div
            className={`relative rounded-md border bg-card flex flex-col transition-colors ${over ? "border-primary bg-primary/10" : "border-border hover:border-primary"}`}
            onDragOver={(e) => {
                if (![...e.dataTransfer.types].includes(CARD_MIME)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
                const ids = e.dataTransfer.getData(CARD_MIME);
                setOver(false);
                if (!ids) return;
                e.preventDefault();
                e.stopPropagation();
                onDropCards(JSON.parse(ids) as string[], path);
            }}
            data-testid="folder-tile"
            data-folder={path}
        >
            <button type="button" className="flex-1 aspect-square flex flex-col items-center justify-center gap-1 text-muted-foreground hover:text-foreground" onClick={onOpen} title={`Open ${path.split("/").join(" › ")}`}>
                <Folder size={34} strokeWidth={1.4} className={over ? "text-primary" : ""} />
                <span className="text-[10px]">
                    {count} model{count === 1 ? "" : "s"}
                </span>
            </button>
            {renaming ? (
                <form
                    className="flex gap-0.5 p-1"
                    onSubmit={(e) => {
                        e.preventDefault();
                        void run(() => bridge().call("library.renameFolder", { path, name })).then((r) => r && setRenaming(false));
                    }}
                >
                    <TextInput autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={60} onKeyDown={(e) => e.key === "Escape" && setRenaming(false)} className="h-6 text-[10px]" />
                </form>
            ) : confirmDelete ? (
                <div className="flex gap-0.5 p-1">
                    <Button size="sm" variant="danger" className="flex-1 px-1" onClick={() => void run(() => bridge().call("library.deleteFolder", { path }), "Folder deleted; its models moved up a level")} data-testid="folder-delete-confirm">
                        Delete
                    </Button>
                    <Button size="sm" variant="ghost" className="px-1" icon={<X size={10} />} onClick={() => setConfirmDelete(false)} title="Keep the folder" />
                </div>
            ) : (
                <div className="px-1.5 py-1 flex items-center gap-0.5">
                    <span className="text-[10px] truncate flex-1 font-medium" title={path}>
                        {folderName(path)}
                    </span>
                    <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => setRenaming(true)} title="Rename folder" data-testid="folder-rename">
                        <Pencil size={10} />
                    </button>
                    <button type="button" className="text-muted-foreground hover:text-danger" onClick={() => setConfirmDelete(true)} title="Delete folder (its models move up a level)" data-testid="folder-delete">
                        <Trash2 size={10} />
                    </button>
                </div>
            )}
        </div>
    );
}

export function LibraryTab() {
    const { library, folders, info, settings, run, toast } = usePanel();
    const [importStatus, setImportStatus] = useState<string | null>(null);
    const [folder, setFolder] = useState("");
    const [query, setQuery] = useState("");
    const [filter, setFilter] = useState<Filter>("all");
    const [selected, setSelected] = useState<string[]>([]);
    const [anchor, setAnchor] = useState<string | null>(null);
    const [newFolder, setNewFolder] = useState<string | null>(null);
    const [confirmRemove, setConfirmRemove] = useState(false);
    const [cardToRemove, setCardToRemove] = useState<string | null>(null);
    const [fileDrag, setFileDrag] = useState(false);
    const [dropCrumb, setDropCrumb] = useState<string | null>(null);
    const clickTimer = useRef<number | null>(null);
    const dragDepth = useRef(0);
    const base = info?.libraryBaseUrl ?? null;
    const canDrop = supportsFileDrop(info?.uxpVersion);

    // A folder that disappeared (renamed or deleted elsewhere): go up until one exists.
    useEffect(() => {
        if (folder && !folders.includes(folder)) setFolder((f) => (folders.includes(parentFolder(f)) ? parentFolder(f) : ""));
    }, [folders, folder]);
    // Selected models that were removed drop out of the selection.
    useEffect(() => setSelected((s) => s.filter((id) => library.some((i) => i.id === id))), [library]);

    const report = useCallback(
        (r: ImportReport) => {
            const summary = describeReport(r);
            if (summary) toast(summary.kind, summary.message);
        },
        [toast],
    );

    /** Converts what the host could not store directly, then reports the result once. */
    const finishImport = useCallback(
        async (batch: ImportBatch | null | undefined) => {
            if (!batch) return;
            if (batch.toConvert.length) setImportStatus(`Converting ${batch.toConvert.length} file${batch.toConvert.length === 1 ? "" : "s"}…`);
            report(await processImportBatch(batch, setImportStatus));
        },
        [report],
    );

    const importFrom = (pickFolder: boolean) =>
        void run(() =>
            enqueueImport(async () => {
                setImportStatus(pickFolder ? "Choose a folder…" : "Choose 3D files…");
                try {
                    const batch = await bridge().call("library.pickImport", { pickFolder, into: folder });
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

    const searching = query.trim() !== "" || filter !== "all";
    const items = useMemo(() => {
        const q = query.trim().toLowerCase();
        return library.filter(
            (i) =>
                (searching ? true : (i.folder ?? "") === folder) &&
                (filter === "all" ? true : filter === "favorites" ? i.favorite : i.origin === filter) &&
                (!q || i.name.toLowerCase().includes(q) || (i.remoteId ?? "").toLowerCase().includes(q) || (i.folder ?? "").toLowerCase().includes(q)),
        );
    }, [library, query, filter, folder, searching]);
    const subfolders = useMemo(() => (searching ? [] : childFolders(folders, folder)), [folders, folder, searching]);
    const countIn = useCallback((path: string) => library.filter((i) => isInFolder(i.folder ?? "", path)).length, [library]);
    const single = selected.length === 1 ? library.find((i) => i.id === selected[0]) : undefined;

    const move = useCallback(
        (ids: string[], to: string) =>
            void run(async () => {
                await bridge().call("library.move", { ids, folder: to });
                toast("success", `Moved ${ids.length} model${ids.length === 1 ? "" : "s"} to ${folderLabel(to)}`);
                setSelected([]);
            }),
        [run, toast],
    );
    const remove = useCallback(
        (ids: string[]) =>
            void run(async () => {
                await bridge().call("library.removeMany", { ids });
                toast("success", `Removed ${ids.length} model${ids.length === 1 ? "" : "s"}`);
                setSelected([]);
                setConfirmRemove(false);
                setCardToRemove(null);
            }),
        [run, toast],
    );

    const onCardClick = (e: ReactMouseEvent, item: LibraryItem) => {
        setCardToRemove(null);
        if (e.ctrlKey || e.metaKey) {
            setSelected((s) => (s.includes(item.id) ? s.filter((x) => x !== item.id) : [...s, item.id]));
            setAnchor(item.id);
            return;
        }
        if (e.shiftKey && anchor) {
            const ids = items.map((i) => i.id);
            const [a, b] = [ids.indexOf(anchor), ids.indexOf(item.id)].sort((x, y) => x - y);
            if (a >= 0) {
                setSelected(ids.slice(a, b + 1));
                return;
            }
        }
        // Wait to see if this is a double-click before showing details (which shifts the grid).
        if (clickTimer.current) window.clearTimeout(clickTimer.current);
        clickTimer.current = window.setTimeout(() => {
            setSelected((s) => (s.length === 1 && s[0] === item.id ? [] : [item.id]));
            setAnchor(item.id);
        }, 220);
    };

    // Delete removes the selection (after confirming), Esc clears it, Ctrl/Cmd+A selects all shown.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const t = e.target as HTMLElement | null;
            if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
            if ((e.key === "Delete" || e.key === "Backspace") && selected.length) {
                e.preventDefault();
                setConfirmRemove(true);
            } else if (e.key === "Escape") {
                setSelected([]);
                setConfirmRemove(false);
                setCardToRemove(null);
            } else if (e.key.toLowerCase() === "a" && (e.ctrlKey || e.metaKey) && items.length) {
                e.preventDefault();
                setSelected(items.map((i) => i.id));
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [selected, items]);

    /* ---- files dragged in from File Explorer / Finder */
    const onDragEnter = (e: DragEvent) => {
        if (!isFileDrag(e.dataTransfer)) return;
        dragDepth.current++;
        setFileDrag(true);
    };
    const onDragOver = (e: DragEvent) => {
        if (!isFileDrag(e.dataTransfer)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
    };
    const onDragLeave = (e: DragEvent) => {
        if (!isFileDrag(e.dataTransfer)) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setFileDrag(false);
    };
    const onDrop = (e: DragEvent) => {
        if (!isFileDrag(e.dataTransfer)) return;
        e.preventDefault();
        dragDepth.current = 0;
        setFileDrag(false);
        const dt = e.dataTransfer;
        const target = folder;
        // Read the entries now: the DataTransfer is only valid during the drop event.
        const files = collectDropped(dt);
        void run(() =>
            enqueueImport(async () => {
                setImportStatus("Reading dropped files…");
                try {
                    report(await importDropped(await files, target, setImportStatus));
                } finally {
                    setImportStatus(null);
                }
            }),
        );
    };

    /** Breadcrumb segment: opens the folder and takes dropped cards. */
    const crumb = (path: string, label: string) => (
        <button
            key={path || "root"}
            type="button"
            className={`rounded px-1 py-0.5 truncate max-w-[9rem] ${path === folder ? "font-semibold text-foreground" : "text-muted-foreground hover:text-foreground"} ${dropCrumb === path ? "bg-primary/20 text-foreground" : ""}`}
            onClick={() => {
                setFolder(path);
                setSelected([]);
            }}
            onDragOver={(e) => {
                if (![...e.dataTransfer.types].includes(CARD_MIME)) return;
                e.preventDefault();
                setDropCrumb(path);
            }}
            onDragLeave={() => setDropCrumb(null)}
            onDrop={(e) => {
                const ids = e.dataTransfer.getData(CARD_MIME);
                setDropCrumb(null);
                if (!ids) return;
                e.preventDefault();
                move(JSON.parse(ids) as string[], path);
            }}
            data-testid="crumb"
            data-folder={path}
        >
            {label}
        </button>
    );

    const crumbs = folder ? folder.split("/").map((part, i, all) => ({ path: all.slice(0, i + 1).join("/"), label: part })) : [];

    return (
        <div className="relative p-2 space-y-2 min-h-full" onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop} data-testid="library">
            {fileDrag && (
                <div className="absolute inset-1 z-20 rounded-lg border-2 border-dashed border-primary bg-background/85 flex flex-col items-center justify-center gap-2 text-center pointer-events-none" data-testid="drop-overlay">
                    <Upload size={28} className="text-primary" />
                    <div className="text-xs font-semibold">Drop 3D files or folders</div>
                    <div className="text-[10px] text-muted-foreground px-4">They are added to {folderLabel(folder)}.</div>
                </div>
            )}
            <div className="flex gap-1">
                <div className="relative flex-1">
                    <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
                    <TextInput value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search all folders" className="pl-6" />
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
                <Button size="sm" icon={<Import size={11} />} disabled={!!importStatus} onClick={() => importFrom(false)} title={`Add 3D files to ${folderLabel(folder)}: ${SUPPORTED_FORMATS_TEXT}`} data-testid="import-files">
                    Import files…
                </Button>
                <Button size="sm" variant="ghost" icon={<FolderInput size={11} />} disabled={!!importStatus} onClick={() => importFrom(true)} title="Add a folder of 3D files; it becomes a library folder with the same subfolders">
                    Import folder…
                </Button>
                <Button size="sm" variant="ghost" icon={<FolderPlus size={11} />} onClick={() => setNewFolder("")} title={`New folder in ${folderLabel(folder)}`} data-testid="new-folder">
                    New folder
                </Button>
                <Button size="sm" variant="ghost" icon={<FolderOpen size={11} />} onClick={() => void run(() => bridge().call("library.revealFolder"))} title={info?.libraryFolder}>
                    Show folder
                </Button>
            </div>
            {importStatus ? (
                <div className="flex items-center gap-1.5 rounded-md bg-secondary px-2 py-1.5 text-[11px]" role="status" data-testid="import-status">
                    <Loader2 size={12} className="animate-spin shrink-0" />
                    <span className="truncate">{importStatus}</span>
                </div>
            ) : (
                <p className="text-[10px] leading-snug text-muted-foreground">
                    {canDrop ? `Drag 3D files or folders here (${SUPPORTED_FORMATS_TEXT}), or copy them` : `${SUPPORTED_FORMATS_TEXT}. Or copy files`} into the{" "}
                    <button type="button" className="text-primary hover:underline" onClick={() => void run(() => bridge().call("library.revealInbox"))} title={info?.importFolder}>
                        Import folder
                    </button>
                    . They are added automatically.
                </p>
            )}

            {newFolder !== null && (
                <form
                    className="flex gap-1"
                    onSubmit={(e) => {
                        e.preventDefault();
                        void run(() => bridge().call("library.createFolder", { parent: folder, name: newFolder })).then((r) => r && setNewFolder(null));
                    }}
                >
                    <TextInput autoFocus value={newFolder} onChange={(e) => setNewFolder(e.target.value)} placeholder={`New folder in ${folderLabel(folder)}`} maxLength={60} onKeyDown={(e) => e.key === "Escape" && setNewFolder(null)} data-testid="new-folder-name" />
                    <Button size="sm" type="submit" variant="primary" className="h-8">
                        Create
                    </Button>
                    <Button size="sm" variant="ghost" className="h-8" icon={<X size={12} />} onClick={() => setNewFolder(null)} title="Cancel" />
                </form>
            )}

            {!searching && (
                <nav className="flex items-center flex-wrap gap-0.5 text-[11px]" aria-label="Folder">
                    {crumb("", "Library")}
                    {crumbs.map((c) => (
                        <span key={c.path} className="flex items-center gap-0.5">
                            <ChevronRight size={10} className="text-muted-foreground" />
                            {crumb(c.path, c.label)}
                        </span>
                    ))}
                    <span className="ml-auto text-[10px] text-muted-foreground">
                        {countIn(folder)} model{countIn(folder) === 1 ? "" : "s"}
                    </span>
                </nav>
            )}
            {searching && <div className="text-[10px] text-muted-foreground">{items.length} found in all folders</div>}

            {selected.length > 1 && (
                <div className="flex flex-wrap items-center gap-1 rounded-md border border-primary/60 bg-primary/10 p-1.5" data-testid="selection-bar">
                    <span className="text-[11px] font-medium mr-auto">{selected.length} selected</span>
                    {confirmRemove ? (
                        <>
                            <Button size="sm" variant="danger" icon={<Trash2 size={11} />} onClick={() => remove(selected)} data-testid="remove-selected-confirm">
                                Remove {selected.length} models?
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(false)}>
                                Keep
                            </Button>
                        </>
                    ) : (
                        <>
                            <Select value={"\u0000" as string} options={[{ value: "\u0000", label: "Move to…" }, ...folderOptions(folders)]} onChange={(to) => to !== "\u0000" && move(selected, to)} className="w-32" aria-label="Move to folder" data-testid="move-selected" />
                            <Button size="sm" icon={<Trash2 size={11} />} onClick={() => setConfirmRemove(true)} data-testid="remove-selected">
                                Remove
                            </Button>
                            <Button size="sm" variant="ghost" icon={<X size={11} />} onClick={() => setSelected([])} title="Clear the selection (Esc)" />
                        </>
                    )}
                </div>
            )}

            {single && (
                <Details
                    key={single.id}
                    item={single}
                    onClose={() => {
                        setSelected([]);
                        setConfirmRemove(false);
                    }}
                />
            )}
            {single && confirmRemove && (
                <div className="flex items-center gap-1 rounded-md border border-danger/60 bg-danger/10 p-1.5">
                    <span className="text-[11px] mr-auto">Remove {single.name}?</span>
                    <Button size="sm" variant="danger" onClick={() => remove([single.id])}>
                        Remove
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(false)}>
                        Keep
                    </Button>
                </div>
            )}

            {items.length === 0 && subfolders.length === 0 ? (
                <Empty icon={<Box size={22} />} title={library.length ? (searching ? "No matches" : "This folder is empty") : "Your library is empty"}>
                    {library.length
                        ? searching
                            ? "Try another search or filter."
                            : "Drag models onto this folder's name above, or drop 3D files here."
                        : "Generate a model on the Create tab, import one from Browse, or drag 3D files here (GLB, FBX, OBJ and more)."}
                </Empty>
            ) : (
                <div className="grid gap-1.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))" }} data-testid="library-grid">
                    {subfolders.map((path) => (
                        <FolderTile
                            key={path}
                            path={path}
                            count={countIn(path)}
                            onOpen={() => {
                                setFolder(path);
                                setSelected([]);
                            }}
                            onDropCards={move}
                        />
                    ))}
                    {items.map((item) => {
                        const isSelected = selected.includes(item.id);
                        return (
                            <div key={item.id} className="relative group">
                                <button
                                    type="button"
                                    draggable
                                    onDragStart={(e) => {
                                        const ids = isSelected ? selected : [item.id];
                                        e.dataTransfer.setData(CARD_MIME, JSON.stringify(ids));
                                        e.dataTransfer.effectAllowed = "move";
                                    }}
                                    onClick={(e) => onCardClick(e, item)}
                                    onDoubleClick={() => {
                                        if (clickTimer.current) window.clearTimeout(clickTimer.current);
                                        void run(() => bridge().call("editor.placeModel", { libraryId: item.id }));
                                    }}
                                    className={`w-full text-left rounded-md overflow-hidden border bg-card hover:border-primary transition-colors ${isSelected ? "border-primary ring-1 ring-primary" : "border-border"}`}
                                    title={`${item.name}${searching && item.folder ? `\nIn ${item.folder.split("/").join(" › ")}` : ""}\nDouble-click to pose and place · drag onto a folder to move`}
                                    data-testid="library-card"
                                    data-selected={isSelected || undefined}
                                >
                                    <ModelThumb item={item} baseUrl={base} autoRender={settings?.library.autoThumbnails ?? true} className="aspect-square" />
                                    <div className="px-1.5 py-1 flex items-center gap-1">
                                        {item.favorite && <Star size={9} className="fill-current text-warning shrink-0" />}
                                        <span className="text-[10px] truncate flex-1">{item.name}</span>
                                    </div>
                                    {searching && item.folder && <div className="px-1.5 pb-1 -mt-1 text-[9px] text-muted-foreground truncate">{item.folder.split("/").join(" › ")}</div>}
                                </button>
                                {cardToRemove === item.id ? (
                                    <button type="button" className="absolute top-1 right-1 rounded bg-danger px-1.5 py-0.5 text-[10px] font-semibold text-white shadow" onClick={() => remove([item.id])} data-testid="card-remove-confirm">
                                        Remove?
                                    </button>
                                ) : (
                                    <button
                                        type="button"
                                        className="absolute top-1 right-1 rounded bg-background/80 p-1 text-muted-foreground opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-danger transition-opacity"
                                        onClick={() => setCardToRemove(item.id)}
                                        title="Remove from the library"
                                        data-testid="card-remove"
                                    >
                                        <Trash2 size={11} />
                                    </button>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
