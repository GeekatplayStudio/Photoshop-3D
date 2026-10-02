/**
 * The docked "3D Layers" panel: Create · Library · Browse · Settings.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Box, Cloud, Download, Library, Settings as SettingsIcon, Sparkles, X } from "lucide-react";
import { bridge } from "../bridge/client";
import { Button } from "../components/ui";
import { BrowseTab } from "./BrowseTab";
import { CreateTab } from "./CreateTab";
import { LibraryTab } from "./LibraryTab";
import { SettingsTab } from "./SettingsTab";
import { usePanel } from "./store";

type Tab = "create" | "library" | "browse" | "settings";

const TABS: { id: Tab; label: string; icon: ReactNode }[] = [
    { id: "create", label: "Create", icon: <Sparkles size={13} /> },
    { id: "library", label: "Library", icon: <Library size={13} /> },
    { id: "browse", label: "Browse", icon: <Cloud size={13} /> },
    { id: "settings", label: "Settings", icon: <SettingsIcon size={13} /> },
];

function UpdateBanner({ onOpen }: { onOpen: () => void }) {
    const { update, settings, run, toast } = usePanel();
    const [hidden, setHidden] = useState(false);
    const [busy, setBusy] = useState(false);
    if (!update?.available || hidden || update.latestVersion === settings?.updates.skippedVersion) return null;
    return (
        <div className="mx-2 mt-2 p-2 rounded-md bg-primary/15 border border-primary/40 text-xs flex items-center gap-2" data-testid="update-banner">
            <Download size={14} className="text-primary shrink-0" />
            <div className="flex-1 min-w-0">
                <div className="font-medium">Update available: v{update.latestVersion}</div>
                <button type="button" className="text-[10px] text-muted-foreground underline" onClick={onOpen}>
                    What's new
                </button>
            </div>
            <Button
                size="sm"
                variant="primary"
                busy={busy}
                onClick={async () => {
                    setBusy(true);
                    const r = await run(() => bridge().call("update.install"));
                    if (r) toast(r.started ? "success" : "info", r.message);
                    setBusy(false);
                }}
            >
                Update
            </Button>
            <button
                type="button"
                title="Skip this version"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => {
                    setHidden(true);
                    void bridge().call("update.skip", { version: update.latestVersion! });
                }}
            >
                <X size={13} />
            </button>
        </div>
    );
}

export function PanelApp() {
    const { toasts, dismissToast, jobs, library, info, setUpdate } = usePanel();
    const [tab, setTab] = useState<Tab>("create");
    const running = jobs.filter((j) => ["queued", "submitting", "running", "downloading"].includes(j.status)).length;

    useEffect(() => {
        // The host checks for updates on its own schedule; this picks up a result from before the panel opened.
        void bridge()
            .call("update.check", { force: false })
            .then(setUpdate)
            .catch(() => undefined);
    }, [setUpdate]);

    return (
        <div className="h-full flex flex-col">
            <nav className="flex border-b border-border bg-card shrink-0" role="tablist">
                {TABS.map((t) => (
                    <button
                        key={t.id}
                        type="button"
                        role="tab"
                        aria-selected={tab === t.id}
                        data-testid={`tab-${t.id}`}
                        onClick={() => setTab(t.id)}
                        className={`flex-1 flex items-center justify-center gap-1 h-9 text-[11px] border-b-2 transition-colors ${tab === t.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
                    >
                        {t.icon}
                        <span>{t.label}</span>
                        {t.id === "create" && running > 0 && <span className="ml-0.5 px-1 rounded bg-primary text-primary-foreground text-[9px]">{running}</span>}
                        {t.id === "library" && library.length > 0 && <span className="ml-0.5 text-[9px] text-muted-foreground">{library.length}</span>}
                    </button>
                ))}
            </nav>
            <UpdateBanner onOpen={() => setTab("settings")} />
            <main className="flex-1 overflow-y-auto">
                {tab === "create" && <CreateTab onOpenLibrary={() => setTab("library")} onOpenSettings={() => setTab("settings")} />}
                {tab === "library" && <LibraryTab />}
                {tab === "browse" && <BrowseTab />}
                {tab === "settings" && <SettingsTab />}
            </main>
            {!info && (
                <div className="absolute inset-0 flex items-center justify-center bg-background text-xs text-muted-foreground gap-2">
                    <Box size={14} className="animate-pulse" /> Starting…
                </div>
            )}
            <div className="fixed bottom-2 left-2 right-2 space-y-1 pointer-events-none z-50" aria-live="polite">
                {toasts.map((t) => (
                    <div
                        key={t.id}
                        role="status"
                        onClick={() => dismissToast(t.id)}
                        className={`pointer-events-auto text-[11px] px-3 py-2 rounded-md shadow-lg border cursor-pointer ${
                            t.kind === "error" ? "bg-danger/95 text-white border-danger" : t.kind === "success" ? "bg-success/95 text-white border-success" : "bg-card border-border"
                        }`}
                    >
                        {t.message}
                    </div>
                ))}
            </div>
        </div>
    );
}
