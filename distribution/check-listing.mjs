// Geekatplay 3D Layers - checks distribution/LISTING.md and the listing images against
// Adobe Developer Distribution's limits.
// by Geekatplay Studio - Vladimir Chopine - https://www.geekatplay.com
//
//   node distribution/check-listing.mjs
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const LIMITS = {
    "Public plugin name": 45,
    Subtitle: 30,
    Description: 5000,
    Tags: 300,
    "Version details / release notes": 1000,
    "Note for Adobe reviewers": 1000,
    "Supported languages": 1000,
};
// name → [width, height, max MB]
const IMAGES = { "icon-48.png": [48, 48, 1], "icon-96.png": [96, 96, 1], "icon-192.png": [192, 192, 1], "publisher-logo-250.png": [250, 250, 2] };

/** { heading: first ```text block under it } */
export function fields(text) {
    const found = {};
    for (const section of text.split(/^## /m).slice(1)) {
        const heading = section.split("\n")[0].replace(/\s*\(\d+\)\s*$/, "").trim();
        const block = /```text\n([\s\S]*?)\n```/.exec(section);
        if (block) found[heading] = block[1];
    }
    return found;
}

/** Width and height from a PNG's IHDR chunk. */
export function pngSize(bytes) {
    if (bytes.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

let ok = true;
const listing = fields(readFileSync(join(here, "LISTING.md"), "utf8"));
for (const [name, limit] of Object.entries(LIMITS)) {
    const value = listing[name];
    if (value === undefined) {
        console.log(`MISSING  ${name}`);
        ok = false;
        continue;
    }
    const bad = value.length > limit || (name === "Public plugin name" && !/^[\x20-\x7e]+$/.test(value));
    console.log(`${(bad ? "TOO LONG" : "ok").padEnd(8)} ${name}: ${value.length}/${limit}`);
    ok &&= !bad;
}

const assets = join(here, "assets");
const shots = readdirSync(assets).filter((f) => f.startsWith("screenshot-")).sort();
const images = { ...IMAGES, ...Object.fromEntries(shots.map((s) => [s, [1360, 800, 5]])) };
for (const [name, [w, h, mb]] of Object.entries(images)) {
    let size;
    try {
        size = pngSize(readFileSync(join(assets, name)));
    } catch {
        console.log(`MISSING  ${name}`);
        ok = false;
        continue;
    }
    const bytes = statSync(join(assets, name)).size;
    const bad = size[0] !== w || size[1] !== h || bytes > mb * 1024 * 1024;
    console.log(`${(bad ? "WRONG" : "ok").padEnd(8)} ${name}: ${size[0]}x${size[1]}, ${Math.round(bytes / 1024)} KB`);
    ok &&= !bad;
}
if (shots.length < 1 || shots.length > 5) {
    console.log(`WRONG    ${shots.length} screenshots (1 to 5 allowed)`);
    ok = false;
}
process.exit(ok ? 0 : 1);
