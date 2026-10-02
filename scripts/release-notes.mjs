// Prints the CHANGELOG.md section for a version (used as the GitHub release notes).
//   node scripts/release-notes.mjs 0.2.0
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function sectionFor(changelog, version) {
    const lines = changelog.split(/\r?\n/);
    const start = lines.findIndex((l) => new RegExp(`^##\\s+\\[?v?${version.replace(/\./g, "\\.")}\\]?`).test(l));
    if (start === -1) return null;
    let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
    if (end === -1) end = lines.length;
    return lines.slice(start + 1, end).join("\n").trim();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const version = process.argv[2];
    if (!version) {
        console.error("usage: node scripts/release-notes.mjs <version>");
        process.exit(1);
    }
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const notes = sectionFor(readFileSync(join(root, "CHANGELOG.md"), "utf8"), version);
    const install = [
        "",
        "### Install or update",
        "- **Windows:** download `install-windows.cmd` and `install-windows.ps1` into one folder and double-click `install-windows.cmd`, or run in PowerShell:",
        "  `irm https://raw.githubusercontent.com/GeekatplayStudio/Photoshop-3D/main/install/install-windows.ps1 | iex`",
        "- **macOS:** `curl -fsSL https://raw.githubusercontent.com/GeekatplayStudio/Photoshop-3D/main/install/install-macos.command | bash`",
        "- **Any OS:** double-click `geekatplay-3d-layers-" + version + ".ccx` (Creative Cloud installs it).",
        "- **Already installed:** the plugin offers this update in its panel (Settings › Updates).",
        "",
        "Checksums: `SHA256SUMS.txt`.",
    ].join("\n");
    process.stdout.write(`${notes ?? `Release ${version}.`}\n${install}\n`);
}
