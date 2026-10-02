import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { DEFAULT_SETTINGS, mergeSettings, normalizeUrl, sanitizeSettings, secretPreview } from "./settings";
import { readLayerStateXmp, removeLayerStateXmp, writeLayerStateXmp } from "./xmp";
import { compareVersions, isPrerelease, parseVersion } from "./semver";
import { base64ToBytes, bytesToBase64, formatBytes, slug, sniffFormat } from "./bytes";
import { decodeUtf8, encodeUtf8 } from "./utf8";
import { applyMask, encodePng, pngSize } from "./png";
import { alphaBounds, centeredTarget, frameForTarget } from "./placement";
import { parseChecksums, sha256Hex } from "./sha256";
import { DEFAULT_LIGHTING, clampResolution, lightingOf, settingsForNewModel, vecLength, vecScaleTo } from "./threeD";
import type { LayerState } from "./types";

describe("settings", () => {
    it("fills defaults from nothing", () => {
        expect(sanitizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
        expect(sanitizeSettings("garbage")).toEqual(DEFAULT_SETTINGS);
    });

    it("coerces and clamps bad values", () => {
        const s = sanitizeSettings({
            defaultProvider: "nope",
            send: { maxEdge: "99999", source: "selection" },
            comfyui: { url: "192.168.1.5:8188/", textureSize: 10, seed: "-5" },
            meshy: { geometryResolution: "8k", targetPolycount: -3 },
            editor: { lighting: { lightColor: "red", lightIntensity: 50 } },
        });
        expect(s.defaultProvider).toBe("meshy");
        expect(s.send).toEqual({ maxEdge: 4096, source: "selection" });
        expect(s.comfyui.url).toBe("http://192.168.1.5:8188");
        expect(s.comfyui.textureSize).toBe(512);
        expect(s.comfyui.seed).toBe(-1);
        expect(s.meshy.geometryResolution).toBe("standard");
        expect(s.meshy.targetPolycount).toBe(0);
        expect(s.editor.lighting.lightColor).toBe(DEFAULT_LIGHTING.lightColor);
        expect(s.editor.lighting.lightIntensity).toBe(10);
    });

    it("keeps Hitem3D resolution consistent with the model", () => {
        expect(sanitizeSettings({ hitem3d: { model: "hitem3dv2.1", resolution: "512" } }).hitem3d.resolution).toBe("1536fast");
        expect(sanitizeSettings({ hitem3d: { model: "hitem3dv1.5", resolution: "512" } }).hitem3d.resolution).toBe("512");
        expect(sanitizeSettings({ hitem3d: { model: "unknown" } }).hitem3d.model).toBe("hi3dv3.0");
        expect(sanitizeSettings({ hitem3d: { face: 5 } }).hitem3d.face).toBe(100_000);
        expect(sanitizeSettings({ hitem3d: { face: 0 } }).hitem3d.face).toBe(0);
    });

    it("merges patches deeply but replaces the custom workflow wholesale", () => {
        const a = mergeSettings(DEFAULT_SETTINGS, { comfyui: { customWorkflow: { "1": { class_type: "A", inputs: {} } } } });
        const b = mergeSettings(a, { comfyui: { customWorkflow: { "2": { class_type: "B", inputs: {} } } }, meshy: { enablePbr: false } });
        expect(Object.keys(b.comfyui.customWorkflow!)).toEqual(["2"]);
        expect(b.meshy.enablePbr).toBe(false);
        expect(b.meshy.aiModel).toBe("latest");
    });

    it("normalises URLs and previews secrets without revealing them", () => {
        expect(normalizeUrl("https://api.example.com///", "x")).toBe("https://api.example.com");
        expect(normalizeUrl("", "fallback")).toBe("fallback");
        expect(normalizeUrl("http://[bad", "fallback")).toBe("fallback");
        expect(secretPreview("msy_1234567890abcd")).toBe("msy_…abcd");
        expect(secretPreview("short")).toBe("•••••");
        expect(secretPreview("")).toBe("");
    });
});

describe("layer XMP", () => {
    const state: LayerState = {
        v: 1,
        libraryId: "lib_x",
        modelName: 'Chair "deluxe" <&> 椅子',
        origin: "meshy",
        remoteId: "abc",
        settings: settingsForNewModel(undefined, 2048),
        updatedAt: 1,
    };

    it("round-trips state through a fresh packet", () => {
        const xmp = writeLayerStateXmp("", state);
        expect(xmp).toContain("<ps3d:state>");
        expect(xmp).not.toContain('"deluxe"');
        expect(readLayerStateXmp(xmp)).toEqual(state);
    });

    it("replaces existing state and keeps other metadata", () => {
        const other = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:format>x</dc:format></rdf:Description></rdf:RDF></x:xmpmeta>';
        const first = writeLayerStateXmp(other, state);
        const second = writeLayerStateXmp(first, { ...state, modelName: "Updated" });
        expect(second).toContain("<dc:format>x</dc:format>");
        expect(second.match(/<ps3d:state>/g)).toHaveLength(1);
        expect(readLayerStateXmp(second)?.modelName).toBe("Updated");
        const removed = removeLayerStateXmp(second);
        expect(readLayerStateXmp(removed)).toBeNull();
        expect(removed).toContain("<dc:format>x</dc:format>");
        expect(removeLayerStateXmp(writeLayerStateXmp("", state))).toBe("");
    });

    it("ignores foreign or broken metadata", () => {
        expect(readLayerStateXmp(undefined)).toBeNull();
        expect(readLayerStateXmp("<ps3d:state>{not json</ps3d:state>")).toBeNull();
        expect(readLayerStateXmp('<ps3d:state>{"v":2}</ps3d:state>')).toBeNull();
    });
});

describe("semver", () => {
    it("parses and compares release tags", () => {
        expect(parseVersion("v1.2.3")).toMatchObject({ major: 1, minor: 2, patch: 3 });
        expect(parseVersion("1.2")).toBeNull();
        expect(compareVersions("v0.2.0", "0.1.9")).toBe(1);
        expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
        expect(compareVersions("1.0.0-beta.2", "1.0.0")).toBe(-1);
        expect(compareVersions("1.0.0-beta.10", "1.0.0-beta.2")).toBe(1);
        expect(compareVersions("1.0.0-alpha", "1.0.0-beta")).toBe(-1);
        expect(compareVersions("garbage", "0.0.1")).toBe(-1);
        expect(isPrerelease("2.0.0-rc.1")).toBe(true);
        expect(isPrerelease("2.0.0")).toBe(false);
    });
});

describe("bytes and utf8", () => {
    it("base64 matches Node for many sizes", () => {
        for (const n of [0, 1, 2, 3, 4, 5, 100, 98_305, 300_001]) {
            const data = new Uint8Array(n).map((_, i) => (i * 37 + 11) & 255);
            const b64 = bytesToBase64(data);
            expect(b64).toBe(Buffer.from(data).toString("base64"));
            expect(Buffer.from(base64ToBytes(b64)).equals(Buffer.from(data))).toBe(true);
        }
        expect(Buffer.from(base64ToBytes("data:image/png;base64,AQID")).toJSON().data).toEqual([1, 2, 3]);
        expect(() => base64ToBytes("**")).toThrow();
    });

    it("utf8 matches TextEncoder/TextDecoder", () => {
        for (const s of ["", "abc", "Grüße", "椅子のモデル", "emoji 🧊🪓 ok", "\u{10FFFF}"]) {
            const enc = encodeUtf8(s);
            expect(Buffer.from(enc).equals(Buffer.from(new TextEncoder().encode(s)))).toBe(true);
            expect(decodeUtf8(enc)).toBe(s);
        }
        expect(decodeUtf8(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]))).toBe("A");
        const big = "x".repeat(50_000) + "ü";
        expect(decodeUtf8(encodeUtf8(big))).toBe(big);
    });

    it("sniffs formats from content, not names", () => {
        expect(sniffFormat(new Uint8Array([0x67, 0x6c, 0x54, 0x46]))).toBe("glb");
        expect(sniffFormat(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]))).toBe("png");
        expect(sniffFormat(new Uint8Array([0xff, 0xd8, 0xff, 0]))).toBe("jpg");
        expect(sniffFormat(new Uint8Array([0x50, 0x4b, 3, 4]))).toBe("zip");
        expect(sniffFormat(new TextEncoder().encode('  {"asset":{}}'))).toBe("gltf");
        expect(sniffFormat(new TextEncoder().encode("<html>"))).toBeNull();
    });

    it("formats sizes and slugs", () => {
        expect(formatBytes(512)).toBe("512 B");
        expect(formatBytes(30_332_824)).toBe("29 MB");
        expect(slug("Wooden Chair — v2!")).toBe("wooden-chair-v2");
        expect(slug("???")).toBe("model");
    });
});

