import { describe, expect, it } from "vitest";
import { fakeGlb } from "../../../tests/unit/helpers";
import { MemoryFileStore, readJson } from "../platform/fileStore";
import { MemoryLogger } from "../platform/logger";
import { extOf, isSelfContainedGltf, stripExt } from "@shared/modelFormats";
import { Library } from "./library";
import { ModelImporter, type FsEntry, type ImportFs } from "./modelImport";

/** A folder tree in memory, addressed by Windows-style native paths. */
function memoryFs(files: Record<string, Uint8Array | string>): ImportFs & { reads: string[] } {
    const bytes = (v: Uint8Array | string) => (typeof v === "string" ? new TextEncoder().encode(v) : v);
    const reads: string[] = [];
    return {
        sep: "\\",
        reads,
        async list(folder, withMeta) {
            const prefix = `${folder}\\`;
            const names = new Map<string, FsEntry>();
            for (const [path, value] of Object.entries(files)) {
                if (!path.startsWith(prefix)) continue;
                const [first, ...rest] = path.slice(prefix.length).split("\\");
                names.set(first, rest.length ? { name: first, isFolder: true } : { name: first, isFolder: false, ...(withMeta ? { size: bytes(value).byteLength, modified: 1000 } : {}) });
            }
            if (!names.size && !Object.keys(files).some((p) => p.startsWith(prefix))) throw new Error(`No folder ${folder}`);
            return [...names.values()];
        },
        async readBytes(path) {
            reads.push(path);
            const v = files[path];
            if (v === undefined) throw new Error(`No file ${path}`);
            return bytes(v);
        },
        fileUrl: (path) => `file:///${path.replace(/\\/g, "/")}`,
    };
}

function setup(files: Record<string, Uint8Array | string>) {
    const store = new MemoryFileStore();
    const log = new MemoryLogger();
    const library = new Library(store, log);
    const fs = memoryFs(files);
    const importer = new ModelImporter({ fs, library, store, log, inboxPath: "C:\\data\\library\\Import", now: () => 5 });
    return { store, library, fs, importer };
}

describe("model formats", () => {
    it("names files and recognises self-contained glTF", () => {
        expect(extOf("C:\\a\\Chair.FBX")).toBe("fbx");
        expect(extOf("noext")).toBe("");
        expect(stripExt("C:\\a\\my.chair.obj")).toBe("my.chair");
        expect(isSelfContainedGltf({ buffers: [{ uri: "data:application/octet-stream;base64,AA" }], images: [{ bufferView: 1 }] })).toBe(true);
        expect(isSelfContainedGltf({ buffers: [{ uri: "chair.bin" }] })).toBe(false);
    });
});

