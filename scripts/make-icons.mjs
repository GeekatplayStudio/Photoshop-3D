// Generates plugin/icons/*.png: an isometric cube with a light dot (the "sun" from
// the 3D editor). Run `node scripts/make-icons.mjs` after changing the design; the
// PNGs are committed so builds never depend on this script.
import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "plugin", "icons");
mkdirSync(out, { recursive: true });

function crc32(buf) {
    let c = ~0;
    for (const b of buf) {
        c ^= b;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    return ~c >>> 0;
}
function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    const raw = Buffer.alloc((size * 4 + 1) * size);
    for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// Point-in-polygon with 4×4 supersampling for antialiasing.
function inside(poly, x, y) {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i];
        const [xj, yj] = poly[j];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
}

function render(size, faces, sun) {
    const rgba = Buffer.alloc(size * size * 4);
    const S = 4;
    for (let py = 0; py < size; py++) {
        for (let px = 0; px < size; px++) {
            let r = 0, g = 0, b = 0, a = 0;
            for (let sy = 0; sy < S; sy++) {
                for (let sx = 0; sx < S; sx++) {
                    const x = (px + (sx + 0.5) / S) / size;
                    const y = (py + (sy + 0.5) / S) / size;
                    let col = null;
                    const d = Math.hypot(x - sun.x, y - sun.y);
                    if (d < sun.r) col = sun.color;
                    else for (const f of faces) if (inside(f.poly, x, y)) col = f.color;
                    if (col) {
                        r += col[0];
                        g += col[1];
                        b += col[2];
                        a += 255;
                    }
                }
            }
            const n = S * S;
            const o = (py * size + px) * 4;
            const alpha = a / n;
            if (alpha > 0) {
                rgba[o] = Math.round(r / (a / 255));
                rgba[o + 1] = Math.round(g / (a / 255));
                rgba[o + 2] = Math.round(b / (a / 255));
            }
            rgba[o + 3] = Math.round(alpha);
        }
    }
    return rgba;
}

// Isometric cube in unit space.
const top = [[0.5, 0.18], [0.86, 0.36], [0.5, 0.54], [0.14, 0.36]];
const left = [[0.14, 0.36], [0.5, 0.54], [0.5, 0.94], [0.14, 0.76]];
const right = [[0.5, 0.54], [0.86, 0.36], [0.86, 0.76], [0.5, 0.94]];

const themes = {
    dark: { top: [240, 240, 240], left: [170, 170, 170], right: [110, 110, 110], sun: [255, 196, 70] },
    light: { top: [90, 90, 90], left: [60, 60, 60], right: [35, 35, 35], sun: [235, 150, 20] },
    plugin: { top: [120, 190, 255], left: [60, 120, 220], right: [30, 70, 160], sun: [255, 200, 80] },
};

function icon(name, size, theme) {
    const t = themes[theme];
    const faces = [
        { poly: top, color: t.top },
        { poly: left, color: t.left },
        { poly: right, color: t.right },
    ];
    writeFileSync(join(out, name), png(size, render(size, faces, { x: 0.82, y: 0.17, r: 0.13, color: t.sun })));
}

// The manifest names "icons/panel-dark.png"; Photoshop loads "panel-dark@1x.png" and
// "panel-dark@2x.png". On Windows a 1x file without "@1x" is not found, and the panel
// shows a blank icon when it is collapsed in a dock.
icon("panel-dark@1x.png", 23, "dark");
icon("panel-dark@2x.png", 46, "dark");
icon("panel-light@1x.png", 23, "light");
icon("panel-light@2x.png", 46, "light");
icon("plugin@1x.png", 48, "plugin");
icon("plugin@2x.png", 96, "plugin");
icon("app-256.png", 256, "plugin");
console.log(`Icons written to ${out}`);
