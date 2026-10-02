// Re-opens the built .ccx and checks it the way Adobe's installer will see it:
// valid ZIP, no directory entries, forward-slash paths, manifest rules, required files,
// and the checksum file matching. Exits non-zero on any problem (used by CI).
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readZip, validateManifest } from "./ccx.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = join(root, "dist", "release");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const name = `geekatplay-3d-layers-${pkg.version}.ccx`;
const bytes = readFileSync(join(releaseDir, name));
const problems = [];

const entries = readZip(new Uint8Array(bytes));
const files = Object.keys(entries);
for (const f of files) {
    if (f.endsWith("/")) problems.push(`directory entry in zip: ${f}`);
    if (f.includes("\\")) problems.push(`backslash in path: ${f}`);
    if (f.endsWith(".map")) problems.push(`sourcemap shipped: ${f}`);
}
const manifest = JSON.parse(new TextDecoder().decode(entries["manifest.json"]));
if (manifest.version !== pkg.version) problems.push(`manifest version ${manifest.version} ≠ package.json ${pkg.version}`);
problems.push(...validateManifest(manifest, files));

const info = JSON.parse(new TextDecoder().decode(entries["build-info.json"]));
if (info.version !== pkg.version) problems.push("build-info.json version mismatch");

const sums = readFileSync(join(releaseDir, "SHA256SUMS.txt"), "utf8");
const actual = createHash("sha256").update(bytes).digest("hex");
if (!sums.includes(`${actual}  ${name}`)) problems.push("SHA256SUMS.txt does not match the package");

const html = new TextDecoder().decode(entries["web/panel.html"]);
if (/src="\/|href="\//.test(html)) problems.push("web/panel.html uses absolute asset paths (must be relative for plugin-data:)");

if (problems.length) {
    console.error(`✗ ${name}\n  - ${problems.join("\n  - ")}`);
    process.exit(1);
}
console.log(`✓ ${name}: ${files.length} files, ${(bytes.length / 1024 / 1024).toFixed(2)} MB, sha256 ${actual}`);