describe("model import", () => {
    it("stores GLB directly and hands other formats to the panel with their textures", async () => {
        const { importer, library } = setup({
            "D:\\models\\robot.glb": fakeGlb(),
            "D:\\models\\chair\\chair.fbx": "fbx",
            "D:\\models\\chair\\textures\\wood.jpg": "jpg",
            "D:\\models\\chair\\notes.txt": "x",
            "D:\\models\\chair\\chair.mtl": "mtl",
        });
        const batch = await importer.importFiles(["D:\\models\\robot.glb", "D:\\models\\chair\\chair.fbx", "D:\\models\\chair\\notes.txt"]);
        expect(batch.imported.map((i) => i.name)).toEqual(["robot"]);
        expect(library.list()[0].meta).toMatchObject({ importedFrom: "D:\\models\\robot.glb", sourceFormat: "glb" });
        expect(batch.failed).toEqual([{ name: "notes.txt", error: "not a supported 3D file" }]);
        const [fbx] = batch.toConvert;
        expect(fbx).toMatchObject({ name: "chair", ext: "fbx", url: "file:///D:/models/chair/chair.fbx" });
        expect(fbx.resources.map((r) => r.name).sort()).toEqual(["chair.mtl", "textures/wood.jpg"]);

        // Only files of this import can be read back.
        expect(await importer.readFile(fbx.id, "D:\\models\\chair\\textures\\wood.jpg")).toBeInstanceOf(Uint8Array);
        await expect(importer.readFile(fbx.id, "D:\\models\\robot.glb")).rejects.toThrow(/not part of this import/);

        const item = await importer.addConverted(fbx.id, "chair", fakeGlb(), "fbx", ["Missing texture: bump.png"]);
        expect(item.meta).toMatchObject({ importedFrom: "D:\\models\\chair\\chair.fbx", sourceFormat: "fbx", convertedToGlb: true, notes: ["Missing texture: bump.png"] });
        await expect(importer.addConverted(fbx.id, "chair", fakeGlb(), "fbx")).rejects.toThrow(/no longer active/);
    });

    it("stores a self-contained .gltf and converts one with external files", async () => {
        const inline = JSON.stringify({ asset: { version: "2.0" }, buffers: [{ uri: "data:application/octet-stream;base64,AAAA" }] });
        const external = JSON.stringify({ asset: { version: "2.0" }, buffers: [{ uri: "a.bin" }] });
        const { importer } = setup({ "D:\\m\\inline.gltf": inline, "D:\\m\\ext.gltf": external, "D:\\m\\a.bin": "bin" });
        const batch = await importer.importFiles(["D:\\m\\inline.gltf", "D:\\m\\ext.gltf"]);
        expect(batch.imported.map((i) => [i.name, i.format])).toEqual([["inline", "gltf"]]);
        expect(batch.toConvert.map((s) => [s.name, s.resources.map((r) => r.name)])).toEqual([["ext", ["a.bin"]]]);
    });

    it("imports every model in a folder", async () => {
        const { importer } = setup({ "D:\\kit\\a.glb": fakeGlb(), "D:\\kit\\sub\\b.obj": "obj", "D:\\kit\\sub\\deeper\\c.stl": "stl", "D:\\kit\\readme.md": "x" });
        const batch = await importer.importFolder("D:\\kit");
        expect(batch.imported.map((i) => i.name)).toEqual(["a"]);
        expect(batch.toConvert.map((s) => s.name).sort()).toEqual(["b", "c"]);
        expect((await importer.importFolder("D:\\kit\\sub\\deeper\\..\\..\\empty").catch((e: Error) => e)).toString()).toMatch(/No folder/);
    });

    it("imports new files from the Import folder once, and again when they change", async () => {
        const files: Record<string, Uint8Array | string> = { "C:\\data\\library\\Import\\boat.glb": fakeGlb(), "C:\\data\\library\\Import\\props\\lamp.obj": "obj" };
        const { importer, store, library } = setup(files);
        const first = await importer.scanInbox();
        expect(await store.readText("library/Import/README.txt")).toMatch(/added to the\s+Geekatplay 3D Layers library/);
        expect(first.imported.map((i) => i.name)).toEqual(["boat"]);
        expect(first.toConvert.map((s) => s.name)).toEqual(["lamp"]);

        // While the panel converts lamp.obj, a second scan does not offer it again.
        expect((await importer.scanInbox()).toConvert).toEqual([]);
        await importer.importFailed(first.toConvert[0].id, "No geometry found in this file.");
        const ledger = await readJson<{ files: Record<string, { error?: string; libraryId?: string }> }>(store, "import-ledger.json");
        expect(ledger!.files["props/lamp.obj"].error).toBe("No geometry found in this file.");
        expect(ledger!.files["boat.glb"].libraryId).toBe(library.list()[0].id);

        // Nothing new: nothing imported. A changed file is imported again.
        expect(await importer.scanInbox()).toEqual({ imported: [], toConvert: [], failed: [] });
        files["C:\\data\\library\\Import\\props\\lamp.obj"] = "obj v2";
        expect((await importer.scanInbox()).toConvert.map((s) => s.name)).toEqual(["lamp"]);
    });
});
