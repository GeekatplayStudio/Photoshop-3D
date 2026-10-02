/**
 * Thin, typed access to the Photoshop UXP API. Every batchPlay descriptor the plugin
 * sends is in src/host/ps/*, so it is easy to audit what the plugin does to documents.
 */
import { action, app, constants, core, imaging } from "photoshop";

export { app, constants, imaging };

export type Rect = { left: number; top: number; right: number; bottom: number };

export type Descriptor = Record<string, unknown>;

export async function batchPlay(commands: Descriptor[]): Promise<Descriptor[]> {
    const result = (await action.batchPlay(commands, {})) as Descriptor[];
    for (const r of result) {
        if (r && r._obj === "error") throw new Error(`Photoshop: ${String(r.message ?? "command failed")} (${String(r.result ?? "")})`);
    }
    return result;
}

/** Runs `fn` as a modal Photoshop command; with `historyName`, all steps undo as one. */
export async function modal<T>(commandName: string, fn: () => Promise<T>, historyName?: { docId: number; name: string }): Promise<T> {
    return core.executeAsModal(
        async (ctx: { hostControl: { suspendHistory(o: { documentID: number; name: string }): Promise<number>; resumeHistory(id: number, commit?: boolean): Promise<void> } }) => {
            if (!historyName) return fn();
            const suspension = await ctx.hostControl.suspendHistory({ documentID: historyName.docId, name: historyName.name });
            try {
                const value = await fn();
                await ctx.hostControl.resumeHistory(suspension, true);
                return value;
            } catch (err) {
                await ctx.hostControl.resumeHistory(suspension, false).catch(() => undefined);
                throw err;
            }
        },
        { commandName },
    ) as Promise<T>;
}

export function addListener(events: string[], fn: (event: string, descriptor: Descriptor) => void): Promise<void> {
    return action.addNotificationListener(events, fn);
}

export const layerRef = (layerId: number, docId: number) => [{ _ref: "layer", _id: layerId }, { _ref: "document", _id: docId }];

export function findLayer(layers: any[], id: number): any | null {
    for (const layer of layers ?? []) {
        if (layer.id === id) return layer;
        const inGroup = layer.layers && findLayer(layer.layers, id);
        if (inGroup) return inGroup;
    }
    return null;
}

export function documentById(docId: number): any | null {
    return Array.from(app.documents as Iterable<any>).find((d: any) => d.id === docId) ?? null;
}

export function rectOf(b: any): Rect {
    return { left: Number(b.left), top: Number(b.top), right: Number(b.right), bottom: Number(b.bottom) };
}

/** Selection bounds in document pixels clipped to the canvas, or null without a selection. */
export async function selectionBounds(doc: any): Promise<Rect | null> {
    const [info] = await batchPlay([{ _obj: "get", _target: [{ _property: "selection" }, { _ref: "document", _id: doc.id }] }]);
    const s = (info as any)?.selection;
    if (!s?.right) return null;
    const v = (x: any) => (typeof x === "number" ? x : Number(x?._value ?? 0));
    const r = {
        left: Math.max(0, Math.floor(v(s.left))),
        top: Math.max(0, Math.floor(v(s.top))),
        right: Math.min(doc.width, Math.ceil(v(s.right))),
        bottom: Math.min(doc.height, Math.ceil(v(s.bottom))),
    };
    return r.right > r.left && r.bottom > r.top ? r : null;
}

/** Smart object placement: the 4 corner points of the placed frame and its content size. */
export async function smartObjectFrame(docId: number, layerId: number): Promise<{ corners: number[]; width: number; height: number } | null> {
    try {
        const [res] = await batchPlay([{ _obj: "get", _target: [{ _property: "smartObjectMore" }, ...layerRef(layerId, docId)] }]);
        const more = (res as any)?.smartObjectMore;
        if (!more?.transform) return null;
        return { corners: (more.transform as number[]).map(Number), width: Number(more.size?.width ?? 0), height: Number(more.size?.height ?? 0) };
    } catch {
        return null;
    }
}

export const cornersRect = (c: number[]): Rect => ({
    left: Math.min(c[0], c[2], c[4], c[6]),
    top: Math.min(c[1], c[3], c[5], c[7]),
    right: Math.max(c[0], c[2], c[4], c[6]),
    bottom: Math.max(c[1], c[3], c[5], c[7]),
});
