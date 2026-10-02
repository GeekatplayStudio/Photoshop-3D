/**
 * Settings: API keys and addresses, per-service generation options, editor defaults,
 * updates, and diagnostics (versions, folders, the log) — so nothing is hidden.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { CheckCircle2, Download, ExternalLink, FileJson, FolderOpen, KeyRound, RefreshCw, RotateCcw, ScrollText, XCircle } from "lucide-react";
import {
    HITEM3D_MODELS,
    HITEM3D_RESOLUTIONS,
    MESHY_AI_MODELS,
    TRIPO_MODEL_VERSIONS,
    hitem3dSupportsPbr,
    type DeepPartial,
    type PublicSettings,
    type SecretKey,
    type Settings,
} from "@shared/settings";
import { DEFAULT_LIGHTING } from "@shared/threeD";
import { PROVIDER_IDS, PROVIDER_LABELS, type ProviderId, type ProviderTestResult } from "@shared/types";
import { bridge } from "../bridge/client";
import { Badge, Button, Field, Section, Select, TextInput, Toggle } from "../components/ui";
import { usePanel } from "./store";

/** Text/number input that commits on blur or Enter (avoids a settings write per keystroke). */
function CommitInput({ value, onCommit, type = "text", placeholder, min, max }: { value: string | number; onCommit: (v: string) => void; type?: string; placeholder?: string; min?: number; max?: number }) {
    const [local, setLocal] = useState(String(value));
    useEffect(() => setLocal(String(value)), [value]);
    const commit = () => {
        if (local !== String(value)) onCommit(local);
    };
    return <TextInput type={type} value={local} min={min} max={max} placeholder={placeholder} onChange={(e) => setLocal(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && commit()} />;
}

function SecretField({ label, secretKey, settings, placeholder, hint }: { label: string; secretKey: SecretKey; settings: PublicSettings; placeholder?: string; hint?: ReactNode }) {
    const { run, setSettings } = usePanel();
    const info = settings.secrets[secretKey];
    const [editing, setEditing] = useState(!info.set);
    const [value, setValue] = useState("");
    useEffect(() => setEditing(!info.set), [info.set]);
    const save = async (v: string) => {
        const s = await run(() => bridge().call("settings.setSecret", { key: secretKey, value: v }), v ? `${label} saved securely` : `${label} removed`);
        if (s) {
            setSettings(s);
            setValue("");
        }
    };
    return (
        <Field label={label} hint={hint}>
            {editing ? (
                <div className="flex gap-1">
                    <TextInput type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder} onKeyDown={(e) => e.key === "Enter" && value.trim() && void save(value)} />
                    <Button size="md" variant="primary" disabled={!value.trim()} onClick={() => void save(value)}>
                        Save
                    </Button>
                    {info.set && (
                        <Button size="md" variant="ghost" onClick={() => setEditing(false)}>
                            Cancel
                        </Button>
                    )}
                </div>
            ) : (
                <div className="flex items-center gap-1">
                    <KeyRound size={12} className="text-success" />
                    <span className="text-xs flex-1 font-mono">{info.preview}</span>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
                        Change
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void save("")}>
                        Remove
                    </Button>
                </div>
            )}
        </Field>
    );
}

function TestButton({ providerId }: { providerId: ProviderId }) {
    const [result, setResult] = useState<ProviderTestResult | null>(null);
    const [busy, setBusy] = useState(false);
    return (
        <div className="space-y-1">
            <Button
                size="sm"
                busy={busy}
                icon={<RefreshCw size={11} />}
                onClick={async () => {
                    setBusy(true);
                    try {
                        setResult(await bridge().call("providers.test", { providerId }));
                    } catch (err) {
                        setResult({ ok: false, message: (err as Error).message });
                    }
                    setBusy(false);
                }}
            >
                Test connection
            </Button>
            {result && (
                <div className={`flex gap-1 text-[10px] leading-snug ${result.ok ? "text-success" : "text-danger"}`} data-testid={`test-result-${providerId}`}>
                    {result.ok ? <CheckCircle2 size={11} className="shrink-0 mt-px" /> : <XCircle size={11} className="shrink-0 mt-px" />}
                    <span>
                        {result.message}
                        {result.balance ? ` Balance: ${result.balance}.` : ""}
                    </span>
                </div>
            )}
        </div>
    );
}

