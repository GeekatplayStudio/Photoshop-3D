// Shared helpers for building and checking .ccx packages.
//
// A .ccx is a plain ZIP of the plugin folder (that is what Adobe's UXP Developer Tool
// writes, with the `archiver` package). Two details matter for Adobe's installer (UPIA):
//   - no directory entries, forward-slash paths — a ZIP written by Windows' bsdtar
//     (`tar -a`) is rejected with status -204, a ZIP from fflate installs fine;
//   - the manifest must list icons (UDT refuses to package a PS plugin without them).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { unzipSync, zipSync } from "fflate";

/** Files UDT leaves out of packages. */
const IGNORED = new Set([".DS_Store", "Thumbs.db", ".uxprc", ".gitignore", ".npmignore"]);

export function listFiles(dir) {
    const files = [];
    (function walk(d) {
        for (const name of readdirSync(d)) {
            if (IGNORED.has(name) || name.endsWith(".ccx")) continue;
            const p = join(d, name);
            if (statSync(p).isDirectory()) walk(p);
            else files.push(relative(dir, p).split(sep).join("/"));
        }
    })(dir);
    return files.sort();
}

export function zipFolder(dir) {
    const entries = {};
    for (const file of listFiles(dir)) {
        // Sourcemaps are for development; they would double the download.
        if (file.endsWith(".map")) continue;
        entries[file] = [new Uint8Array(readFileSync(join(dir, file))), { level: /\.(png|jpe?g|webp|glb|ccx|zip)$/i.test(file) ? 0 : 9 }];
    }
    return zipSync(entries);
}

export function readZip(bytes) {
    return unzipSync(bytes);
}

/** Validates a plugin manifest the way UDT does before packaging (plus our own rules). */
export function validateManifest(manifest, files) {
    const problems = [];
    const has = (p) => files.includes(p);
    if (manifest.manifestVersion !== 5) problems.push("manifestVersion must be 5 (WebView needs v5)");
    if (!/^\d+\.\d+\.\d+$/.test(manifest.version ?? "")) problems.push(`version must be x.y.z, got "${manifest.version}"`);
    if (!manifest.id) problems.push("missing id");
    if (!(manifest.name?.length >= 3 && manifest.name.length <= 45)) problems.push("name must be 3-45 characters");
    const host = Array.isArray(manifest.host) ? manifest.host[0] : manifest.host;
    if (host?.app !== "PS") problems.push("host.app must be PS");
    if (!/^\d+(\.\d+){0,3}$/.test(String(host?.minVersion ?? "")) || parseInt(host.minVersion, 10) < 26) problems.push("host.minVersion must be ≥ 26.0.0 (local WebView needs UXP 8)");
    if (!Array.isArray(manifest.icons) || !manifest.icons.length) problems.push("plugin icons missing (UPIA/UDT require them)");
    for (const ep of manifest.entrypoints ?? []) {
        if (ep.type === "panel" && !Array.isArray(ep.icons)) problems.push(`panel ${ep.id} has no icons`);
    }
    // The manifest names "icons/x.png"; Photoshop loads "x@1x.png" / "x@2x.png" for each scale.
    // On Windows a 1x file without "@1x" is not found, so the panel's dock icon stays blank.
    const icons = [...(manifest.icons ?? []), ...(manifest.entrypoints ?? []).flatMap((e) => e.icons ?? [])];
    for (const icon of icons) {
        if (/@\d+(\.\d+)?x\.png$/.test(icon.path)) problems.push(`icon path ${icon.path} must not include the @Nx suffix (name the files that way instead)`);
        for (const scale of icon.scale ?? [1]) {
            const file = icon.path.replace(/\.png$/, `@${scale}x.png`);
            if (!has(file)) problems.push(`icon file missing: ${file}`);
        }
    }
    for (const ep of manifest.entrypoints ?? []) {
        if (ep.type === "panel" && (ep.icons ?? []).some((i) => !i.species?.includes("chrome"))) problems.push(`panel ${ep.id} icons need "species": ["chrome"] to show in docks`);
    }
    for (const required of ["index.html", "host.js", "manifest.json", "build-info.json", "web/panel.html", "web/editor.html"]) {
        if (!has(required)) problems.push(`required file missing: ${required}`);
    }
    if (manifest.main && !has(manifest.main)) problems.push(`main file ${manifest.main} missing`);
    const wv = manifest.requiredPermissions?.webview;
    if (wv?.allow !== "yes" || wv?.allowLocalRendering !== "yes" || wv?.enableMessageBridge !== "localAndRemote") problems.push("webview permission must allow local rendering with the message bridge");
    return problems;
}
