/**
 * Panel state: one React context fed by bridge calls and host push events.
 * Every piece of state here mirrors something the host owns (settings, jobs, library,
 * Photoshop context); the panel never invents its own copy of the truth.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { PublicSettings } from "@shared/settings";
import type { AppInfo, Job, LibraryItem, ProviderStatus, PsContext, UpdateInfo } from "@shared/types";
import { bridge } from "../bridge/client";
import { resolveLibraryBase } from "../three/modelSource";

export type Toast = { id: number; kind: "info" | "success" | "error"; message: string };

type PanelState = {
    info: AppInfo | null;
    settings: PublicSettings | null;
    providers: ProviderStatus[];
    jobs: Job[];
    library: LibraryItem[];
    /** Library folders ("A", "A/B"); see shared/libraryFolders.ts. */
    folders: string[];
    ps: PsContext | null;
    update: UpdateInfo | null;
    toasts: Toast[];
    toast: (kind: Toast["kind"], message: string) => void;
    dismissToast: (id: number) => void;
    refreshProviders: () => Promise<void>;
    setSettings: (s: PublicSettings) => void;
    setUpdate: (u: UpdateInfo) => void;
    /** Runs an action, reporting failures as a toast; returns undefined on error. */
    run: <T>(fn: () => Promise<T>, success?: string) => Promise<T | undefined>;
};

const Ctx = createContext<PanelState | null>(null);

export function PanelProvider({ children }: { children: React.ReactNode }) {
    const [info, setInfo] = useState<AppInfo | null>(null);
    const [settings, setSettings] = useState<PublicSettings | null>(null);
    const [providers, setProviders] = useState<ProviderStatus[]>([]);
    const [jobs, setJobs] = useState<Job[]>([]);
    const [library, setLibrary] = useState<LibraryItem[]>([]);
    const [folders, setFolders] = useState<string[]>([]);
    const [ps, setPs] = useState<PsContext | null>(null);
    const [update, setUpdate] = useState<UpdateInfo | null>(null);
    const [toasts, setToasts] = useState<Toast[]>([]);
    const nextToast = useRef(1);

    const dismissToast = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
    const toast = useCallback(
        (kind: Toast["kind"], message: string) => {
            const id = nextToast.current++;
            setToasts((t) => [...t.slice(-3), { id, kind, message }]);
            window.setTimeout(() => dismissToast(id), kind === "error" ? 9000 : 4000);
        },
        [dismissToast],
    );
    const run = useCallback(
        async <T,>(fn: () => Promise<T>, success?: string) => {
            try {
                const r = await fn();
                if (success) toast("success", success);
                return r;
            } catch (err) {
                toast("error", (err as Error).message);
                return undefined;
            }
        },
        [toast],
    );
    const refreshProviders = useCallback(async () => setProviders(await bridge().call("providers.status")), []);

    useEffect(() => {
        const b = bridge();
        const offs = [
            b.on("jobs.changed", setJobs),
            b.on("library.changed", setLibrary),
            b.on("library.foldersChanged", setFolders),
            b.on("ps.context", setPs),
            b.on("settings.changed", (s) => {
                setSettings(s);
                void refreshProviders();
            }),
            b.on("update.available", setUpdate),
            b.on("theme.changed", ({ theme }) => (document.documentElement.dataset.theme = theme)),
            b.on("toast", ({ kind, message }) => toast(kind, message)),
        ];
        void (async () => {
            const [i, s, j, l, c, f] = await Promise.all([b.call("app.info"), b.call("settings.get"), b.call("jobs.list"), b.call("library.list"), b.call("ps.context"), b.call("library.folders")]);
            document.documentElement.dataset.theme = i.theme;
            const base = await resolveLibraryBase(i.libraryBaseUrl);
            if (i.libraryBaseUrl && !base) void b.call("log.write", { level: "warn", message: "Library folder not readable from the WebView; streaming models through the bridge", data: i.libraryBaseUrl });
            setInfo({ ...i, libraryBaseUrl: base });
            setSettings(s);
            setJobs(j);
            setLibrary(l);
            setFolders(f);
            setPs(c);
            await refreshProviders();
        })().catch((err) => toast("error", `Could not load the panel: ${(err as Error).message}`));
        return () => offs.forEach((off) => off());
    }, [refreshProviders, toast]);

    const value = useMemo<PanelState>(
        () => ({ info, settings, providers, jobs, library, folders, ps, update, toasts, toast, dismissToast, refreshProviders, setSettings, setUpdate, run }),
        [info, settings, providers, jobs, library, folders, ps, update, toasts, toast, dismissToast, refreshProviders, run],
    );
    return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePanel(): PanelState {
    const v = useContext(Ctx);
    if (!v) throw new Error("usePanel outside PanelProvider");
    return v;
}