/** Model picker: known ids plus whatever the user typed (new provider models work without an update). */
function ModelSelect({ value, known, onChange }: { value: string; known: readonly string[]; onChange: (v: string) => void }) {
    const options = known.includes(value) ? [...known] : [...known, value];
    const [custom, setCustom] = useState(false);
    return custom ? (
        <CommitInput value={value} onCommit={(v) => (onChange(v.trim() || known[0]), setCustom(false))} placeholder="model id" />
    ) : (
        <div className="flex gap-1">
            <Select value={value} options={options} onChange={onChange} />
            <Button size="md" variant="ghost" onClick={() => setCustom(true)} title="Type another model id">
                …
            </Button>
        </div>
    );
}

function Link({ href, children }: { href: string; children: ReactNode }) {
    return (
        <button type="button" className="inline-flex items-center gap-0.5 text-primary hover:underline" onClick={() => void bridge().call("shell.openExternal", { url: href })}>
            {children}
            <ExternalLink size={9} />
        </button>
    );
}

export function SettingsTab() {
    const { settings, info, update, setUpdate, run, setSettings, toast } = usePanel();
    const [checking, setChecking] = useState(false);
    const [installing, setInstalling] = useState(false);
    const [log, setLog] = useState<string | null>(null);
    const imageNodes = useMemo(() => {
        const wf = settings?.comfyui.customWorkflow as Record<string, { class_type?: string; inputs?: Record<string, unknown>; _meta?: { title?: string } }> | null;
        if (!wf) return [];
        return Object.entries(wf)
            .filter(([, n]) => /LoadImage/i.test(n.class_type ?? "") && typeof n.inputs?.image === "string")
            .map(([id, n]) => ({ value: id, label: `#${id} ${n._meta?.title ?? n.class_type}` }));
    }, [settings?.comfyui.customWorkflow]);

    if (!settings) return <div className="p-4 text-xs text-muted-foreground">Loading settings…</div>;
    const set = (patch: DeepPartial<Settings>) => void run(async () => setSettings(await bridge().call("settings.update", patch)));
    const m = settings.meshy;
    const t = settings.tripo;
    const h = settings.hitem3d;
    const c = settings.comfyui;

    return (
        <div className="p-2 space-y-2" data-testid="settings">
            <Section title="Meshy" defaultOpen={settings.defaultProvider === "meshy"} right={settings.secrets["meshy.apiKey"].set ? <Badge tone="success">Ready</Badge> : <Badge tone="warning">No key</Badge>}>
                <SecretField label="API key" secretKey="meshy.apiKey" settings={settings} placeholder="msy_…" hint={<>From <Link href="https://www.meshy.ai/settings/api">meshy.ai → Settings → API</Link>. Stored encrypted by the OS.</>} />
                <Field label="AI model">
                    <ModelSelect value={m.aiModel} known={MESHY_AI_MODELS} onChange={(v) => set({ meshy: { aiModel: v } })} />
                </Field>
                <div className="grid grid-cols-2 gap-2">
                    <Field label="Geometry detail">
                        <Select value={m.geometryResolution} options={["standard", "2k", "4k"] as const} onChange={(v) => set({ meshy: { geometryResolution: v } })} />
                    </Field>
                    <Field label="Texture size">
                        <Select value={m.textureResolution} options={["2k", "4k", "8k"] as const} onChange={(v) => set({ meshy: { textureResolution: v } })} />
                    </Field>
                </div>
                <Toggle label="Texture the model" checked={m.shouldTexture} onChange={(v) => set({ meshy: { shouldTexture: v } })} />
                <Toggle label="PBR maps (metallic, roughness, normal)" checked={m.enablePbr} onChange={(v) => set({ meshy: { enablePbr: v } })} />
                <Toggle label="Remove lighting from the photo (meshy-6)" checked={m.removeLighting} onChange={(v) => set({ meshy: { removeLighting: v } })} />
                <Toggle label="Enhance the input image" checked={m.imageEnhancement} onChange={(v) => set({ meshy: { imageEnhancement: v } })} />
                <Toggle label="Remesh" hint="Clean topology at a target polycount." checked={m.shouldRemesh} onChange={(v) => set({ meshy: { shouldRemesh: v } })} />
                {m.shouldRemesh && (
                    <div className="grid grid-cols-2 gap-2">
                        <Field label="Topology">
                            <Select value={m.topology} options={["triangle", "quad"] as const} onChange={(v) => set({ meshy: { topology: v } })} />
                        </Field>
                        <Field label="Target polycount" hint="0 = Meshy default">
                            <CommitInput type="number" value={m.targetPolycount} min={0} max={300000} onCommit={(v) => set({ meshy: { targetPolycount: Number(v) } })} />
                        </Field>
                    </div>
                )}
                <Field label="API address">
                    <CommitInput value={m.baseUrl} onCommit={(v) => set({ meshy: { baseUrl: v } })} />
                </Field>
                <TestButton providerId="meshy" />
            </Section>

            <Section title="Tripo" defaultOpen={settings.defaultProvider === "tripo"} right={settings.secrets["tripo.apiKey"].set ? <Badge tone="success">Ready</Badge> : <Badge tone="warning">No key</Badge>}>
                <SecretField label="API key" secretKey="tripo.apiKey" settings={settings} placeholder="tsk_…" hint={<>From <Link href="https://platform.tripo3d.ai/api-keys">platform.tripo3d.ai → API keys</Link>. Uses Tripo API v3.</>} />
                <Field label="Model version">
                    <ModelSelect value={t.model} known={TRIPO_MODEL_VERSIONS} onChange={(v) => set({ tripo: { model: v } })} />
                </Field>
                <div className="grid grid-cols-2 gap-2">
                    <Field label="Texture quality">
                        <Select value={t.textureQuality} options={["standard", "detailed", "extreme"] as const} onChange={(v) => set({ tripo: { textureQuality: v } })} />
                    </Field>
                    <Field label="Geometry quality">
                        <Select value={t.geometryQuality} options={["standard", "detailed"] as const} onChange={(v) => set({ tripo: { geometryQuality: v } })} />
                    </Field>
                </div>
                <Toggle label="Texture" checked={t.texture} onChange={(v) => set({ tripo: { texture: v } })} />
                <Toggle label="PBR materials" checked={t.pbr} onChange={(v) => set({ tripo: { pbr: v } })} />
                <Toggle label="Smart low-poly" checked={t.smartLowPoly} onChange={(v) => set({ tripo: { smartLowPoly: v } })} />
                <Toggle label="Real-world size (auto size)" checked={t.autoSize} onChange={(v) => set({ tripo: { autoSize: v } })} />
                <div className="grid grid-cols-2 gap-2">
                    <Field label="Face limit" hint="0 = Tripo default">
                        <CommitInput type="number" value={t.faceLimit} min={0} onCommit={(v) => set({ tripo: { faceLimit: Number(v) } })} />
                    </Field>
                    <Field label="Orientation">
                        <Select value={t.orientation} options={[{ value: "default", label: "Default" }, { value: "align_image", label: "Align to image" }] as const} onChange={(v) => set({ tripo: { orientation: v } })} />
                    </Field>
                </div>
                <Field label="API address">
                    <CommitInput value={t.baseUrl} onCommit={(v) => set({ tripo: { baseUrl: v } })} />
                </Field>
                <TestButton providerId="tripo" />
            </Section>

            <Section title="Hitem3D (hi3d.ai)" defaultOpen={settings.defaultProvider === "hitem3d"} right={settings.secrets["hitem3d.accessKey"].set ? <Badge tone="success">Ready</Badge> : <Badge tone="warning">No key</Badge>}>
                <SecretField label="Access Key (or AK:SK, or a token)" secretKey="hitem3d.accessKey" settings={settings} hint={<>From <Link href="https://www.hitem3d.ai">hitem3d.ai</Link> → API. The plugin signs in and refreshes the token itself.</>} />
                <SecretField label="Secret Key" secretKey="hitem3d.secretKey" settings={settings} />
                <Field label="App ID (optional)">
                    <CommitInput value={h.appId} onCommit={(v) => set({ hitem3d: { appId: v } })} />
                </Field>
                <div className="grid grid-cols-2 gap-2">
                    <Field label="Model">
                        <Select value={h.model} options={HITEM3D_MODELS} onChange={(v) => set({ hitem3d: { model: v } })} />
                    </Field>
                    <Field label="Resolution">
                        <Select value={h.resolution} options={HITEM3D_RESOLUTIONS[h.model] ?? [h.resolution]} onChange={(v) => set({ hitem3d: { resolution: v } })} />
                    </Field>
                </div>
                <Field label="Output">
                    <Select value={h.requestType} options={[{ value: "3", label: "Geometry + texture" }, { value: "1", label: "Geometry only" }] as const} onChange={(v) => set({ hitem3d: { requestType: v } })} />
                </Field>
                <Field label="Face count" hint="0 = Hitem3D default; otherwise 100,000 – 5,000,000">
                    <CommitInput type="number" value={h.face} min={0} max={5000000} onCommit={(v) => set({ hitem3d: { face: Number(v) } })} />
                </Field>
                {hitem3dSupportsPbr(h.model) && <Toggle label="PBR materials" checked={h.pbr} onChange={(v) => set({ hitem3d: { pbr: v } })} />}
                <Toggle label="Remove background on Hitem3D" checked={h.removeBackground} onChange={(v) => set({ hitem3d: { removeBackground: v } })} />
                <Field label="API address">
                    <CommitInput value={h.baseUrl} onCommit={(v) => set({ hitem3d: { baseUrl: v } })} />
                </Field>
                <TestButton providerId="hitem3d" />
            </Section>

            <Section title="ComfyUI (local)" defaultOpen={settings.defaultProvider === "comfyui"}>
                <Field label="Server address" hint="Your ComfyUI, e.g. http://127.0.0.1:8188 or a LAN machine.">
                    <CommitInput value={c.url} onCommit={(v) => set({ comfyui: { url: v } })} />
                </Field>
                <Field label="Workflow">
                    <Select
                        value={c.workflow}
                        options={[
                            { value: "trellis2", label: "TRELLIS.2 image → 3D (built in)" },
                            { value: "custom", label: `Custom workflow${c.customWorkflowName ? `: ${c.customWorkflowName}` : ""}` },
                        ]}
                        onChange={(v) => set({ comfyui: { workflow: v } })}
                    />
                </Field>
                {c.workflow === "trellis2" ? (
                    <>
                        <Field label="Object mask">
                            <Select
                                value={c.removeBackground ? "always" : "auto"}
                                options={[
                                    { value: "auto", label: "Use layer transparency (BiRefNet if opaque)" },
                                    { value: "always", label: "Always remove background (BiRefNet)" },
                                ]}
                                onChange={(v) => set({ comfyui: { removeBackground: v === "always" } })}
                            />
                        </Field>
                        <div className="grid grid-cols-2 gap-2">
                            <Field label="Texture size">
                                <Select value={String(c.textureSize)} options={["1024", "2048", "4096"]} onChange={(v) => set({ comfyui: { textureSize: Number(v) } })} />
                            </Field>
                            <Field label="Max faces">
                                <CommitInput type="number" value={c.faceCount} onCommit={(v) => set({ comfyui: { faceCount: Number(v) } })} />
                            </Field>
                        </div>
                        <p className="text-[10px] text-muted-foreground leading-snug">
                            Needs ComfyUI with TRELLIS.2 models (trellis_2_int8_convrot, trellis_2 shape/texture VAEs, dino_v3_L_naf, birefnet). "Test connection" checks them. About 4–5 min per model on an RTX 3090.
                        </p>
                    </>
                ) : (
                    <>
                        <div className="flex gap-1 items-center">
                            <Button size="sm" icon={<FileJson size={11} />} onClick={() => void run(async () => {
                                const s = await bridge().call("settings.pickWorkflow");
                                if (s) {
                                    setSettings(s);
                                    toast("success", `Workflow "${s.comfyui.customWorkflowName}" loaded`);
                                }
                            })}>
                                Choose API workflow…
                            </Button>
                            <span className="text-[10px] text-muted-foreground truncate">{c.customWorkflowName || "none"}</span>
                        </div>
                        <p className="text-[10px] text-muted-foreground leading-snug">In ComfyUI use Workflow → Export (API). It needs a Load Image node (gets the layer) and a node that saves a .glb (e.g. Save GLB).</p>
                        {imageNodes.length > 1 && (
                            <Field label="Image goes into">
                                <Select value={c.imageNodeId || ""} options={[{ value: "", label: "Automatic" }, ...imageNodes]} onChange={(v) => set({ comfyui: { imageNodeId: v } })} />
                            </Field>
                        )}
                    </>
                )}
                <div className="grid grid-cols-2 gap-2">
                    <Field label="Seed" hint="-1 = random">
                        <CommitInput type="number" value={c.seed} onCommit={(v) => set({ comfyui: { seed: Number(v) } })} />
                    </Field>
                    <Field label="Timeout (min)">
                        <CommitInput type="number" value={c.timeoutMinutes} onCommit={(v) => set({ comfyui: { timeoutMinutes: Number(v) } })} />
                    </Field>
                </div>
                <TestButton providerId="comfyui" />
            </Section>

            <Section title="Generation">
                <Field label="Default service">
                    <Select value={settings.defaultProvider} options={PROVIDER_IDS.map((id) => ({ value: id, label: PROVIDER_LABELS[id] }))} onChange={(v) => set({ defaultProvider: v })} />
                </Field>
                <Field label="Max image size sent" hint="Longest side in pixels; bigger layers are scaled down before upload.">
                    <Select value={String(settings.send.maxEdge)} options={["1024", "1536", "2048", "3072", "4096"]} onChange={(v) => set({ send: { maxEdge: Number(v) } })} />
                </Field>
            </Section>

            <Section title="3D editor">
                <Field label="Default export resolution">
                    <Select value={String(settings.editor.defaultResolution)} options={["1024", "2048", "3072", "4096"]} onChange={(v) => set({ editor: { defaultResolution: Number(v) } })} />
                </Field>
                <Toggle label="Double-click a 3D layer to open the 3D editor" hint="Photoshop opens the smart object, the plugin closes it and shows the editor. Turn off to edit the .psb contents instead." checked={settings.editor.interceptDoubleClick} onChange={(v) => set({ editor: { interceptDoubleClick: v } })} />
                <Toggle label="Remember lighting for new models" checked={settings.editor.rememberLighting} onChange={(v) => set({ editor: { rememberLighting: v } })} />
                <Button size="sm" icon={<RotateCcw size={11} />} onClick={() => set({ editor: { lighting: DEFAULT_LIGHTING } })}>
                    Reset remembered lighting
                </Button>
            </Section>

            <Section title="Library">
                <Toggle label="Render previews for models without one" checked={settings.library.autoThumbnails} onChange={(v) => set({ library: { autoThumbnails: v } })} />
                <div className="text-[10px] text-muted-foreground break-all select-text">{info?.libraryFolder}</div>
                <Button size="sm" icon={<FolderOpen size={11} />} onClick={() => void run(() => bridge().call("library.revealFolder"))}>
                    Show library folder
                </Button>
            </Section>

            <Section title="Updates" right={update?.available ? <Badge tone="info">v{update.latestVersion}</Badge> : undefined}>
                <div className="text-xs">
                    Installed: <b>{info?.pluginVersion}</b>
                    {update && !update.error && (update.available ? <> · Latest: <b>{update.latestVersion}</b></> : <span className="text-muted-foreground"> · up to date</span>)}
                </div>
                {update?.error && <div className="text-[10px] text-danger">{update.error}</div>}
                {update?.available && update.releaseNotes && <pre className="text-[10px] text-muted-foreground whitespace-pre-wrap max-h-32 overflow-auto bg-input p-2 rounded select-text">{update.releaseNotes}</pre>}
                <div className="flex gap-1 flex-wrap">
                    <Button size="sm" busy={checking} icon={<RefreshCw size={11} />} onClick={async () => {
                        setChecking(true);
                        const u = await run(() => bridge().call("update.check", { force: true }));
                        if (u) setUpdate(u);
                        setChecking(false);
                    }}>
                        Check now
                    </Button>
                    {update?.available && (
                        <Button size="sm" variant="primary" busy={installing} icon={<Download size={11} />} onClick={async () => {
                            setInstalling(true);
                            const r = await run(() => bridge().call("update.install"));
                            if (r) toast(r.started ? "success" : "info", r.message);
                            setInstalling(false);
                        }}>
                            Install v{update.latestVersion}
                        </Button>
                    )}
                    {update?.releaseUrl && (
                        <Button size="sm" variant="ghost" icon={<ExternalLink size={11} />} onClick={() => void bridge().call("shell.openExternal", { url: update.releaseUrl! })}>
                            Release notes
                        </Button>
                    )}
                </div>
                <Toggle label={`Check automatically (every ${settings.updates.checkIntervalHours} h)`} checked={settings.updates.autoCheck} onChange={(v) => set({ updates: { autoCheck: v } })} />
                <Toggle label="Include pre-releases" checked={settings.updates.includePrerelease} onChange={(v) => set({ updates: { includePrerelease: v } })} />
                <Field label="Release repository">
                    <CommitInput value={settings.updates.repo} onCommit={(v) => set({ updates: { repo: v } })} />
                </Field>
            </Section>

            <Section title="Diagnostics" defaultOpen={false}>
                <table className="text-[10px] w-full select-text">
                    <tbody>
                        {info &&
                            ([
                                ["Plugin", `${info.pluginId} ${info.pluginVersion}`],
                                ["Build", info.buildStamp],
                                ["Host", `${info.hostName} ${info.hostVersion}`],
                                ["UXP", info.uxpVersion],
                                ["Platform", info.platform],
                                ["API keys", info.secretStorage === "secureStorage" ? "OS-encrypted secure storage" : info.secretStorage],
                                ["Data folder", info.dataFolder],
                                ["Log file", info.logFile],
                            ] as const).map(([k, v]) => (
                                <tr key={k}>
                                    <td className="text-muted-foreground pr-2 align-top whitespace-nowrap">{k}</td>
                                    <td className="break-all">{v}</td>
                                </tr>
                            ))}
                    </tbody>
                </table>
                <div className="flex gap-1 flex-wrap">
                    <Button size="sm" icon={<ScrollText size={11} />} onClick={async () => setLog((await run(() => bridge().call("log.tail", { lines: 200 }))) ?? null)}>
                        Show recent log
                    </Button>
                    <Button size="sm" icon={<FolderOpen size={11} />} onClick={() => void run(() => bridge().call("log.reveal"))}>
                        Open log folder
                    </Button>
                    <Button size="sm" variant="ghost" icon={<RotateCcw size={11} />} onClick={() => void run(async () => setSettings(await bridge().call("settings.reset")), "Settings reset (API keys kept)")}>
                        Reset settings
                    </Button>
                </div>
                {log !== null && <pre className="text-[9px] leading-tight whitespace-pre-wrap break-all max-h-64 overflow-auto bg-input p-2 rounded select-text font-mono">{log || "(empty)"}</pre>}
            </Section>

            <div className="text-[10px] text-muted-foreground text-center py-2 space-x-2">
                <span>Geekatplay 3D Layers</span>
                {info && (
                    <>
                        <Link href={info.repoUrl}>GitHub</Link>
                        <Link href={`${info.repoUrl}#readme`}>Docs</Link>
                        <Link href={`${info.repoUrl}/issues`}>Report a problem</Link>
                    </>
                )}
            </div>
        </div>
    );
}
