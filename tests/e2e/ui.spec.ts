import { expect, test } from "@playwright/test";

/*
 * End-to-end tests of the WebView UI against the mock host. They cover what can break
 * without Photoshop: rendering, bridge calls, the in-page dropdown (native <select>
 * popups do not paint in Photoshop's WebView), the job flow, thumbnails, and the 3D
 * editor's render-and-return path.
 */

test.describe("panel", () => {
    test.use({ viewport: { width: 340, height: 820 } });

    test("generates a model and shows it in the library", async ({ page }) => {
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await page.goto("/panel.html");
        await expect(page.getByTestId("create-section")).toBeVisible();
        await expect(page.getByText("256×256 px from Mock.psd")).toBeVisible();

        // In-page dropdown: pick Tripo (not configured in the mock → button disabled), then Meshy.
        await page.getByTestId("provider-select").click();
        await page.getByRole("option", { name: /Tripo/ }).click();
        await expect(page.getByTestId("generate")).toBeDisabled();
        await page.getByTestId("provider-select").click();
        await page.getByRole("option", { name: /^Meshy$/ }).click();
        await expect(page.getByTestId("generate")).toBeEnabled();

        await page.getByTestId("generate").click();
        const job = page.getByTestId("job-card").first();
        await expect(job).toContainText("Generating");
        await expect(job).toContainText("Ready", { timeout: 15_000 });
        await expect(job.getByRole("button", { name: "Pose & place" })).toBeVisible();

        await page.getByTestId("tab-library").click();
        await expect(page.getByTestId("library-card")).toHaveCount(3);
        // A model without a preview gets one rendered with three.js.
        await expect(page.getByTestId("library-card").filter({ hasText: "Totem (sample)" }).locator("img")).toHaveAttribute("src", /^data:image\/png/, { timeout: 30_000 });
        expect(errors).toEqual([]);
    });

    test("shows the getting-started card until it is hidden", async ({ page }) => {
        await page.goto("/panel.html");
        const card = page.getByTestId("getting-started");
        await expect(card).toBeVisible();
        await card.getByRole("button", { name: "Set up a service" }).click();
        await expect(page.getByTestId("settings")).toBeVisible();
        await page.getByTestId("tab-create").click();
        await card.getByRole("button", { name: "Hide" }).click();
        await expect(card).toHaveCount(0);
        await page.getByTestId("tab-settings").click();
        await page.getByTestId("tab-create").click();
        await expect(card).toHaveCount(0);
    });

    test("browse lists remote models and imports one", async ({ page }) => {
        await page.goto("/panel.html");
        await page.getByTestId("tab-browse").click();
        await expect(page.getByTestId("remote-card")).toHaveCount(6);
        await expect(page.getByTestId("remote-card").first()).toContainText("In library");
        const importable = page.getByTestId("remote-card").nth(1);
        await importable.getByRole("button", { name: "Import" }).click();
        await expect(importable).toContainText("In library");
        await page.getByRole("button", { name: "Load more" }).click();
        await expect(page.getByTestId("remote-card")).toHaveCount(12);
    });

    test("settings save keys and run a connection test", async ({ page }) => {
        await page.goto("/panel.html");
        await page.getByTestId("tab-settings").click();
        const settings = page.getByTestId("settings");
        await expect(settings).toContainText("msy_…1234");
        await page.getByRole("button", { name: "Test connection" }).first().click();
        await expect(page.getByTestId("test-result-meshy")).toContainText("1000 credits");
    });
});

test.describe("3D editor", () => {
    test.use({ viewport: { width: 1200, height: 800 } });
    // CI runners have no GPU: software WebGL (SwiftShader) can take seconds per frame there,
    // which made this test overrun the default 60 s now and then.
    test.describe.configure({ timeout: 180_000 });

    test("renders the model and returns a transparent PNG with settings", async ({ page }) => {
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await page.goto("/editor.html?model=lib_totem");
        await expect(page.getByTestId("model-info")).toContainText("5 meshes", { timeout: 30_000 });
        await expect(page.getByTestId("editor-ok")).toBeEnabled();

        // Pose and light: turn the model, pick a preset and an environment.
        await page.getByTestId("rotate-y").fill("45");
        await page.getByRole("button", { name: "Golden Hour" }).click();
        await page.getByTestId("environment").click();
        await page.getByRole("option", { name: "Sunset" }).click();

        await page.getByTestId("editor-ok").click();
        await page.waitForFunction(() => window.__ps3dEditorResult !== undefined, null, { timeout: 90_000 });
        const result = await page.evaluate(() => {
            const r = window.__ps3dEditorResult!;
            return { w: r.width, h: r.height, png: r.pngBase64.slice(0, 12), bytes: r.pngBase64.length, bounds: r.contentBounds, s: r.settings };
        });
        expect(result.png).toBe("iVBORw0KGgoA"); // PNG signature
        expect(result.w).toBe(1024);
        expect(result.h).toBe(1024);
        expect(result.bytes).toBeGreaterThan(5000);
        expect(result.bounds!.right - result.bounds!.left).toBeGreaterThan(50); // the model is visible
        expect(result.bounds!.top).toBeGreaterThan(0); // transparent above the model (a low sun may cast shadows to the frame edge)
        expect(result.s.modelRotationY).toBe(45);
        expect(result.s.lightColor).toBe("#ffb36b");
        expect(result.s.environment).toBe("sunset");
        expect(errors).toEqual([]);
    });
});


