/**
 * Reads what the user wants to turn into 3D: the active layer, or what is visible
 * inside the selection (masked by the selection, so soft edges stay soft). Pixels are
 * read as 8-bit sRGB with imaging.getPixels and encoded to PNG with alpha.
 */
import { bytesToBase64 } from "@shared/bytes";
import { applyMask, encodePng } from "@shared/png";
import type { SendSource, SourceTarget } from "@shared/types";
import { app, constants, imaging, modal, rectOf, selectionBounds, type Rect } from "./photoshop";

const SRGB = "sRGB IEC61966-2.1";

export type SourceImage = {
    png: Uint8Array;
    width: number;
    height: number;
    hasAlpha: boolean;
    /** "Chair" / "Chair (selection)". */
    name: string;
    target: SourceTarget;
    /** Small PNG data URL for the job list. */
    preview: string;
};

function to8bit(pixels: Uint8Array | Uint16Array | Float32Array, componentSize: number): Uint8Array {
    if (componentSize === 8) return pixels as Uint8Array;
    const out = new Uint8Array(pixels.length);
    if (componentSize === 16) for (let i = 0; i < pixels.length; i++) out[i] = Math.min(255, Math.round((pixels[i] as number) / 128.5));
    else for (let i = 0; i < pixels.length; i++) out[i] = Math.max(0, Math.min(255, Math.round((pixels[i] as number) * 255)));
    return out;
}

/** Converts chunky pixels with any component count to RGBA. */
function toRgba(px: Uint8Array, components: number, count: number): Uint8Array {
    if (components === 4) return px;
    const out = new Uint8Array(count * 4);
    for (let i = 0, p = 0, o = 0; i < count; i++, p += components, o += 4) {
        if (components >= 3) {
            out[o] = px[p];
            out[o + 1] = px[p + 1];
            out[o + 2] = px[p + 2];
        } else {
            out[o] = out[o + 1] = out[o + 2] = px[p];
        }
        out[o + 3] = components === 2 ? px[p + 1] : 255;
    }
    return out;
}

/** Box-filter downscale of RGBA to fit `max` (for previews). */
export function downscaleRgba(rgba: Uint8Array, width: number, height: number, max: number): { data: Uint8Array; width: number; height: number } {
    const scale = Math.min(1, max / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    if (scale === 1) return { data: rgba, width, height };
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
        const y0 = Math.floor((y * height) / h);
        const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / h));
        for (let x = 0; x < w; x++) {
            const x0 = Math.floor((x * width) / w);
            const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / w));
            let r = 0, g = 0, b = 0, a = 0, n = 0;
            for (let yy = y0; yy < y1; yy++) {
                for (let xx = x0; xx < x1; xx++) {
                    const i = (yy * width + xx) * 4;
                    const alpha = rgba[i + 3];
                    r += rgba[i] * alpha;
                    g += rgba[i + 1] * alpha;
                    b += rgba[i + 2] * alpha;
                    a += alpha;
                    n++;
                }
            }
            const o = (y * w + x) * 4;
            if (a > 0) {
                out[o] = Math.round(r / a);
                out[o + 1] = Math.round(g / a);
                out[o + 2] = Math.round(b / a);
            }
            out[o + 3] = Math.round(a / n);
        }
    }
    return { data: out, width: w, height: h };
}

function chooseSource(source: SendSource, hasSelection: boolean): "layer" | "selection" {
    if (source === "selection" && !hasSelection) throw new Error("There is no active selection. Make a selection, or switch the source to Layer.");
    if (source === "auto") return hasSelection ? "selection" : "layer";
    return source;
}

/**
 * Reads the source pixels. `maxEdge` limits the longest side (providers have size limits
 * and large uploads are slow); 0 = full size.
 */
export async function readSource(source: SendSource, maxEdge: number): Promise<SourceImage> {
    if (!app.documents.length) throw new Error("Open a document in Photoshop first.");
    const doc = app.activeDocument;
    if (doc.bitsPerChannel === constants.BitsPerChannelType?.THIRTYTWO) throw new Error("32-bit documents are not supported. Convert to 8 or 16 bits/channel (Image › Mode).");
    const selection = await selectionBounds(doc);
    const mode = chooseSource(source, !!selection);
    const layer = doc.activeLayers?.[0];
    if (mode === "layer" && !layer) throw new Error("Select a layer (or make a selection) to send.");

    const bounds: Rect = mode === "selection" ? selection! : rectOf(layer.boundsNoEffects ?? layer.bounds);
    const width = bounds.right - bounds.left;
    const height = bounds.bottom - bounds.top;
    if (width <= 0 || height <= 0) throw new Error(`Layer "${layer?.name}" is empty.`);

    const options: Record<string, unknown> = { documentID: doc.id, colorSpace: "RGB", colorProfile: SRGB, sourceBounds: bounds, componentSize: 8 };
    if (mode === "layer") options.layerID = layer.id;
    if (maxEdge > 0 && Math.max(width, height) > maxEdge) options.targetSize = width >= height ? { width: maxEdge } : { height: maxEdge };

    return modal("Read pixels for 3D", async () => {
        const { imageData } = await imaging.getPixels(options);
        let rgba: Uint8Array;
        let w: number;
        let h: number;
        try {
            const raw = await imageData.getData({ chunky: true, fullRange: true });
            w = imageData.width;
            h = imageData.height;
            const px = to8bit(raw, imageData.componentSize ?? 8);
            rgba = toRgba(px, imageData.components, w * h);
        } finally {
            imageData.dispose();
        }

        if (mode === "selection") {
            const sel = await imaging.getSelection({ documentID: doc.id, sourceBounds: bounds, ...(options.targetSize ? { targetSize: options.targetSize } : {}) });
            try {
                const mask = to8bit(await sel.imageData.getData({ chunky: true, fullRange: true }), sel.imageData.componentSize ?? 8);
                if (sel.imageData.width === w && sel.imageData.height === h) rgba = applyMask(rgba, 4, mask, w, h);
            } finally {
                sel.imageData.dispose();
            }
        }

        let hasAlpha = false;
        for (let i = 3; i < rgba.length; i += 4) {
            if (rgba[i] < 250) {
                hasAlpha = true;
                break;
            }
        }
        const png = encodePng(rgba, w, h, 4);
        const small = downscaleRgba(rgba, w, h, 160);
        const preview = `data:image/png;base64,${bytesToBase64(encodePng(small.data, small.width, small.height, 4, 4))}`;
        const baseName = (layer?.name as string | undefined) ?? String(doc.title).replace(/\.[^.]+$/, "");
        return {
            png,
            width: w,
            height: h,
            hasAlpha,
            name: mode === "selection" ? `${baseName} (selection)` : baseName,
            target: { docId: doc.id, docTitle: doc.title, layerId: layer?.id, bounds },
            preview,
        };
    });
}
