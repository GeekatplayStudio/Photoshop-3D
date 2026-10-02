/**
 * A fake UXP host for running the UI in a normal browser (`npm run dev:web`) and in
 * Playwright tests. It implements the same HostApi with in-memory state and the
 * sample model in tests/fixtures/public/samples. Nothing here ships in the plugin's
 * behaviour: inside Photoshop window.uxpHost exists and this module is never loaded.
 */
import type { EditorInit, EditorResult, HostApi, HostEventName, HostMethod, RequestMessage } from "@shared/protocol";
import { DEFAULT_SETTINGS, SECRET_KEYS, mergeSettings, secretPreview, type PublicSettings, type SecretKey, type Settings } from "@shared/settings";
import { settingsForNewModel } from "@shared/threeD";
import { PROVIDER_IDS, PROVIDER_LABELS, type AppInfo, type Job, type LibraryItem, type ProviderId, type PsContext, type RemoteItem } from "@shared/types";
import type { Transport } from "./client";

type Handler = (params: unknown) => unknown;

declare global {
    interface Window {
        /** Last editor result, for tests. */
        __ps3dEditorResult?: EditorResult | null;
    }
}

export function createMockTransport(): Transport {
    const listeners: ((m: unknown) => void)[] = [];
    const emit = (name: HostEventName, data: unknown) => listeners.forEach((fn) => fn({ t: "evt", name, data }));

    let settings: Settings = mergeSettings(DEFAULT_SETTINGS, {});
    const secrets: Partial<Record<SecretKey, string>> = { "meshy.apiKey": "msy_mock_key_1234" };
    const publicSettings = (): PublicSettings => ({
        ...settings,
        secrets: Object.fromEntries(SECRET_KEYS.map((k) => [k, { set: !!secrets[k], preview: secretPreview(secrets[k] ?? "") }])) as PublicSettings["secrets"],
    });

    const now = Date.now();
    let library: LibraryItem[] = [
        { id: "lib_totem", name: "Totem (sample)", origin: "local", modelFile: "samples/totem.glb", format: "glb", sizeBytes: 6880, createdAt: now - 86_400_000, importedAt: now - 86_400_000 },
        { id: "lib_totem2", name: "Meshy totem", origin: "meshy", remoteId: "018f-mock", modelFile: "samples/totem.glb", thumbFile: "samples/totem-thumb.png", format: "glb", sizeBytes: 6880, createdAt: now - 3_600_000, importedAt: now - 3_600_000, favorite: true },
    ];
    let jobs: Job[] = [];
    const ctx: PsContext = { hasDocument: true, docId: 1, docTitle: "Mock.psd", docWidth: 1920, docHeight: 1080, layerId: 2, layerName: "Chair", layerKind: "pixel", hasSelection: false, is3DLayer: false };

    const info: AppInfo = {
        pluginId: "com.geekatplay.photoshop3d",
        pluginVersion: "0.0.0-dev",
        hostName: "Browser (mock host)",
        hostVersion: "-",
        uxpVersion: "-",
        platform: navigator.platform,
        dataFolder: "(mock)",
        libraryFolder: "(mock)/library",
        logFile: "(mock)/logs/photoshop3d.log",
        libraryBaseUrl: "./",
        repoUrl: "https://github.com/GeekatplayStudio/Photoshop-3D",
        theme: "dark",
        credentialsFile: "(mock)/credentials.json",
        buildStamp: "dev",
    };

    const editorInit = (libraryId: string): EditorInit => {
        const item = library.find((i) => i.id === libraryId) ?? library[0];
        // ?mode=update and ?name=… let the docs screenshots show the re-pose dialog.
        const query = new URLSearchParams(location.search);
        return {
            mode: query.get("mode") === "update" ? "update" : "new",
            model: { libraryId: item.id, name: query.get("name") ?? item.name, url: `./${item.modelFile}`, file: item.modelFile, sizeBytes: item.sizeBytes },
            settings: settingsForNewModel(settings.editor.lighting, 1024),
            lighting: settings.editor.lighting,
            rememberLighting: true,
            document: { title: "Mock.psd", width: 1920, height: 1080 },
        };
    };

    const runJob = (job: Job) => {
        const timer = setInterval(() => {
            job.progress = Math.min(100, job.progress + 20);
            job.status = job.progress >= 100 ? "succeeded" : "running";
            job.message = job.progress >= 100 ? "Ready in library" : `${PROVIDER_LABELS[job.providerId]} is generating`;
            job.updatedAt = Date.now();
            if (job.status === "succeeded") {
                clearInterval(timer);
                const item: LibraryItem = { ...library[0], id: `lib_${job.id}`, name: job.name, origin: job.providerId, remoteId: job.remoteId, importedAt: Date.now() };
                library = [item, ...library];
                job.libraryId = item.id;
                emit("library.changed", library);
            }
            emit("jobs.changed", [...jobs]);
        }, 700);
    };

    const handlers: { [M in HostMethod]?: (p: HostApi[M][0]) => HostApi[M][1] | Promise<HostApi[M][1]> } = {
        "app.info": () => info,
        "settings.get": () => publicSettings(),
        "settings.update": (patch) => {
            settings = mergeSettings(settings, patch);
            emit("settings.changed", publicSettings());
            return publicSettings();
        },
        "settings.setSecret": ({ key, value }) => {
            secrets[key] = value;
            return publicSettings();
        },
        "settings.reset": () => {
            settings = mergeSettings(DEFAULT_SETTINGS, {});
            return publicSettings();
        },
        "settings.pickWorkflow": () => null,
        "providers.status": () =>
            PROVIDER_IDS.map((id) => ({
                id,
                label: PROVIDER_LABELS[id],
                configured: id === "comfyui" || !!secrets[(id === "hitem3d" ? "hitem3d.accessKey" : `${id}.apiKey`) as SecretKey],
                hint: id === "comfyui" ? undefined : "Add your API key in Settings.",
                capabilities: { generate: true, browse: true, cancel: id !== "tripo" },
            })),
        "providers.test": ({ providerId }) => ({ ok: true, message: `Connected to ${PROVIDER_LABELS[providerId]}.`, balance: "1000 credits" }),
        "ps.context": () => ctx,
        "ps.sourcePreview": () => ({ dataUrl: "./samples/totem-thumb.png", width: 256, height: 256, label: "Chair" }),
        "generate.start": ({ providerId, name }) => {
            const job: Job = {
                id: `job_${Date.now().toString(36)}`,
                providerId,
                remoteId: `mock-${Math.random().toString(36).slice(2, 8)}`,
                name: name || "Chair",
                status: "running",
                progress: 0,
                message: "Submitted",
                createdAt: Date.now(),
                updatedAt: Date.now(),
                sourcePreview: "./samples/totem-thumb.png",
            };
            jobs = [job, ...jobs];
            emit("jobs.changed", [...jobs]);
            runJob(job);
            return job;
        },
        "jobs.list": () => jobs,
        "jobs.cancel": ({ id }) => {
            const j = jobs.find((x) => x.id === id)!;
            j.status = "cancelled";
            emit("jobs.changed", [...jobs]);
            return j;
        },
        "jobs.retry": ({ id }) => jobs.find((x) => x.id === id)!,
        "jobs.dismiss": ({ id }) => {
            jobs = jobs.filter((j) => j.id !== id);
            emit("jobs.changed", [...jobs]);
        },
        "jobs.recover": ({ providerId, remoteId }) => {
            const job: Job = { id: `job_${Date.now().toString(36)}`, providerId, remoteId, name: `Task ${remoteId}`, status: "running", progress: 0, createdAt: Date.now(), updatedAt: Date.now() };
            jobs = [job, ...jobs];
            runJob(job);
            return job;
        },
        "remote.list": ({ providerId, page }) => {
            const items: RemoteItem[] = Array.from({ length: 6 }, (_, i) => ({
                providerId: providerId as ProviderId,
                remoteId: `${providerId}-${page}-${i}`,
                name: `${PROVIDER_LABELS[providerId]} model ${(page - 1) * 6 + i + 1}`,
                status: i === 4 ? "running" : i === 5 ? "failed" : "succeeded",
                progress: i === 4 ? 40 : undefined,
                createdAt: Date.now() - i * 3_600_000,
                thumbnailUrl: i % 2 ? "./samples/totem-thumb.png" : undefined,
                hasModel: i < 4,
                libraryId: i === 0 ? "lib_totem2" : undefined,
            }));
            return { items, page, hasMore: page < 3, notice: providerId === "hitem3d" ? "Mock: Hitem3D has no list API." : undefined };
        },
        "remote.import": ({ providerId, remoteId, name }) => {
            const item: LibraryItem = { ...library[0], id: `lib_${remoteId}`, name: name ?? remoteId, origin: providerId, remoteId, importedAt: Date.now() };
            library = [item, ...library];
            emit("library.changed", library);
            return item;
        },
        "library.list": () => library,
        "library.update": ({ id, name, favorite }) => {
            const item = library.find((i) => i.id === id)!;
            if (name) item.name = name;
            if (favorite !== undefined) item.favorite = favorite;
            emit("library.changed", [...library]);
            return item;
        },
        "library.remove": ({ id }) => {
            library = library.filter((i) => i.id !== id);
            emit("library.changed", library);
        },
        "library.importFile": () => null,
        "library.saveThumbnail": ({ id, pngBase64 }) => {
            const item = library.find((i) => i.id === id)!;
            item.thumbFile = `data:image/png;base64,${pngBase64}`;
            emit("library.changed", [...library]);
            return item;
        },
        "library.readFile": async ({ file }) => {
            const buf = new Uint8Array(await (await fetch(`./${file}`)).arrayBuffer());
            let s = "";
            for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
            return { base64: btoa(s) };
        },
        "library.revealFolder": () => undefined,
        "editor.placeModel": ({ libraryId }) => {
            window.open(`./editor.html?model=${encodeURIComponent(libraryId)}`, "_blank", "width=1200,height=800");
            return null;
        },
        "editor.editActiveLayer": () => null,
        "layer.state": () => null,
        "layer.detach3D": () => undefined,
        "editor.getInit": () => editorInit(new URLSearchParams(location.search).get("model") ?? "lib_totem"),
        "editor.complete": (result) => {
            window.__ps3dEditorResult = result;
        },
        "editor.cancel": () => {
            window.__ps3dEditorResult = null;
        },
        "editor.rememberLighting": (lighting) => {
            settings = mergeSettings(settings, { editor: { lighting } });
        },
        "update.check": () => ({ currentVersion: "0.0.0-dev", latestVersion: "0.1.0", available: true, releaseName: "v0.1.0", releaseNotes: "Mock release notes", releaseUrl: "https://github.com/GeekatplayStudio/Photoshop-3D/releases", checkedAt: Date.now() }),
        "update.install": () => ({ started: false, message: "Mock host: nothing to install." }),
        "update.skip": () => undefined,
        "shell.openExternal": ({ url }) => {
            window.open(url, "_blank");
        },
        "clipboard.readText": () => navigator.clipboard.readText(),
        "log.write": ({ level, message, data }) => {
            console[level === "debug" ? "log" : level](`[mock host] ${message}`, data ?? "");
        },
        "log.tail": () => "mock log line 1\nmock log line 2",
        "log.reveal": () => undefined,
    };

    return {
        send(message) {
            const req = message as RequestMessage;
            const handler = handlers[req.method] as Handler | undefined;
            setTimeout(async () => {
                try {
                    if (!handler) throw new Error(`Mock host has no ${req.method}`);
                    const result = await handler(req.params);
                    listeners.forEach((fn) => fn({ t: "res", id: req.id, ok: true, result: result ?? null }));
                } catch (err) {
                    listeners.forEach((fn) => fn({ t: "res", id: req.id, ok: false, error: { message: (err as Error).message } }));
                }
            }, 30);
        },
        onMessage(fn) {
            listeners.push(fn);
        },
    };
}