/** Minimal PNG reader for tests: supports filter types None and Up. */
function decodePng(png: Uint8Array) {
    const v = new DataView(png.buffer, png.byteOffset, png.byteLength);
    let o = 8;
    let width = 0;
    let height = 0;
    let channels = 0;
    const idat: Buffer[] = [];
    while (o < png.length) {
        const len = v.getUint32(o);
        const type = Buffer.from(png.subarray(o + 4, o + 8)).toString("ascii");
        const data = png.subarray(o + 8, o + 8 + len);
        if (type === "IHDR") {
            width = new DataView(data.buffer, data.byteOffset).getUint32(0);
            height = new DataView(data.buffer, data.byteOffset).getUint32(4);
            channels = { 0: 1, 4: 2, 2: 3, 6: 4 }[data[9]]!;
        }
        if (type === "IDAT") idat.push(Buffer.from(data));
        o += 12 + len;
    }
    const raw = inflateSync(Buffer.concat(idat));
    const stride = width * channels;
    const out = new Uint8Array(stride * height);
    for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)];
        for (let x = 0; x < stride; x++) {
            const val = raw[y * (stride + 1) + 1 + x];
            out[y * stride + x] = filter === 2 && y > 0 ? (val + out[(y - 1) * stride + x]) & 255 : val;
        }
    }
    return { width, height, channels, pixels: out };
}