test.describe("import", () => {
    test.use({ viewport: { width: 340, height: 900 } });
    test.describe.configure({ timeout: 180_000 });

    test("converts FBX, OBJ, glTF, STL, PLY and USDZ to GLB with their textures and adds them to the library", async ({ page }) => {
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await page.goto("/panel.html");
        await page.getByTestId("tab-library").click();
        await expect(page.getByTestId("library-card")).toHaveCount(2);
        await page.getByTestId("import-files").click();
        await page.waitForFunction(() => (window.__ps3dImported?.length ?? 0) >= 6, null, { timeout: 120_000 });
        await expect(page.getByTestId("import-status")).toHaveCount(0, { timeout: 30_000 });
        const imported = await page.evaluate(() => window.__ps3dImported!);
        expect(imported.map((i) => i.sourceFormat).sort()).toEqual(["fbx", "gltf", "obj", "ply", "stl", "usdz"]);
        for (const i of imported) {
            expect(i.bytes, i.name).toBeGreaterThan(300);
            expect(i.meshes, i.name).toBeGreaterThan(0);
        }
        // The checker texture is found next to the model (FBX keeps an absolute path from another machine).
        for (const name of ["cube-fbx", "cube-obj", "cube-gltf", "cube-usdz"]) {
            const i = imported.find((x) => x.name === name)!;
            expect(i.images, name).toBe(1);
            expect(i.notes.join(" "), name).not.toMatch(/Missing/);
        }
        await expect(page.getByTestId("library-card")).toHaveCount(8);
        await expect(page.getByText(/Added 6 models to the library/)).toBeVisible();
        await expect(page.getByText(/notes\.txt \(not a supported 3D file\)/)).toBeVisible();
        // Previews are rendered for the converted models.
        await expect(page.getByTestId("library-card").filter({ hasText: "cube-fbx" }).locator("img")).toHaveAttribute("src", /^data:image\/png/, { timeout: 60_000 });
        expect(errors).toEqual([]);
    });
});

