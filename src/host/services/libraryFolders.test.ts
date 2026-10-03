import { describe, expect, it } from "vitest";
import { fakeGlb } from "../../../tests/unit/helpers";
import { MemoryFileStore } from "../platform/fileStore";
import { MemoryLogger } from "../platform/logger";
import { cleanFolderName, normalizeFolder, rebase, withAncestors } from "@shared/libraryFolders";
import { Library } from "./library";

describe("folder paths", () => {
    it("cleans names and paths", () => {
        expect(cleanFolderName('  Sci*Fi: "props"  ')).toBe("Sci Fi props");
        expect(normalizeFolder(" A / /B\\C ")).toBe("A/B/C");
        expect(normalizeFolder(undefined)).toBe("");
        expect(withAncestors("A/B/C")).toEqual(["A", "A/B", "A/B/C"]);
        expect(rebase("A/B/x", "A/B", "C")).toBe("C/x");
        expect(rebase("A/B", "A/B", "")).toBe("");
    });
});

describe("library folders", () => {
    async function setup() {
        const store = new MemoryFileStore();
        const lib = new Library(store, new MemoryLogger());
        await lib.load();
        const a = await lib.add({ name: "Robot", origin: "local", model: fakeGlb() });
        const b = await lib.add({ name: "Lamp", origin: "local", model: fakeGlb(), folder: "Props/Indoor" });
        return { store, lib, a, b };
    }

    it("creates, lists and refuses duplicate folders", async () => {
        const { lib } = await setup();
        expect(lib.folders()).toEqual(["Props", "Props/Indoor"]);
        await lib.createFolder("", "Characters");
        await lib.createFolder("Characters", "Robots");
        expect(lib.folders()).toEqual(["Characters", "Characters/Robots", "Props", "Props/Indoor"]);
        await expect(lib.createFolder("", "characters")).rejects.toThrow(/already a folder named "characters"/);
        await expect(lib.createFolder("", " / ")).rejects.toThrow(/Type a folder name/);
    });

    it("moves models, renames and deletes folders without touching model files", async () => {
        const { lib, a, b, store } = await setup();
        const filesBefore = [...store.files.keys()].filter((k) => k.endsWith("model.glb")).sort();
        await lib.move([a.id], "Characters/Robots");
        expect(lib.get(a.id)!.folder).toBe("Characters/Robots");

        await lib.renameFolder("Characters", "Heroes");
        expect(lib.get(a.id)!.folder).toBe("Heroes/Robots");
        expect(lib.folders()).toContain("Heroes/Robots");
        await expect(lib.renameFolder("Heroes", "props")).rejects.toThrow(/already a folder/);

        await lib.deleteFolder("Props");
        expect(lib.get(b.id)!.folder).toBe("Indoor");
        expect(lib.folders()).not.toContain("Props");

        await lib.move([a.id, b.id], "");
        expect(lib.get(a.id)!.folder).toBeUndefined();
        // The folders stay, now empty.
        expect(lib.folders()).toEqual(["Heroes", "Heroes/Robots", "Indoor"]);
        expect([...store.files.keys()].filter((k) => k.endsWith("model.glb")).sort()).toEqual(filesBefore);
    });

    it("removes several models, keeps their folder, and survives a reload", async () => {
        const { lib, a, b, store } = await setup();
        const changes: string[][] = [];
        lib.onFoldersChange((f) => changes.push(f));
        await lib.removeMany([a.id, b.id]);
        expect(lib.list()).toEqual([]);
        expect(await store.exists(`library/${b.id}`)).toBe(false);
        expect(lib.folders()).toEqual(["Props", "Props/Indoor"]);
        expect(changes.at(-1)).toEqual(["Props", "Props/Indoor"]);

        const again = new Library(store, new MemoryLogger());
        await again.load();
        expect(again.folders()).toEqual(["Props", "Props/Indoor"]);
    });
});
