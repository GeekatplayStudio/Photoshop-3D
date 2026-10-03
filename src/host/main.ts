/**
 * UXP entry point (bundled to dist/plugin/host.js, loaded by plugin/index.html).
 *
 * Registers the "3D Layers" panel and the menu commands. The panel's UI is a
 * <webview> (React app from src/web) created when the panel is first shown.
 */
import "./polyfills";
import { entrypoints } from "uxp";
import { startApp, type App } from "./app";
import { app as ps } from "./ps/photoshop";

let appPromise: Promise<App> | null = null;
const getApp = () => (appPromise ??= startApp());

function showError(root: HTMLElement, err: unknown) {
    const box = document.createElement("div");
    box.style.cssText = "padding:12px;color:#f88;font-size:12px;white-space:pre-wrap";
    box.textContent = `Geekatplay 3D Layers could not start:\n${(err as Error)?.message ?? String(err)}\n\nSee the log in the plugin data folder (logs/photoshop3d.log).`;
    root.appendChild(box);
}

/** Creates the panel webview once and keeps it sized to the panel in pixels. */
function mountPanel(root: HTMLElement) {
    if (root.querySelector("webview")) return;
    root.style.cssText = "margin:0;padding:0;width:100%;height:100%;overflow:hidden;";
    const status = document.createElement("div");
    status.textContent = "Loading 3D Layers…";
    status.style.cssText = "padding:12px;color:#bbb;font-size:12px";
    root.appendChild(status);

    getApp()
        .then((app) => {
            const webview = document.createElement("webview") as UxpWebView;
            webview.setAttribute("src", `${app.webBase}/panel.html`);
            if (app.allowInspector) webview.setAttribute("uxpAllowInspector", "true");
            webview.style.cssText = "border:0;display:block;width:100%;height:400px;";
            root.appendChild(webview);
            app.attachPanel(webview);
            webview.addEventListener("loadstop", () => status.remove());
            webview.addEventListener("loaderror", (e: Event) => app.log.error("Panel page failed to load", (e as unknown as { message?: string }).message));
            const fit = () => {
                const w = root.clientWidth || document.body.clientWidth;
                const h = root.clientHeight || document.body.clientHeight || window.innerHeight;
                if (w > 20) webview.style.width = `${w}px`;
                if (h > 20) webview.style.height = `${h}px`;
            };
            fit();
            setInterval(fit, 400);
            window.addEventListener("resize", fit);
        })
        .catch((err) => {
            status.remove();
            showError(root, err);
        });
}

entrypoints.setup({
    plugin: {
        create() {
            // Start services early so jobs resume polling even before the panel opens.
            void getApp().catch(() => undefined);
        },
    },
    panels: {
        threeDLayers: {
            show(root: HTMLElement) {
                mountPanel(root ?? document.body);
            },
        },
    },
    commands: {
        editThreeDLayer: () => getApp().then((app) => app.editActiveLayerCommand()),
        checkForUpdates: () =>
            getApp().then(async (app) => {
                const info = await app.updater.check();
                if (info.error) await ps.showAlert(`Update check failed: ${info.error}`);
                else if (info.available) await ps.showAlert(`Version ${info.latestVersion} is available (you have ${info.currentVersion}). Open the 3D Layers panel → Settings → Updates to install it.`);
                else await ps.showAlert(`You have the latest version (${info.currentVersion}).`);
            }),
    },
});
