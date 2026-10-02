/**
 * Where user data lives: a folder Adobe's installer never touches.
 *
 * UXP's plugin data folder (…/Adobe/UXP/PluginsStorage/PHSP/<ps-version>/External/<id>/PluginData)
 * is deleted by Adobe's installer whenever any installed copy of the plugin is removed —
 * including the remove step of an upgrade — and it is separate per Photoshop version.
 * Verified on Photoshop 27 / UPIA 8.5. So the library, settings, jobs and logs live in:
 *
 *   Windows: %APPDATA%\Geekatplay\3D Layers
 *   macOS:   ~/Library/Application Support/Geekatplay/3D Layers
 *
 * derived from the data folder path (both sit under the same per-user app-data root),
 * shared by every Photoshop version and kept across installs, upgrades and uninstalls.
 */
export const SHARED_SEGMENTS = ["Geekatplay", "3D Layers"] as const;

/** The per-user app-data root that contains Adobe's UXP folder, or null when the layout is unexpected. */
export function appDataRoot(dataFolderNativePath: string): string | null {
    const m = /^(.*?)[\\/]Adobe[\\/]UXP[\\/]PluginsStorage[\\/]/i.exec(dataFolderNativePath);
    return m ? m[1] : null;
}

export function sharedFolderPath(dataFolderNativePath: string): string | null {
    const root = appDataRoot(dataFolderNativePath);
    if (!root) return null;
    const sep = root.includes("\\") ? "\\" : "/";
    return [root, ...SHARED_SEGMENTS].join(sep);
}

/** "C:\\Users\\a b\\x" → "file:/C:/Users/a b/x" (the form UXP's getEntryWithUrl takes). */
export function toUxpFileUrl(nativePath: string): string {
    const p = nativePath.replace(/\\/g, "/");
    return `file:${p.startsWith("/") ? "" : "/"}${p}`;
}

/** Same path as a browser file:// URL (percent-encoded) for the WebView. */
export function toBrowserFileUrl(nativePath: string): string {
    const encoded = nativePath
        .replace(/\\/g, "/")
        .split("/")
        .map((seg, i) => (i === 0 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg)))
        .join("/");
    return `file://${encoded.startsWith("/") ? "" : "/"}${encoded}`;
}
