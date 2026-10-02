// Writes tests/fixtures/public/samples/totem.glb: a tiny multi-material glTF 2.0 binary
// (a stack of coloured boxes and a "roof") used by unit tests, the mock host in
// `npm run dev:web`, and the Playwright editor test. Built by hand so the fixture is
// a few KB and needs no 3D software.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "tests", "fixtures", "public", "samples");
mkdirSync(outDir, { recursive: true });

function box(cx, cy, cz, sx, sy, sz) {
    const p = [];
    const n = [];
    const idx = [];
    const faces = [
        [[1, 0, 0], [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]]],
        [[-1, 0, 0], [[-1, -1, 1], [-1, 1, 1], [-1, 1, -1], [-1, -1, -1]]],
        [[0, 1, 0], [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]]],
        [[0, -1, 0], [[-1, -1, 1], [-1, -1, -1], [1, -1, -1], [1, -1, 1]]],
        [[0, 0, 1], [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]]],
        [[0, 0, -1], [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]]],
    ];
    for (const [normal, corners] of faces) {
        const base = p.length / 3;
        for (const [x, y, z] of corners) {
            p.push(cx + (x * sx) / 2, cy + (y * sy) / 2, cz + (z * sz) / 2);
            n.push(...normal);
        }
        idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    return { p, n, idx };
}

function pyramid(cx, cy, cz, s, h) {
    const apex = [cx, cy + h, cz];
    const c = [
        [cx - s / 2, cy, cz - s / 2],
        [cx + s / 2, cy, cz - s / 2],
        [cx + s / 2, cy, cz + s / 2],
        [cx - s / 2, cy, cz + s / 2],
    ];
    const p = [];
    const n = [];
    const idx = [];
    for (let i = 0; i < 4; i++) {
        const a = c[i];
        const b = c[(i + 1) % 4];
        const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const v = [apex[0] - a[0], apex[1] - a[1], apex[2] - a[2]];
        let nn = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        const l = Math.hypot(...nn);
        nn = nn.map((x) => -x / l);
        const base = p.length / 3;
        for (const q of [a, apex, b]) {
            p.push(...q);
            n.push(...nn);
        }
        idx.push(base, base + 1, base + 2);
    }
    return { p, n, idx };
}

const parts = [
    { geo: box(0, -0.75, 0, 1.2, 0.5, 1.2), color: [0.55, 0.32, 0.18, 1], metallic: 0, roughness: 0.8 },
    { geo: box(0, -0.2, 0, 0.9, 0.6, 0.9), color: [0.85, 0.75, 0.55, 1], metallic: 0, roughness: 0.6 },
    { geo: box(0, 0.35, 0, 0.7, 0.5, 0.7), color: [0.2, 0.45, 0.85, 1], metallic: 0.3, roughness: 0.4 },
    { geo: box(0.55, 0.35, 0, 0.4, 0.15, 0.15), color: [0.9, 0.2, 0.2, 1], metallic: 0, roughness: 0.5 },
    { geo: pyramid(0, 0.6, 0, 0.9, 0.5), color: [0.95, 0.7, 0.1, 1], metallic: 0.8, roughness: 0.25 },
];

const chunks = [];
let offset = 0;
const bufferViews = [];
const accessors = [];
const meshes = [];
const materials = [];
const nodes = [];

function addView(data, target) {
    const bytes = Buffer.from(data.buffer);
    const pad = (4 - (bytes.length % 4)) % 4;
    chunks.push(bytes, Buffer.alloc(pad));
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target });
    offset += bytes.length + pad;
    return bufferViews.length - 1;
}

parts.forEach((part, i) => {
    const pos = new Float32Array(part.geo.p);
    const nor = new Float32Array(part.geo.n);
    const ind = new Uint16Array(part.geo.idx);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < pos.length; k += 3) for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a], pos[k + a]);
        max[a] = Math.max(max[a], pos[k + a]);
    }
    const vp = addView(pos, 34962);
    const vn = addView(nor, 34962);
    const vi = addView(ind, 34963);
    accessors.push({ bufferView: vp, componentType: 5126, count: pos.length / 3, type: "VEC3", min, max });
    accessors.push({ bufferView: vn, componentType: 5126, count: nor.length / 3, type: "VEC3" });
    accessors.push({ bufferView: vi, componentType: 5123, count: ind.length, type: "SCALAR" });
    materials.push({ name: `part${i}`, pbrMetallicRoughness: { baseColorFactor: part.color, metallicFactor: part.metallic, roughnessFactor: part.roughness } });
    meshes.push({ name: `part${i}`, primitives: [{ attributes: { POSITION: i * 3, NORMAL: i * 3 + 1 }, indices: i * 3 + 2, material: i }] });
    nodes.push({ name: `part${i}`, mesh: i });
});

const bin = Buffer.concat(chunks);
const gltf = {
    asset: { version: "2.0", generator: "geekatplay-3d-layers test fixture" },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes,
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: bin.length }],
};
let json = Buffer.from(JSON.stringify(gltf));
json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
const header = Buffer.alloc(12);
header.write("glTF", 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
const jsonHeader = Buffer.alloc(8);
jsonHeader.writeUInt32LE(json.length, 0);
jsonHeader.write("JSON", 4);
const binHeader = Buffer.alloc(8);
binHeader.writeUInt32LE(bin.length, 0);
binHeader.write("BIN\0", 4);
const glb = Buffer.concat([header, jsonHeader, json, binHeader, bin]);
writeFileSync(join(outDir, "totem.glb"), glb);
console.log(`Wrote ${join(outDir, "totem.glb")} (${glb.length} bytes)`);
