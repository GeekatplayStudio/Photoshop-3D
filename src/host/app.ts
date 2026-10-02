/**
 * Composition root of the UXP host: builds every service and maps each bridge method
 * (src/shared/protocol.ts HostApi) to them. Photoshop-facing code lives in ./ps,
 * services in ./services, providers in ./providers — this file only wires them.
 */
import { shell, storage, host as uxpHost, versions } from "uxp";
import { platform } from "os";
import { base64ToBytes, bytesToBase64, slug } from "@shared/bytes";
import type { EditorInit, EditorResult, HostEventName, HostEvents } from "@shared/protocol";
import { settingsForNewModel, lightingOf } from "@shared/threeD";
import { PROVIDER_IDS, type AppInfo, type LayerState, type LibraryItem, type PlaceResult, type ProviderStatus } from "@shared/types";
import { BridgeServer, type Handlers } from "./bridge/server";
import { EditorDialog } from "./editor/dialog";
import { UxpFileStore, joinPath } from "./platform/fileStore";
import { FileLogger, LOG_FILE } from "./platform/logger";
import { FileSecretStore, UxpSecretStore, type SecretStore } from "./platform/secrets";
import { getProvider } from "./providers/registry";
import { imageNodeCandidates, isApiWorkflow, isUiWorkflow } from "./providers/comfyWorkflows";
import type { ProviderContext } from "./providers/types";
import { listenForContextChanges, listenForEditContents } from "./ps/events";
import { closeWithoutSaving, detach3D, documentInfo, getContext, placeRender, readLayerState, replaceRender, type RenderFile } from "./ps/layers";
import { app as psApp } from "./ps/photoshop";
import { readSource } from "./ps/pixels";
import { BrowseService } from "./services/browse";
import { TaskHistory } from "./services/history";
import { JobManager } from "./services/jobs";
import { LIBRARY_DIR, Library } from "./services/library";
import { SettingsService } from "./services/settingsService";
import { Updater } from "./services/updater";
import { copyTree, ensureWebAssets } from "./services/webAssets";
import { SHARED_SEGMENTS, appDataRoot, toBrowserFileUrl, toUxpFileUrl } from "./platform/sharedFolder";

export const PLUGIN_ID = "com.geekatplay.photoshop3d";
export const REPO_URL = "https://github.com/GeekatplayStudio/Photoshop-3D";

type BuildInfo = { version: string; stamp: string; builtAt: string };

export type App = Awaited<ReturnType<typeof startApp>>;

function currentTheme(): string {
    try {
        return (document as unknown as { theme?: { getCurrent(): string } }).theme?.getCurrent() ?? "dark";
    } catch {
        return "dark";
    }
}

/** Opens (creating if needed) the shared user-data folder; null when it cannot be used. */
async function openSharedStore(dataFolder: UxpFolder): Promise<UxpFileStore | null> {
    const lfs = storage.localFileSystem;
    const root = appDataRoot(dataFolder.nativePath);
    if (!root) return null;
    let folder = (await lfs.getEntryWithUrl(toUxpFileUrl(root))) as UxpFolder;
    for (const seg of SHARED_SEGMENTS) {
        let next: UxpEntry | null = null;
        try {
            next = await folder.getEntry(seg);
        } catch {
            next = null;
        }
        folder = (next && next.isFolder ? next : await folder.createFolder(seg)) as UxpFolder;
    }
    const store = new UxpFileStore(folder, storage.formats, lfs);
    await store.writeText(".write-test", "ok");
    await store.remove(".write-test");
    return store;
}

