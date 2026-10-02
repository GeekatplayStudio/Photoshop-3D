// Builds the installable plugin folder: dist/plugin/
//
//   dist/plugin/manifest.json      plugin/manifest.json with the version from package.json
//   dist/plugin/index.html         UXP host page
//   dist/plugin/host.js            src/host bundled with esbuild (IIFE; photoshop/uxp stay require()s)
//   dist/plugin/web/               src/web built with Vite (panel.html, editor.html, assets/)
//   dist/plugin/icons/             plugin/icons
//   dist/plugin/build-info.json    { version, stamp, builtAt } — the stamp tells the host when to
//                                  refresh its copy of the web UI in the data folder
import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist", "plugin");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const started = Date.now();

function gitSha() {
    try {
        return execSync("git rev-parse --short HEAD", { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    } catch {
        return "nogit";
    }
}

const stamp = `${pkg.version}-${gitSha()}-${Date.now().toString(36)}`;
console.log(`Building Geekatplay 3D Layers ${pkg.version} (${stamp})`);

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// 1. Web UI (React + three.js) → dist/plugin/web
await viteBuild({ configFile: join(root, "vite.config.ts"), logLevel: "warn", mode: "production" });
console.log("  ✓ web UI");

// 2. UXP host → dist/plugin/host.js
await esbuild({
    entryPoints: [join(root, "src/host/main.ts")],
    outfile: join(dist, "host.js"),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2020",
    external: ["photoshop", "uxp", "os", "fs"],
    alias: { "@shared": join(root, "src/shared"), "@host": join(root, "src/host") },
    sourcemap: "linked",
    legalComments: "eof",
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "warning",
});
console.log("  ✓ host.js");

// 3. Static files + manifest with the package version
cpSync(join(root, "plugin", "index.html"), join(dist, "index.html"));
cpSync(join(root, "plugin", "icons"), join(dist, "icons"), { recursive: true, filter: (src) => !src.endsWith("app-256.png") });
const manifest = JSON.parse(readFileSync(join(root, "plugin", "manifest.json"), "utf8"));
manifest.version = pkg.version;
writeFileSync(join(dist, "manifest.json"), JSON.stringify(manifest, null, 2));
writeFileSync(join(dist, "build-info.json"), JSON.stringify({ version: pkg.version, stamp, builtAt: new Date().toISOString() }, null, 2));
cpSync(join(root, "LICENSE"), join(dist, "LICENSE"), { force: true });
console.log(`  ✓ manifest ${manifest.id} ${manifest.version}`);
console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)} s → ${dist}`);
