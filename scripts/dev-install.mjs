// Installs dist/release/geekatplay-3d-layers-<version>.ccx into Photoshop with Adobe's
// Unified Plugin Installer Agent (the same tool Creative Cloud uses), replacing any
// installed version. Photoshop picks the plugin up without a restart.
//
//   node scripts/dev-install.mjs            install the built package
//   node scripts/dev-install.mjs --remove   uninstall
//   node scripts/dev-install.mjs --list     show installed Photoshop plugins
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PLUGIN_NAME = "Geekatplay 3D Layers";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function upiaPath() {
    const candidates =
        process.platform === "win32"
            ? ["C:\\Program Files\\Common Files\\Adobe\\Adobe Desktop Common\\RemoteComponents\\UPI\\UnifiedPluginInstallerAgent\\UnifiedPluginInstallerAgent.exe"]
            : ["/Library/Application Support/Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/UnifiedPluginInstallerAgent.app/Contents/MacOS/UnifiedPluginInstallerAgent"];
    return candidates.find((p) => existsSync(p));
}

function run(upia, args) {
    const flag = (f) => (process.platform === "win32" ? `/${f}` : `--${f}`);
    const [cmd, ...rest] = args;
    try {
        return execFileSync(upia, [flag(cmd), ...rest], { encoding: "utf8" });
    } catch (err) {
        return `${err.stdout ?? ""}${err.stderr ?? ""}`;
    }
}

/** UPIA removes one registered copy per call; repeat until none is left. */
export function removeAll(upia) {
    for (let i = 0; i < 10; i++) {
        const out = run(upia, ["remove", PLUGIN_NAME]);
        if (!/Removal Successful/i.test(out)) return i;
    }
    return 10;
}

const upia = upiaPath();
if (!upia) {
    console.error("Adobe's plugin installer (UPIA) was not found. Install the Creative Cloud desktop app, or double-click the .ccx file.");
    process.exit(1);
}

const args = process.argv.slice(2);
if (args.includes("--list")) {
    console.log(run(upia, ["list", "all"]));
    process.exit(0);
}

const removed = removeAll(upia);
if (removed) console.log(`Removed ${removed} installed cop${removed === 1 ? "y" : "ies"} of ${PLUGIN_NAME}.`);
if (args.includes("--remove")) process.exit(0);

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const ccx = join(root, "dist", "release", `geekatplay-3d-layers-${pkg.version}.ccx`);
if (!existsSync(ccx)) {
    console.error(`${ccx} not found — run \`npm run dist\` first.`);
    process.exit(1);
}
const out = run(upia, ["install", ccx]);
console.log(out.trim());
if (!/Installation Successful/i.test(out)) process.exit(1);
console.log(`Installed ${PLUGIN_NAME} ${pkg.version}. In Photoshop: Plugins → Geekatplay 3D Layers → 3D Layers.`);
