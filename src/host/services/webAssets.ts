/**
 * Puts the WebView UI next to the model library.
 *
 * A WebView loaded from the plugin folder cannot read files in the plugin data folder,
 * but a page loaded from the data folder can fetch sibling files with relative URLs
 * (verified in Photoshop 27). So on start-up the bundled UI (plugin:/web) is copied to
 * <data folder>/web once per build, and pages load models as "../library/<id>/model.glb"
 * with no copying through the message bridge. If the copy fails, the UI is loaded from
 * the plugin folder and models are streamed through the bridge instead.
 */
import { joinPath, type FileStore } from "../platform/fileStore";
import type { Logger } from "../platform/logger";

export const WEB_DIR = "web";
const STAMP = `${WEB_DIR}/.build-stamp`;

export async function copyTree(from: FileStore, to: FileStore, dir: string): Promise<number> {
    let count = 0;
    for (const entry of await from.list(dir)) {
        const path = joinPath(dir, entry.name);
        if (entry.isFolder) count += await copyTree(from, to, path);
        else {
            const bytes = await from.readBytes(path);
            if (bytes) {
                await to.writeBytes(path, bytes);
                count++;
            }
        }
    }
    return count;
}

/**
 * Ensures <data>/web matches the bundled UI. Returns the URL scheme to load pages from
 * ("plugin-data:/web" or the "plugin:/web" fallback) and whether direct library URLs work.
 */
export async function ensureWebAssets(pluginStore: FileStore, dataStore: FileStore, buildStamp: string, log: Logger): Promise<{ webBase: string; directLibrary: boolean }> {
    try {
        const current = await dataStore.readText(STAMP);
        if (current === buildStamp && (await dataStore.exists(joinPath(WEB_DIR, "panel.html")))) {
            return { webBase: "plugin-data:/web", directLibrary: true };
        }
        const started = Date.now();
        await dataStore.remove(WEB_DIR);
        const count = await copyTree(pluginStore, dataStore, WEB_DIR);
        if (!(await dataStore.exists(joinPath(WEB_DIR, "panel.html")))) throw new Error("panel.html missing after copy");
        await dataStore.writeText(STAMP, buildStamp);
        log.info(`Web UI ${buildStamp} copied to the data folder (${count} files, ${Date.now() - started} ms)`);
        return { webBase: "plugin-data:/web", directLibrary: true };
    } catch (err) {
        log.error("Could not copy the web UI to the data folder; using the plugin folder copy", err);
        return { webBase: "plugin:/web", directLibrary: false };
    }
}