test.describe("library folders", () => {
    test.use({ viewport: { width: 360, height: 900 } });

    test("creates folders, moves models by drag and drop, renames and deletes folders", async ({ page }) => {
        await page.goto("/panel.html");
        await page.getByTestId("tab-library").click();
        const cards = page.getByTestId("library-card");
        await expect(cards).toHaveCount(2);

        await page.getByTestId("new-folder").click();
        await page.getByTestId("new-folder-name").fill("Characters");
        await page.keyboard.press("Enter");
        const tile = page.locator('[data-testid="folder-tile"][data-folder="Characters"]');
        await expect(tile).toContainText("0 models");

        // Drag a card onto the folder.
        await cards.filter({ hasText: "Totem (sample)" }).dragTo(tile);
        await expect(cards).toHaveCount(1);
        await expect(tile).toContainText("1 model");

        // Open it; the breadcrumb shows where we are.
        await tile.getByRole("button", { name: /1 model/ }).click();
        await expect(page.getByTestId("crumb").last()).toHaveText("Characters");
        await expect(cards).toHaveCount(1);
        await expect(cards.first()).toContainText("Totem (sample)");

        // A subfolder, then drag the model back to the top level via the breadcrumb.
        await page.getByTestId("new-folder").click();
        await page.getByTestId("new-folder-name").fill("Robots");
        await page.getByRole("button", { name: "Create" }).click();
        await expect(page.getByTestId("folder-tile")).toHaveCount(1);
        await cards.first().dragTo(page.getByTestId("crumb").first());
        await expect(cards).toHaveCount(0);
        await page.getByTestId("crumb").first().click();
        await expect(cards).toHaveCount(2);

        // Search looks in every folder.
        await page.getByTestId("tab-library").click();
        await cards.filter({ hasText: "Meshy totem" }).click();
        await page.getByTestId("details-folder").click();
        await page.getByRole("option", { name: "Characters › Robots" }).click();
        await expect(cards).toHaveCount(1);
        await page.getByPlaceholder("Search all folders").fill("meshy");
        await expect(cards).toHaveCount(1);
        await expect(cards.first()).toContainText("Characters › Robots");
        await page.getByPlaceholder("Search all folders").fill("");

        // Rename, then delete: its contents move up a level.
        await tile.getByTestId("folder-rename").click();
        await tile.locator("input").fill("Heroes");
        await tile.locator("input").press("Enter");
        const heroes = page.locator('[data-testid="folder-tile"][data-folder="Heroes"]');
        await expect(heroes).toContainText("1 model");
        await heroes.getByTestId("folder-delete").click();
        await heroes.getByTestId("folder-delete-confirm").click();
        await expect(page.getByTestId("folder-tile").filter({ hasText: "Robots" })).toContainText("1 model");
    });

    test("removes several models at once, and one from its card", async ({ page }) => {
        await page.goto("/panel.html");
        await page.getByTestId("tab-library").click();
        await page.getByTestId("import-files").click();
        await page.waitForFunction(() => (window.__ps3dImported?.length ?? 0) >= 6, null, { timeout: 120_000 });
        const cards = page.getByTestId("library-card");
        await expect(cards).toHaveCount(8);

        await cards.filter({ hasText: "cube-stl" }).click({ modifiers: ["Control"] });
        await cards.filter({ hasText: "cube-ply" }).click({ modifiers: ["Control"] });
        await expect(page.getByTestId("selection-bar")).toContainText("2 selected");
        await page.getByTestId("remove-selected").click();
        await page.getByTestId("remove-selected-confirm").click();
        await expect(cards).toHaveCount(6);
        await expect(cards.filter({ hasText: "cube-stl" })).toHaveCount(0);

        const fbx = page.locator("div.group").filter({ has: page.getByText("cube-fbx", { exact: true }) });
        await fbx.hover();
        await fbx.getByTestId("card-remove").click();
        await fbx.getByTestId("card-remove-confirm").click();
        await expect(cards).toHaveCount(5);
    });

    test("imports files dropped from the file manager into the open folder", async ({ page }) => {
        await page.goto("/panel.html");
        await page.getByTestId("tab-library").click();
        await page.getByTestId("new-folder").click();
        await page.getByTestId("new-folder-name").fill("Props");
        await page.keyboard.press("Enter");
        await page.getByTestId("folder-tile").filter({ hasText: "Props" }).getByRole("button", { name: /0 models/ }).click();

        const library = page.getByTestId("library");
        const dt = await page.evaluateHandle(async () => {
            const dt = new DataTransfer();
            for (const [path, name] of [
                ["samples/import/cube.obj", "cube.obj"],
                ["samples/import/cube.mtl", "cube.mtl"],
                ["samples/import/textures/checker.png", "checker.png"],
                ["samples/import/cube.stl", "cube.stl"],
                ["samples/totem.glb", "totem.glb"],
            ]) {
                const bytes = await (await fetch(`./${path}`)).arrayBuffer();
                dt.items.add(new File([bytes], name));
            }
            return dt;
        });
        await library.dispatchEvent("dragenter", { dataTransfer: dt });
        await expect(page.getByTestId("drop-overlay")).toContainText("Library › Props");
        await library.dispatchEvent("dragover", { dataTransfer: dt });
        await library.dispatchEvent("drop", { dataTransfer: dt });
        await page.waitForFunction(() => (window.__ps3dImported?.length ?? 0) >= 3, null, { timeout: 60_000 });
        const imported = await page.evaluate(() => window.__ps3dImported!);
        expect(imported.map((i) => [i.name, i.sourceFormat, i.folder]).sort()).toEqual([
            ["cube", "obj", "Props"],
            ["cube", "stl", "Props"],
            ["totem", "glb", "Props"],
        ]);
        expect(imported.find((i) => i.sourceFormat === "obj")!.notes.join(" ")).not.toMatch(/Missing/);
        await expect(page.getByTestId("library-card")).toHaveCount(3);
        await expect(page.getByText(/Added 3 models to the library/)).toBeVisible();
    });
});
