/**
 * Photoshop notifications the plugin reacts to.
 *
 * - Double-clicking a smart object's thumbnail fires "placedLayerEditContents"
 *   { documentID, layerID } right after Photoshop opened the contents as a .psb.
 *   For 3D layers the plugin closes that .psb and opens the 3D editor instead
 *   (Settings → Editor → "Double-click opens the 3D editor").
 * - Layer/document/selection changes refresh the panel's "what will be sent" view.
 *
 * UXP refuses "all" as an event list, so the events are named explicitly.
 */
import { addListener, type Descriptor } from "./photoshop";

export const CONTEXT_EVENTS = [
    "select",
    "make",
    "delete",
    "close",
    "open",
    "set",
    "placeEvent",
    "placedLayerReplaceContents",
    "newPlacedLayer",
    "duplicate",
    "move",
    "transform",
    "hide",
    "show",
    "rasterizeLayer",
    "mergeLayersNew",
] as const;

export type EditContentsEvent = { docId: number; layerId: number };

export async function listenForEditContents(fn: (e: EditContentsEvent) => void): Promise<void> {
    await addListener(["placedLayerEditContents"], (_name: string, d: Descriptor) => {
        const docId = Number(d.documentID);
        const layerId = Number(d.layerID);
        if (Number.isFinite(docId) && Number.isFinite(layerId)) fn({ docId, layerId });
    });
}

/** Calls `fn` (debounced) whenever the document/layer/selection might have changed. */
export async function listenForContextChanges(fn: () => void, debounceMs = 250): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    await addListener([...CONTEXT_EVENTS], () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            fn();
        }, debounceMs);
    });
}
