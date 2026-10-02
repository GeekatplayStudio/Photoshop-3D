/**
 * 3D layers in the document: place a render as a smart object, replace it after
 * re-posing (keeping the user's position/scale), and keep the pose + lighting in
 * the layer's XMP so it can be reopened any time — even after saving the PSD.
 */
import { readLayerStateXmp, removeLayerStateXmp, writeLayerStateXmp } from "@shared/xmp";
import { boxHeight, boxWidth, centeredTarget, frameForTarget, type Box } from "@shared/placement";
import type { LayerState, PlaceResult, PsContext } from "@shared/types";
import { app, batchPlay, constants, cornersRect, documentById, findLayer, layerRef, modal, selectionBounds, smartObjectFrame } from "./photoshop";

export async function readLayerXmp(docId: number, layerId: number): Promise<string> {
    try {
        const [res] = await batchPlay([{ _obj: "get", _target: [{ _property: "XMPMetadataAsUTF8" }, ...layerRef(layerId, docId)] }]);
        const xmp = (res as Record<string, unknown>)?.XMPMetadataAsUTF8;
        return typeof xmp === "string" ? xmp : "";
    } catch {
        return "";
    }
}

export async function readLayerState(docId: number, layerId: number): Promise<LayerState | null> {
    return readLayerStateXmp(await readLayerXmp(docId, layerId));
}

/** Must run inside a modal scope. */
async function writeLayerXmp(docId: number, layerId: number, xmp: string) {
    await batchPlay([
        {
            _obj: "set",
            _target: [{ _ref: "property", _property: "XMPMetadataAsUTF8" }, ...layerRef(layerId, docId)],
            to: { _obj: "layer", XMPMetadataAsUTF8: xmp },
        },
    ]);
}

export async function getContext(): Promise<PsContext> {
    if (!app.documents.length) return { hasDocument: false, hasSelection: false, is3DLayer: false };
    const doc = app.activeDocument;
    const layer = doc.activeLayers?.[0];
    let state: LayerState | null = null;
    if (layer) state = await readLayerState(doc.id, layer.id);
    let hasSelection = false;
    try {
        hasSelection = !!(await selectionBounds(doc));
    } catch {
        hasSelection = false;
    }
    return {
        hasDocument: true,
        docId: doc.id,
        docTitle: doc.title,
        docWidth: Number(doc.width),
        docHeight: Number(doc.height),
        layerId: layer?.id,
        layerName: layer?.name,
        layerKind: layer ? String(layer.kind) : undefined,
        hasSelection,
        is3DLayer: !!state,
        modelName: state?.modelName,
    };
}

export type RenderFile = {
    /** batchPlay session token of the PNG on disk. */
    token: string;
    width: number;
    height: number;
    /** Where the object is inside the render (render pixels). */
    contentBounds?: Box;
};

async function fitFrame(docId: number, layer: any, desired: Box) {
    let frame = await smartObjectFrame(docId, layer.id);
    if (!frame) return;
    let current = cornersRect(frame.corners);
    if (boxWidth(current) > 0 && Math.abs(boxWidth(current) - boxWidth(desired)) > 0.5) {
        const pct = (boxWidth(desired) / boxWidth(current)) * 100;
        await layer.scale(pct, pct, constants.AnchorPosition.TOPLEFT);
        frame = await smartObjectFrame(docId, layer.id);
        if (!frame) return;
        current = cornersRect(frame.corners);
    }
    const dx = desired.left - current.left;
    const dy = desired.top - current.top;
    if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) await layer.translate(dx, dy);
}

/**
 * Places a render into the active document as a new smart object layer named after the
 * model, fitted into `target` (document pixels) or the middle of the canvas.
 */