describe("png", () => {
    it("encodes RGBA losslessly with a valid CRC", () => {
        const w = 37;
        const h = 23;
        const px = new Uint8Array(w * h * 4).map((_, i) => (i * 13) & 255);
        const png = encodePng(px, w, h, 4);
        expect(pngSize(png)).toEqual({ width: w, height: h });
        const decoded = decodePng(png);
        expect(decoded.channels).toBe(4);
        expect(Buffer.from(decoded.pixels).equals(Buffer.from(px))).toBe(true);
        // IHDR CRC check
        const crcExpected = Buffer.from(png.subarray(29, 33)).readUInt32BE(0);
        const crc = (data: Uint8Array) => {
            let c = ~0;
            for (const b of data) {
                c ^= b;
                for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            }
            return ~c >>> 0;
        };
        expect(crc(png.subarray(12, 29))).toBe(crcExpected);
    });

    it("encodes RGB and rejects short buffers", () => {
        const px = new Uint8Array(4 * 4 * 3).fill(200);
        expect(decodePng(encodePng(px, 4, 4, 3)).channels).toBe(3);
        expect(() => encodePng(new Uint8Array(3), 4, 4, 3)).toThrow();
    });

    it("multiplies alpha by a selection mask", () => {
        const rgb = new Uint8Array([10, 20, 30, 40, 50, 60]);
        const out = applyMask(rgb, 3, new Uint8Array([255, 128]), 2, 1);
        expect(Array.from(out)).toEqual([10, 20, 30, 255, 40, 50, 60, 128]);
        const rgba = applyMask(new Uint8Array([1, 2, 3, 200]), 4, new Uint8Array([128]), 1, 1);
        expect(rgba[3]).toBe(Math.round((200 * 128) / 255));
    });
});

describe("placement", () => {
    it("fits the object, not the frame, into the target", () => {
        const render = { width: 1000, height: 1000 };
        const content = { left: 400, top: 300, right: 600, bottom: 700 }; // 200×400 object
        const target = { left: 100, top: 100, right: 300, bottom: 300 }; // 200×200 box
        const f = frameForTarget(render, content, target);
        // scale 0.5 → frame 500×500, object centre (500,500)·0.5 lands on (200,200)
        expect(f).toEqual({ left: -50, top: -50, right: 450, bottom: 450 });
    });

    it("falls back to the whole frame without content bounds", () => {
        expect(frameForTarget({ width: 100, height: 50 }, undefined, { left: 0, top: 0, right: 200, bottom: 200 })).toEqual({ left: 0, top: 50, right: 200, bottom: 150 });
        expect(centeredTarget(1000, 500, 0.5)).toEqual({ left: 250, top: 125, right: 750, bottom: 375 });
    });

    it("finds the alpha bounding box", () => {
        const w = 4;
        const h = 3;
        const px = new Uint8Array(w * h * 4);
        px[(1 * w + 2) * 4 + 3] = 255;
        px[(2 * w + 1) * 4 + 3] = 255;
        expect(alphaBounds(px, w, h)).toEqual({ left: 1, top: 1, right: 3, bottom: 3 });
        expect(alphaBounds(new Uint8Array(16), 2, 2)).toBeUndefined();
    });
});

describe("sha256", () => {
    it("matches node:crypto", () => {
        for (const n of [0, 3, 55, 56, 63, 64, 65, 1000, 100_003]) {
            const data = new Uint8Array(n).map((_, i) => (i * 7) & 255);
            expect(sha256Hex(data)).toBe(createHash("sha256").update(data).digest("hex"));
        }
    });
    it("parses sha256sum files", () => {
        const map = parseChecksums(`${"a".repeat(64)}  plugin.ccx\n${"B".repeat(64)} *other.txt\nnot a line\n`);
        expect(map.get("plugin.ccx")).toBe("a".repeat(64));
        expect(map.get("other.txt")).toBe("b".repeat(64));
        expect(map.size).toBe(2);
    });
});

describe("3D settings helpers", () => {
    it("builds new-model settings from remembered lighting", () => {
        const s = settingsForNewModel({ lightColor: "#ff0000" }, 99999);
        expect(s.lightColor).toBe("#ff0000");
        expect(s.resolution).toEqual({ width: 8192, height: 8192 });
        expect(lightingOf(s).environment).toBe("city");
        expect(clampResolution({ width: NaN, height: 10 })).toEqual({ width: 2048, height: 64 });
        expect(vecLength({ x: 0, y: 0, z: 0 })).toBe(1);
        expect(vecLength(vecScaleTo({ x: 3, y: 4, z: 0 }, 10))).toBeCloseTo(10);
    });
});