/** Copies data an earlier build kept in the UXP data folder into the shared folder (once). */
async function migrateFromDataFolder(dataStore: UxpFileStore, sharedStore: UxpFileStore, log: FileLogger) {
    if (await sharedStore.exists("settings.json")) return;
    let copied = 0;
    for (const file of ["settings.json", "jobs.json", "history.json", "secrets.json"]) {
        const text = await dataStore.readText(file);
        if (text != null) {
            await sharedStore.writeText(file, text);
            copied++;
        }
    }
    if (await dataStore.exists(LIBRARY_DIR)) copied += await copyTree(dataStore, sharedStore, LIBRARY_DIR);
    if (copied) log.info(`Moved ${copied} files from the UXP data folder to ${sharedStore.rootPath}`);
}

export async function startApp() {
    const lfs = storage.localFileSystem;
    const dataFolder = await lfs.getDataFolder();
    const uxpDataStore = new UxpFileStore(dataFolder, storage.formats, lfs);
    const pluginStore = new UxpFileStore(await lfs.getPluginFolder(), storage.formats);
    const tempStore = new UxpFileStore(await lfs.getTemporaryFolder(), storage.formats, lfs);

    let sharedError: unknown = null;
    let dataStore: UxpFileStore = uxpDataStore;
    try {
        const shared = await openSharedStore(dataFolder);
        if (shared) dataStore = shared;
    } catch (err) {
        sharedError = err;
    }

    const log = new FileLogger(dataStore);
    await log.init();
    const build: BuildInfo = JSON.parse((await pluginStore.readText("build-info.json")) ?? '{"version":"0.0.0","stamp":"dev","builtAt":""}');
    log.info(`Geekatplay 3D Layers ${build.version} (${build.stamp}) starting in ${uxpHost.name} ${uxpHost.version}, UXP ${versions.uxp}, ${platform()}`);
    if (dataStore === uxpDataStore) log.warn("Using the UXP data folder for user data (it is erased when the plugin is uninstalled)", sharedError ?? "unexpected data folder layout");
    else {
        log.info(`User data folder: ${dataStore.rootPath}`);
        await migrateFromDataFolder(uxpDataStore, dataStore, log).catch((err) => log.warn("Migration from the UXP data folder failed", err));
    }

    let secrets: SecretStore;
    try {
        secrets = new UxpSecretStore(storage.secureStorage);
        await secrets.get("meshy.apiKey");
    } catch (err) {
        log.warn("secureStorage unavailable; API keys fall back to secrets.json in the data folder", err);
        secrets = new FileSecretStore(dataStore);
    }

    const settings = new SettingsService(dataStore, secrets, log);
    await settings.load();
    const library = new Library(dataStore, log);
    await library.load();
    const history = new TaskHistory(dataStore);
    const context = (): ProviderContext => ({ fetch: (u, i) => fetch(u, i), settings: settings.value, secret: (k) => settings.secret(k), log, store: dataStore });
    const jobs = new JobManager({ store: dataStore, log, library, history, fetch: (u, i) => fetch(u, i), provider: getProvider, context });
    await jobs.load();
    const browse = new BrowseService({ library, history, log, fetch: (u, i) => fetch(u, i), provider: getProvider, context });
    const updater = new Updater({
        fetch: (u, i) => fetch(u, i),
        log,
        settings,
        currentVersion: build.version,
        saveTemp: async (name, bytes) => {
            const path = joinPath("updates", name);
            await tempStore.writeBytes(path, bytes);
            return tempStore.nativePath(path);
        },
        openPath: async (path) => {
            await shell.openPath(path, "Install the Geekatplay 3D Layers update with Creative Cloud");
        },
    });

    // The UI copy must sit in the UXP data folder: WebViews can only load plugin-data: pages.
    const web = await ensureWebAssets(pluginStore, uxpDataStore, build.stamp, log);
    // Lets the WebView check that it can read library files directly (see web/three/modelSource.ts).
    await dataStore.writeText(joinPath(LIBRARY_DIR, ".reachable"), "ok").catch(() => undefined);
    const libraryBaseUrl = dataStore === uxpDataStore ? (web.directLibrary ? "../library/" : null) : `${toBrowserFileUrl(dataStore.nativePath(LIBRARY_DIR))}/`;

    /* ------------------------------------------------------------ bridges */

    const bridges = new Map<string, BridgeServer>(); // "panel" | "editor"
    const emit = <E extends HostEventName>(name: E, data: HostEvents[E]) => {
        for (const b of bridges.values()) b.emit(name, data);
    };

    const editor = new EditorDialog({
        log,
        webBase: web.webBase,
        attach: (webview) => {
            const server = new BridgeServer("editor", webview, handlers, log);
            bridges.set("editor", server);
            return () => {
                server.close();
                if (bridges.get("editor") === server) bridges.delete("editor");
            };
        },
    });

    window.addEventListener("message", (event: MessageEvent) => {
        const origin = String((event as MessageEvent).origin ?? "");
        const target = origin.includes("editor.html") ? bridges.get("editor") : bridges.get("panel");
        void target?.handle(event.data);
    });

    /* ------------------------------------------------------- helpers */

    const appInfo = (): AppInfo => ({
        pluginId: PLUGIN_ID,
        pluginVersion: build.version,
        hostName: uxpHost.name,
        hostVersion: uxpHost.version,
        uxpVersion: versions.uxp,
        platform: platform(),
        dataFolder: dataStore.rootPath,
        libraryFolder: dataStore.nativePath(LIBRARY_DIR),
        logFile: dataStore.nativePath(LOG_FILE),
        libraryBaseUrl,
        repoUrl: REPO_URL,
        theme: currentTheme(),
        secretStorage: secrets.kind,
        buildStamp: build.stamp,
    });

    const modelInit = (item: LibraryItem) => ({
        libraryId: item.id,
        name: item.name,
        url: libraryBaseUrl ? `${libraryBaseUrl}${item.modelFile}` : null,
        file: item.modelFile,
        sizeBytes: item.sizeBytes,
    });

    async function writeRender(result: EditorResult, modelName: string): Promise<{ render: RenderFile; cleanup: () => Promise<void> }> {
        const dir = joinPath("renders", Date.now().toString(36));
        const path = joinPath(dir, `${slug(modelName)}-3d.png`);
        await tempStore.writeBytes(path, base64ToBytes(result.pngBase64));
        const token = await tempStore.sessionToken!(path);
        return {
            render: { token, width: result.width, height: result.height, contentBounds: result.contentBounds },
            cleanup: () => tempStore.remove(dir).catch(() => undefined),
        };
    }

    const stateFor = (item: LibraryItem, result: EditorResult): LayerState => ({
        v: 1,
        libraryId: item.id,
        modelName: item.name,
        origin: item.origin,
        remoteId: item.remoteId,
        settings: result.settings,
        updatedAt: Date.now(),
    });

    async function rememberLighting(result: EditorResult, mode: EditorInit["mode"]) {
        if (mode === "new" && settings.value.editor.rememberLighting) await settings.updateQuietly({ editor: { lighting: lightingOf(result.settings) } });
    }

    /** Finds the layer's model in the library, re-downloading it from its service if needed. */
    async function modelForState(state: LayerState): Promise<LibraryItem> {
        const item = library.get(state.libraryId) ?? (state.remoteId && state.origin !== "local" ? library.findByRemote(state.origin, state.remoteId) : undefined);
        if (item) return item;
        if (state.remoteId && state.origin !== "local") {
            log.info(`Model for layer is not in the library; downloading ${state.origin} ${state.remoteId} again`);
            emit("toast", { kind: "info", message: `Downloading "${state.modelName}" from ${state.origin} again…` });
            return browse.import(state.origin, state.remoteId, state.modelName);
        }
        throw new Error(`The model "${state.modelName}" is not in this computer's library. Import its GLB in the Library tab, then try again.`);
    }

    async function editLayer(docId: number, layerId: number, state: LayerState): Promise<PlaceResult | null> {
        const item = await modelForState(state);
        const result = await editor.open({
            mode: "update",
            model: modelInit(item),
            settings: state.settings,
            lighting: settings.value.editor.lighting,
            rememberLighting: settings.value.editor.rememberLighting,
            document: documentInfo(docId),
        });
        if (!result) return null;
        const { render, cleanup } = await writeRender(result, item.name);
        try {
            const placed = await replaceRender(docId, layerId, render, { ...stateFor(item, result), libraryId: item.id });
            log.info(`Updated 3D layer ${placed.layerName} (${result.width}×${result.height})`);
            return placed;
        } finally {
            await cleanup();
        }
    }

    const refreshContext = async () => {
        try {
            emit("ps.context", await getContext());
        } catch (err) {
            log.debug("Context refresh failed", err);
        }
    };

    /* ------------------------------------------------------------ handlers */

    const handlers: Handlers = {
        "app.info": () => appInfo(),

        "settings.get": () => settings.publicSettings(),
        "settings.update": (patch) => settings.update(patch),
        "settings.setSecret": ({ key, value }) => settings.setSecret(key, value),
        "settings.reset": () => settings.reset(),
        "settings.pickWorkflow": async () => {
            const file = await lfs.getFileForOpening({ types: ["json"] });
            const entry = Array.isArray(file) ? file[0] : file;
            if (!entry) return null;
            const text = (await entry.read({ format: storage.formats.utf8 })) as string;
            let json: unknown;
            try {
                json = JSON.parse(text);
            } catch {
                throw new Error(`${entry.name} is not valid JSON.`);
            }
            if (isUiWorkflow(json)) throw new Error("This is a regular saved workflow. In ComfyUI use Workflow → Export (API) and choose that file.");
            if (!isApiWorkflow(json)) throw new Error("This file is not a ComfyUI API workflow.");
            if (!imageNodeCandidates(json).length) throw new Error("This workflow has no Load Image node to receive the layer.");
            return settings.update({ comfyui: { workflow: "custom", customWorkflow: json as Record<string, unknown>, customWorkflowName: entry.name.replace(/\.json$/i, ""), imageNodeId: "" } });
        },

        "providers.status": async () => {
            const ctx = context();
            return Promise.all(
                PROVIDER_IDS.map(async (id): Promise<ProviderStatus> => {
                    const p = getProvider(id);
                    const c = await p.isConfigured(ctx);
                    return { id, label: p.label, configured: c.configured, hint: c.hint, capabilities: p.capabilities };
                }),
            );
        },
        "providers.test": ({ providerId }) => getProvider(providerId).test(context()),

        "ps.context": () => getContext(),
        "ps.sourcePreview": async ({ source }) => {
            if (!psApp.documents.length) return null;
            const img = await readSource(source, 320);
            return { dataUrl: `data:image/png;base64,${bytesToBase64(img.png)}`, width: img.target.bounds.right - img.target.bounds.left, height: img.target.bounds.bottom - img.target.bounds.top, label: img.name };
        },

        "generate.start": async ({ providerId, source, name }) => {
            const img = await readSource(source, settings.value.send.maxEdge);
            log.info(`Generate: ${img.name} (${img.width}×${img.height}${img.hasAlpha ? ", transparent" : ""}) → ${providerId}`);
            return jobs.start({ providerId, image: img.png, width: img.width, height: img.height, hasAlpha: img.hasAlpha, name: name?.trim() || img.name, sourcePreview: img.preview, source: img.target });
        },

        "jobs.list": () => jobs.list(),
        "jobs.cancel": ({ id }) => jobs.cancel(id),
        "jobs.retry": ({ id }) => jobs.retry(id),
        "jobs.dismiss": ({ id }) => jobs.dismiss(id),
        "jobs.recover": ({ providerId, remoteId, name }) => jobs.recover(providerId, remoteId, name),

        "remote.list": ({ providerId, page, pageSize }) => browse.list(providerId, page, pageSize),
        "remote.import": ({ providerId, remoteId, name }) => browse.import(providerId, remoteId, name),

        "library.list": () => library.list(),
        "library.update": ({ id, name, favorite }) => library.update(id, { name, favorite }),
        "library.remove": ({ id }) => library.remove(id),
        "library.importFile": async () => {
            const file = await lfs.getFileForOpening({ types: ["glb", "gltf"] });
            const entry = Array.isArray(file) ? file[0] : file;
            if (!entry) return null;
            const bytes = new Uint8Array((await entry.read({ format: storage.formats.binary })) as ArrayBuffer);
            return library.add({ name: entry.name.replace(/\.(glb|gltf)$/i, ""), origin: "local", model: bytes, meta: { importedFrom: entry.nativePath } });
        },
        "library.saveThumbnail": ({ id, pngBase64 }) => library.setThumbnail(id, base64ToBytes(pngBase64)),
        "library.readFile": async ({ file }) => ({ base64: bytesToBase64(await library.readFile(file)) }),
        "library.revealFolder": async () => {
            await shell.openPath(dataStore.nativePath(LIBRARY_DIR), "Show the 3D model library folder");
        },

        "editor.placeModel": async ({ libraryId, atSource }) => {
            const item = library.get(libraryId);
            if (!item) throw new Error("That model is no longer in the library.");
            if (!psApp.documents.length) throw new Error("Open or create a document first — the model is placed into the active document.");
            const job = atSource ? jobs.get(atSource) : undefined;
            const s = settings.value.editor;
            const result = await editor.open({
                mode: "new",
                model: modelInit(item),
                settings: settingsForNewModel(s.rememberLighting ? s.lighting : undefined, s.defaultResolution),
                lighting: s.lighting,
                rememberLighting: s.rememberLighting,
                document: documentInfo(job?.source?.docId),
            });
            if (!result) return null;
            await rememberLighting(result, "new");
            const { render, cleanup } = await writeRender(result, item.name);
            try {
                const target = job?.source ? { ...job.source.bounds, docId: job.source.docId } : undefined;
                const placed = await placeRender(render, stateFor(item, result), `${item.name} (3D)`, target);
                log.info(`Placed 3D layer ${placed.layerName} (${result.width}×${result.height})`);
                void refreshContext();
                return placed;
            } finally {
                await cleanup();
            }
        },
        "editor.editActiveLayer": async () => {
            const ctx = await getContext();
            if (!ctx.docId || !ctx.layerId) throw new Error("Select a 3D layer first.");
            const state = await readLayerState(ctx.docId, ctx.layerId);
            if (!state) throw new Error(`"${ctx.layerName}" is not a 3D layer made by this plugin.`);
            const placed = await editLayer(ctx.docId, ctx.layerId, state);
            void refreshContext();
            return placed;
        },
        "layer.state": async () => {
            const ctx = await getContext();
            return ctx.docId && ctx.layerId ? readLayerState(ctx.docId, ctx.layerId) : null;
        },
        "layer.detach3D": async () => {
            await detach3D();
            void refreshContext();
        },

        "editor.getInit": () => {
            const session = editor.active;
            if (!session) throw new Error("No 3D editor session is open.");
            return session.init;
        },
        "editor.complete": (result) => {
            const session = editor.active;
            if (!session) throw new Error("No 3D editor session is open.");
            session.resolve(result);
        },
        "editor.cancel": () => {
            editor.active?.resolve(null);
        },
        "editor.rememberLighting": async (lighting) => {
            if (settings.value.editor.rememberLighting) await settings.updateQuietly({ editor: { lighting } });
        },

        "update.check": async ({ force }) => {
            if (!force) {
                // Panel opening: reuse the last result instead of calling GitHub every time.
                if (updater.lastInfo) return updater.lastInfo;
                if (!updater.isDue()) return { currentVersion: build.version, available: false, checkedAt: settings.value.updates.lastCheckAt };
            }
            const info = await updater.check();
            if (info.available) emit("update.available", info);
            return info;
        },
        "update.install": () => updater.install(),
        "update.skip": async ({ version }) => {
            await settings.update({ updates: { skippedVersion: version } });
        },

        "shell.openExternal": async ({ url }) => {
            if (!/^https:\/\//i.test(url)) throw new Error("Only https links can be opened.");
            await shell.openExternal(url, "Open a link from Geekatplay 3D Layers");
        },
        "log.write": ({ level, message, data }) => {
            log[level](`[web] ${message}`, data);
        },
        "log.tail": ({ lines }) => log.tail(lines),
        "log.reveal": async () => {
            await log.flush();
            await shell.openPath(dataStore.nativePath("logs"), "Show the plugin log folder");
        },
    };

    /* ----------------------------------------------------- subscriptions */

    jobs.onChange((list) => emit("jobs.changed", list));
    library.onChange((items) => emit("library.changed", items));
    settings.onChange((s) => emit("settings.changed", s));

    try {
        await listenForContextChanges(() => void refreshContext());
        await listenForEditContents(({ docId, layerId }) => {
            void (async () => {
                if (!settings.value.editor.interceptDoubleClick || editor.isOpen) return;
                const state = await readLayerState(docId, layerId);
                if (!state) return; // an ordinary smart object: let Photoshop open it
                // Photoshop has just opened the layer contents as their own document (named after
                // the embedded file, e.g. "chair-3d.png", or a .psb); close it again. Wait briefly
                // in case Photoshop is still opening it.
                for (let i = 0; i < 15; i++) {
                    const opened = psApp.documents.length ? psApp.activeDocument : null;
                    if (opened && opened.id !== docId) {
                        log.debug(`Closing the opened smart object contents "${String(opened.title)}"`);
                        await closeWithoutSaving(opened.id);
                        break;
                    }
                    await new Promise((r) => setTimeout(r, 100));
                }
                log.info(`Double-click on 3D layer ${layerId} — opening the 3D editor`);
                try {
                    await editLayer(docId, layerId, state);
                } catch (err) {
                    log.error("Could not edit the 3D layer", err);
                    emit("toast", { kind: "error", message: (err as Error).message });
                }
                void refreshContext();
            })();
        });
    } catch (err) {
        log.error("Could not register Photoshop event listeners", err);
    }

    try {
        const themeApi = (document as unknown as { theme?: { onUpdated?: { addListener(fn: (t: string) => void): void } } }).theme;
        themeApi?.onUpdated?.addListener((theme: string) => emit("theme.changed", { theme }));
    } catch {
        // theme events are optional
    }

    if (updater.isDue()) {
        setTimeout(() => {
            if (!updater.isDue()) return; // the panel already checked
            void updater.check().then((info) => {
                if (info.available && info.latestVersion !== settings.value.updates.skippedVersion) emit("update.available", info);
            });
        }, 5000);
    }

    /** Called by the panel entrypoint: connects the panel webview to the bridge. */
    function attachPanel(webview: UxpWebView) {
        const server = new BridgeServer("panel", webview, handlers, log);
        bridges.get("panel")?.close();
        bridges.set("panel", server);
    }

    /** Menu command: edit the selected 3D layer without the panel. */
    async function editActiveLayerCommand() {
        try {
            await handlers["editor.editActiveLayer"]!(undefined, { source: "command" });
        } catch (err) {
            log.error("Edit 3D layer command failed", err);
            await psApp.showAlert((err as Error).message);
        }
    }

    log.info(`Ready: library ${library.list().length} models, ${jobs.list().filter((j) => j.status === "running" || j.status === "queued").length} active jobs, UI from ${web.webBase}`);
    return { log, webBase: web.webBase, attachPanel, editActiveLayerCommand, updater, handlers };
}