export async function placeRender(render: RenderFile, state: LayerState, layerName: string, target?: Box & { docId?: number }): Promise<PlaceResult> {
    if (!app.documents.length) throw new Error("Open a document to place the 3D model in.");
    const doc = (target?.docId && documentById(target.docId)) || app.activeDocument;
    return modal(
        "Place 3D Model",
        async () => {
            if (app.activeDocument.id !== doc.id) app.activeDocument = doc;
            await batchPlay([
                {
                    _obj: "placeEvent",
                    null: { _path: render.token, _kind: "local" },
                    freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" },
                    offset: { _obj: "offset", horizontal: { _unit: "pixelsUnit", _value: 0 }, vertical: { _unit: "pixelsUnit", _value: 0 } },
                    _options: { dialogOptions: "dontDisplay" },
                },
            ]);
            const layer = doc.activeLayers[0];
            layer.name = layerName;
            const box = target && boxWidth(target) > 1 && boxHeight(target) > 1 ? target : centeredTarget(Number(doc.width), Number(doc.height));
            await fitFrame(doc.id, layer, frameForTarget(render, render.contentBounds, box));
            await writeLayerXmp(doc.id, layer.id, writeLayerStateXmp("", state));
            return { docId: doc.id, layerId: layer.id, layerName: layer.name, updated: false };
        },
        { docId: doc.id, name: "Place 3D Model" },
    );
}

/** Swaps the render inside an existing 3D smart object, keeping its placement. */
export async function replaceRender(docId: number, layerId: number, render: RenderFile, state: LayerState): Promise<PlaceResult> {
    const doc = documentById(docId);
    if (!doc) throw new Error("The document with this 3D layer is no longer open.");
    const layer = findLayer(doc.layers, layerId);
    if (!layer) throw new Error("The 3D layer was deleted.");
    const isSmart = String(layer.kind).toLowerCase().includes("smart");
    if (!isSmart) {
        // Rasterized since it was placed: put the new render on top, at the same spot.
        const b = layer.boundsNoEffects ?? layer.bounds;
        return placeRender(render, state, layer.name, { left: b.left, top: b.top, right: b.right, bottom: b.bottom, docId });
    }
    return modal(
        "Update 3D Layer",
        async () => {
            if (app.activeDocument.id !== docId) app.activeDocument = doc;
            const before = await smartObjectFrame(docId, layerId);
            const existingXmp = await readLayerXmp(docId, layerId);
            await batchPlay([{ _obj: "select", _target: [{ _ref: "layer", _id: layerId }], makeVisible: false }]);
            await batchPlay([{ _obj: "placedLayerReplaceContents", null: { _path: render.token, _kind: "local" }, _options: { dialogOptions: "dontDisplay" } }]);
            const updated = doc.activeLayers[0] ?? layer;
            if (before) {
                // Same frame on screen even if the export resolution changed.
                await fitFrame(docId, updated, cornersRect(before.corners));
            }
            await writeLayerXmp(docId, updated.id, writeLayerStateXmp(existingXmp, state));
            return { docId, layerId: updated.id, layerName: updated.name, updated: true };
        },
        { docId, name: "Update 3D Layer" },
    );
}

/** Removes the 3D state from the active layer (it becomes a normal smart object). */
export async function detach3D(): Promise<void> {
    if (!app.documents.length) return;
    const doc = app.activeDocument;
    const layer = doc.activeLayers?.[0];
    if (!layer) return;
    const xmp = await readLayerXmp(doc.id, layer.id);
    await modal("Detach 3D Data", () => writeLayerXmp(doc.id, layer.id, removeLayerStateXmp(xmp)), { docId: doc.id, name: "Detach 3D Data" });
}

/** Closes a document without saving (the .psb Photoshop opened on double-click). */
export async function closeWithoutSaving(docId: number): Promise<void> {
    const doc = documentById(docId);
    if (!doc) return;
    await modal("Close Smart Object", async () => {
        await doc.closeWithoutSaving();
    });
}

/** Must run inside a modal scope. */
function activateDocument(docId: number) {
    const doc = documentById(docId);
    if (doc && app.activeDocument?.id !== docId) app.activeDocument = doc;
}

export function documentInfo(docId?: number): { title: string; width: number; height: number } | undefined {
    const doc = docId ? documentById(docId) : app.documents.length ? app.activeDocument : null;
    return doc ? { title: String(doc.title), width: Number(doc.width), height: Number(doc.height) } : undefined;
}

export async function selectLayer(docId: number, layerId: number) {
    await modal("Select 3D Layer", async () => {
        activateDocument(docId);
        await batchPlay([{ _obj: "select", _target: [{ _ref: "layer", _id: layerId }], makeVisible: false }]);
    });
}
