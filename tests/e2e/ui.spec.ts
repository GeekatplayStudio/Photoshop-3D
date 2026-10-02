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
        await page.waitForFunction(() => window.__ps3dEditorResult !== undefined, null, { timeout: 30_000 });
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

