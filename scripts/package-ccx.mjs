// Packages dist/plugin into dist/release/geekatplay-3d-layers-<version>.ccx and writes
// dist/release/SHA256SUMS.txt (the in-plugin updater verifies downloads against it).
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listFiles, validateManifest, zipFolder } from "./ccx.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pluginDir = join(root, "dist", "plugin");
const releaseDir = join(root, "dist", "release");

if (!existsSync(join(pluginDir, "manifest.json"))) {
    console.error("dist/plugin is missing — run `npm run build` first.");
    process.exit(1);
}
const manifest = JSON.parse(readFileSync(join(pluginDir, "manifest.json"), "utf8"));
const problems = validateManifest(manifest, listFiles(pluginDir));
if (problems.length) {
    console.error(`Manifest/package problems:\n  - ${problems.join("\n  - ")}`);
    process.exit(1);
}

mkdirSync(releaseDir, { recursive: true });
const name = `geekatplay-3d-layers-${manifest.version}.ccx`;
const bytes = zipFolder(pluginDir);
writeFileSync(join(releaseDir, name), bytes);
// A stable name for "latest" links and the installers.
copyFileSync(join(releaseDir, name), join(releaseDir, "geekatplay-3d-layers.ccx"));

const sums = [name, "geekatplay-3d-layers.ccx"].map((f) => `${createHash("sha256").update(readFileSync(join(releaseDir, f))).digest("hex")}  ${f}`);
writeFileSync(join(releaseDir, "SHA256SUMS.txt"), sums.join("\n") + "\n");

for (const f of ["install-windows.cmd", "install-windows.ps1", "install-macos.command", "uninstall-windows.cmd", "uninstall-macos.command"]) {
    const src = join(root, "install", f);
    if (existsSync(src)) copyFileSync(src, join(releaseDir, f));
}

console.log(`Packaged ${name} (${(bytes.length / 1024 / 1024).toFixed(2)} MB) → ${releaseDir}`);
