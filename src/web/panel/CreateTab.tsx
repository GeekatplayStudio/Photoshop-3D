/**
 * Create: send the active layer / selection to a 3D service and follow the jobs.
 * Also the home of "Edit 3D layer" when the active layer is one of ours.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, BookOpen, Box, CheckCircle2, Clock, ImageOff, KeyRound, Pencil, Play, RefreshCw, Send, Sparkles, Trash2, Unlink, X } from "lucide-react";
import { PROVIDER_LABELS, type Job, type ProviderId, type SendSource } from "@shared/types";
import { bridge } from "../bridge/client";
import { Badge, Button, Empty, Field, ProgressBar, Section, Select, TextInput, timeAgo } from "../components/ui";
import { usePanel } from "./store";

const SOURCE_OPTIONS: { value: SendSource; label: string }[] = [
    { value: "auto", label: "Selection if any, else layer" },
    { value: "layer", label: "Active layer" },
    { value: "selection", label: "Visible pixels in selection" },
];

function statusBadge(job: Job) {
    switch (job.status) {
        case "succeeded":
            return <Badge tone="success">Ready</Badge>;
        case "failed":
            return <Badge tone="danger">Failed</Badge>;
        case "cancelled":
            return <Badge>Cancelled</Badge>;
        case "queued":
            return <Badge tone="warning">Queued</Badge>;
        case "downloading":
            return <Badge tone="info">Downloading</Badge>;
        default:
            return <Badge tone="info">{job.status === "submitting" ? "Sending" : "Generating"}</Badge>;
    }
}

function JobCard({ job, onOpenLibrary }: { job: Job; onOpenLibrary: () => void }) {
    const { run } = usePanel();
    const active = ["queued", "submitting", "running", "downloading"].includes(job.status);
    return (
        <div className="flex gap-2 p-2 rounded-md bg-card border border-border" data-testid="job-card">
            <div className="w-12 h-12 shrink-0 rounded bg-background overflow-hidden flex items-center justify-center checkerboard">
                {job.sourcePreview ? <img src={job.sourcePreview} alt="" className="w-full h-full object-contain" /> : <ImageOff size={16} className="text-muted-foreground" />}
            </div>
            <div className="flex-1 min-w-0 space-y-1">
                <div className="flex items-center gap-1.5">
                    <span className="text-xs font-medium truncate flex-1" title={job.name}>
                        {job.name}
                    </span>
                    {statusBadge(job)}
                </div>
                <div className="text-[10px] text-muted-foreground truncate" title={job.error ?? job.message}>
                    {PROVIDER_LABELS[job.providerId]} · {timeAgo(job.createdAt)}
                    {job.error ? ` · ${job.error}` : job.message ? ` · ${job.message}` : ""}
                </div>
                {active && <ProgressBar value={job.progress} indeterminate={job.status === "submitting" || (job.status === "queued" && !job.progress)} />}
                <div className="flex flex-wrap gap-1 pt-0.5">
                    {job.status === "succeeded" && job.libraryId && (
                        <>
                            <Button size="sm" variant="primary" icon={<Play size={11} />} onClick={() => void run(() => bridge().call("editor.placeModel", { libraryId: job.libraryId!, atSource: job.id }))}>
                                Pose & place
                            </Button>
                            <Button size="sm" variant="ghost" icon={<Box size={11} />} onClick={onOpenLibrary}>
                                Library
                            </Button>
                        </>
                    )}
                    {active && (
                        <Button size="sm" variant="ghost" icon={<X size={11} />} onClick={() => void run(() => bridge().call("jobs.cancel", { id: job.id }))}>
                            Cancel
                        </Button>
                    )}
                    {(job.status === "failed" || job.status === "cancelled") && (
                        <Button size="sm" variant="ghost" icon={<RefreshCw size={11} />} onClick={() => void run(() => bridge().call("jobs.retry", { id: job.id }))}>
                            Retry
                        </Button>
                    )}
                    {!active && (
                        <Button size="sm" variant="ghost" icon={<Trash2 size={11} />} title="Remove from this list (the model stays in the library)" onClick={() => void run(() => bridge().call("jobs.dismiss", { id: job.id }))}>
                            Remove
                        </Button>
                    )}
                    {job.remoteId && <span className="text-[9px] text-muted-foreground self-center select-text ml-auto" title="Task id at the provider">{job.remoteId.slice(0, 14)}</span>}
                </div>
            </div>
        </div>
    );
}

/** First-run help: three steps from install to a re-posable 3D layer. */
function GettingStarted({ onOpenSettings }: { onOpenSettings: () => void }) {
    const { info, run, setSettings } = usePanel();
    const step = (n: number, body: ReactNode) => (
        <li className="flex gap-2">
            <span className="w-4 h-4 shrink-0 rounded-full bg-primary text-primary-foreground text-[10px] flex items-center justify-center font-semibold">{n}</span>
            <span className="leading-snug">{body}</span>
        </li>
    );
    return (
        <div className="p-2.5 rounded-md border border-primary/50 bg-primary/10 space-y-2 text-[11px]" data-testid="getting-started">
            <div className="flex items-center gap-1.5 text-xs font-semibold">
                <Sparkles size={13} className="text-primary" /> Getting started
            </div>
            <ol className="space-y-1.5">
                {step(1, <>Pick a 3D service. <b>Meshy</b>, <b>Tripo</b> or <b>Hitem3D</b> need an account and an API key (add it in Settings). <b>ComfyUI</b> runs free on your own computer if you have it.</>)}
                {step(2, <>Select a layer — an object on a transparent background works best — and press <b>Generate 3D model</b>.</>)}
                {step(3, <>When it's ready, click <b>Pose &amp; place</b>. Later, <b>double-click the new layer</b> to change its pose and light.</>)}
            </ol>
            <div className="flex flex-wrap gap-1 pt-0.5">
                <Button size="sm" variant="primary" icon={<KeyRound size={11} />} onClick={onOpenSettings}>
                    Set up a service
                </Button>
                {info && (
                    <Button size="sm" icon={<BookOpen size={11} />} onClick={() => void bridge().call("shell.openExternal", { url: `${info.repoUrl}/blob/main/docs/USER_GUIDE.md` })}>
                        Read the guide
                    </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => void run(async () => setSettings(await bridge().call("settings.update", { ui: { welcomeDismissed: true } })))}>
                    Hide
                </Button>
            </div>
        </div>
    );
}

export function CreateTab({ onOpenLibrary, onOpenSettings }: { onOpenLibrary: () => void; onOpenSettings: () => void }) {
    const { settings, providers, jobs, ps, run } = usePanel();
    const [provider, setProvider] = useState<ProviderId>(settings?.defaultProvider ?? "meshy");
    const [source, setSource] = useState<SendSource>(settings?.send.source ?? "auto");
    const [name, setName] = useState("");
    const [preview, setPreview] = useState<{ dataUrl: string; width: number; height: number; label: string } | null>(null);
    const [previewError, setPreviewError] = useState<string | null>(null);
    const [sending, setSending] = useState(false);

    // Start with the last service used (saved as the default provider).
    const initialised = useRef(false);
    useEffect(() => {
        if (settings && !initialised.current) {
            initialised.current = true;
            setProvider(settings.defaultProvider);
            setSource(settings.send.source);
        }
    }, [settings]);

    // Refresh the "what will be sent" preview when Photoshop's context changes.
    const contextKey = `${ps?.docId}:${ps?.layerId}:${ps?.hasSelection}:${source}`;
    useEffect(() => {
        if (!ps?.hasDocument) {
            setPreview(null);
            return;
        }
        let live = true;
        const t = window.setTimeout(() => {
            bridge()
                .call("ps.sourcePreview", { source })
                .then((p) => live && (setPreview(p), setPreviewError(null)))
                .catch((e: Error) => live && (setPreview(null), setPreviewError(e.message)));
        }, 300);
        return () => {
            live = false;
            window.clearTimeout(t);
        };
    }, [contextKey, ps?.hasDocument, source]);

    const status = providers.find((p) => p.id === provider);
    const send = async () => {
        setSending(true);
        await run(async () => {
            await bridge().call("generate.start", { providerId: provider, source, name: name.trim() || undefined });
            setName("");
            if (settings && (settings.defaultProvider !== provider || settings.send.source !== source)) await bridge().call("settings.update", { defaultProvider: provider, send: { source } });
        }, `Sent to ${PROVIDER_LABELS[provider]}`);
        setSending(false);
    };

    const activeJobs = jobs.filter((j) => ["queued", "submitting", "running", "downloading"].includes(j.status));
    const doneJobs = jobs.filter((j) => !activeJobs.includes(j));

    return (
        <div className="p-2 space-y-2">
            {settings && !settings.ui.welcomeDismissed && <GettingStarted onOpenSettings={onOpenSettings} />}
            {ps?.is3DLayer && (
                <div className="flex items-center gap-2 p-2 rounded-md border border-primary/50 bg-primary/10">
                    <Box size={16} className="text-primary shrink-0" />
                    <div className="flex-1 min-w-0 text-xs">
                        <div className="font-medium truncate">{ps.layerName}</div>
                        <div className="text-[10px] text-muted-foreground truncate">3D layer · {ps.modelName}</div>
                    </div>
                    <Button size="sm" variant="primary" icon={<Pencil size={11} />} onClick={() => void run(() => bridge().call("editor.editActiveLayer"))} data-testid="edit-3d-layer">
                        Edit pose & light
                    </Button>
                    <Button size="sm" variant="ghost" icon={<Unlink size={11} />} title="Detach 3D data: the layer becomes an ordinary smart object (double-click edits its pixels)" onClick={() => void run(() => bridge().call("layer.detach3D"), "3D data removed from the layer")} />

                </div>
            )}

            <Section title="Make a 3D model" testId="create-section">
                <div className="flex gap-2">
                    <div className="w-20 h-20 shrink-0 rounded border border-border checkerboard flex items-center justify-center overflow-hidden">
                        {preview ? <img src={preview.dataUrl} alt="Source" className="w-full h-full object-contain" /> : <ImageOff size={18} className="text-muted-foreground" />}
                    </div>
                    <div className="flex-1 min-w-0 text-[11px] space-y-1">
                        {!ps?.hasDocument ? (
                            <div className="text-muted-foreground">Open a document and select a layer or make a selection.</div>
                        ) : preview ? (
                            <>
                                <div className="font-medium truncate">{preview.label}</div>
                                <div className="text-muted-foreground">
                                    {preview.width}×{preview.height} px from {ps.docTitle}
                                </div>
                            </>
                        ) : (
                            <div className="text-warning flex gap-1">
                                <AlertTriangle size={12} className="shrink-0 mt-px" />
                                {previewError ?? "Reading the layer…"}
                            </div>
                        )}
                        <div className="text-muted-foreground leading-snug">Tip: cut the object out (transparent background) for the cleanest model.</div>
                    </div>
                </div>
                <Field label="Source">
                    <Select value={source} options={SOURCE_OPTIONS} onChange={setSource} />
                </Field>
                <Field label="3D service" hint={status && !status.configured ? <span className="text-warning">{status.hint ?? "Not set up yet."} <button type="button" className="underline" onClick={onOpenSettings}>Open settings</button></span> : undefined}>
                    <Select value={provider} options={providers.map((p) => ({ value: p.id, label: `${p.label}${p.configured ? "" : " (not set up)"}` }))} onChange={setProvider} data-testid="provider-select" />
                </Field>
                <Field label="Name (optional)">
                    <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder={preview?.label ?? "Model name"} maxLength={80} />
                </Field>
                <Button variant="primary" className="w-full" icon={<Send size={13} />} busy={sending} disabled={!ps?.hasDocument || !status?.configured} onClick={() => void send()} data-testid="generate">
                    Generate 3D model
                </Button>
            </Section>

            <Section title={`Jobs${activeJobs.length ? ` (${activeJobs.length} running)` : ""}`} testId="jobs-section">
                {jobs.length === 0 ? (
                    <Empty icon={<Clock size={20} />} title="No jobs yet">
                        Generated models appear here, then in the Library. Jobs keep running if you close the panel or restart Photoshop.
                    </Empty>
                ) : (
                    <div className="space-y-1.5">
                        {[...activeJobs, ...doneJobs].map((j) => (
                            <JobCard key={j.id} job={j} onOpenLibrary={onOpenLibrary} />
                        ))}
                    </div>
                )}
                {doneJobs.some((j) => j.status === "succeeded") && (
                    <div className="text-[10px] text-muted-foreground flex items-center gap-1">
                        <CheckCircle2 size={11} /> Finished models are saved in the Library on this computer.
                    </div>
                )}
            </Section>
        </div>
    );
}
