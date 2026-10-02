/**
 * Library: every model downloaded or imported on this computer, stored in the plugin
 * data folder. Pick one to preview it in 3D and pose it into the active document.
 */
import { useMemo, useRef, useState } from "react";
import { Box, FolderOpen, Import, Pencil, Play, RefreshCw, Search, Star, Trash2, X } from "lucide-react";
import { formatBytes } from "@shared/bytes";
import { PROVIDER_LABELS, type LibraryItem, type ModelOrigin } from "@shared/types";
import { bridge } from "../bridge/client";
import { ModelPreview } from "../components/ModelPreview";
import { ModelThumb } from "../components/ModelThumb";
import { Badge, Button, Empty, Select, TextInput, timeAgo } from "../components/ui";
import { renderModelThumbnail } from "../three/thumbnail";
import { modelUrl } from "../three/modelSource";
import { usePanel } from "./store";

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
    const { library, info, settings, run } = usePanel();
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
            <div className="flex gap-1">
                <Button size="sm" icon={<Import size={11} />} onClick={() => void run(() => bridge().call("library.importFile"), undefined)}>
                    Import GLB…
                </Button>
                <Button size="sm" variant="ghost" icon={<FolderOpen size={11} />} onClick={() => void run(() => bridge().call("library.revealFolder"))} title={info?.libraryFolder}>
                    Show folder
                </Button>
                <span className="ml-auto self-center text-[10px] text-muted-foreground">{library.length} models</span>
            </div>

            {selectedItem && <Details key={selectedItem.id} item={selectedItem} onClose={() => setSelected(null)} />}

            {items.length === 0 ? (
                <Empty icon={<Box size={22} />} title={library.length ? "No matches" : "Your library is empty"}>
                    {library.length ? "Try another search or filter." : "Generate a model on the Create tab, import one from Browse, or import a .glb file."}
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
