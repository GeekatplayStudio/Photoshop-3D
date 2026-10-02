// Renders crisp 2× screenshots of the panel UI and the 3D editor for the documentation,
// using the mock host (the same UI code as in Photoshop, with sample data).
//   npm run dev:web            (in another terminal)
//   npm run docs:screenshots   (see docs/DEVELOPMENT.md for the options)
// Writes docs/images/ui-*.png and ui-editor.jpg. Set DOCS_MODEL=<file.glb> (and optionally
// DOCS_MODEL_NAME) to show a real model in the editor instead of the sample totem.
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "images");
const base = process.env.DOCS_BASE_URL ?? "http://localhost:5173";
const docsModel = process.env.DOCS_MODEL;

const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });

// The 3D editor, as it opens when you double-click a 3D layer.
{
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1.5 });
    page.on("pageerror", (e) => console.error(`page error: ${e.message}`));
    if (docsModel) {
        const body = readFileSync(docsModel);
        await page.route("**/samples/totem.glb", (route) => route.fulfill({ body, contentType: "model/gltf-binary" }));
    }
    const name = process.env.DOCS_MODEL_NAME ?? (docsModel ? "Model" : "Totem");
    await page.goto(`${base}/editor.html?model=lib_totem&mode=update&name=${encodeURIComponent(name)}`);
    await page.getByTestId("editor-ok").waitFor();
    await page.waitForFunction(() => !document.querySelector('[data-testid="editor-ok"]')?.hasAttribute("disabled"), null, { timeout: 120_000 });
    await page.getByTestId("rotate-y").fill(process.env.DOCS_TURN ?? "15");
    await page.getByRole("button", { name: process.env.DOCS_PRESET ?? "Golden Hour" }).click();
    await page.waitForTimeout(2500);
    await page.screenshot({ path: join(out, "ui-editor.jpg"), type: "jpeg", quality: 88 });
    console.log("docs/images/ui-editor.jpg");
    await page.close();
}
if (process.env.DOCS_ONLY === "editor") {
    await browser.close();
    process.exit(0);
}

const page = await browser.newPage({ viewport: { width: 320, height: 640 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.error(`page error: ${e.message}`));
const tidy = async () => {
    // Toasts and tooltips are not part of what the docs show. Hide them with CSS: removing
    // React-managed nodes would crash the app.
    await page.addStyleTag({ content: '[role="status"], [role="tooltip"] { display: none !important; }' });
    await page.evaluate(() => document.querySelector("main")?.scrollTo(0, 0));
};
const shot = async (name, opts = {}) => {
    await page.waitForTimeout(400);
    await tidy();
    await page.screenshot({ path: join(out, `ui-${name}.png`), ...opts });
    console.log(`docs/images/ui-${name}.png`);
};

// Create tab with the first-run card.
await page.goto(`${base}/panel.html`);
await page.getByTestId("getting-started").waitFor();
await page.getByText("256×256 px from Mock.psd").waitFor();
await page.getByTestId("update-banner").locator("button").last().click();
await shot("create");

// A running and a finished job.
await page.getByTestId("generate").click();
await page.getByTestId("job-card").first().getByText("Generating").waitFor();
await page.waitForTimeout(800);
await tidy();
await page.getByTestId("jobs-section").screenshot({ path: join(out, "ui-job.png") });
console.log("docs/images/ui-job.png");

// Settings: a service section with its key.
await page.getByTestId("tab-settings").click();
await page.getByRole("button", { name: "Test connection" }).first().click();
await page.getByTestId("test-result-meshy").waitFor();
await shot("settings");

// Browse.
await page.getByTestId("tab-browse").click();
await page.getByTestId("remote-card").first().waitFor();
await shot("browse");

// Library with rendered previews, after importing the sample files (FBX, OBJ, glTF, STL, PLY, USDZ).
await page.getByTestId("tab-library").click();
await page.getByTestId("import-files").click();
await page.waitForFunction(() => (window.__ps3dImported?.length ?? 0) >= 6, null, { timeout: 120_000 });
await page.getByTestId("import-status").waitFor({ state: "detached", timeout: 60_000 });
await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="library-card"]')].slice(0, 6).every((c) => c.querySelector("img")), null, { timeout: 60_000 });
await page.waitForTimeout(1500);
await shot("library");

await browser.close();
