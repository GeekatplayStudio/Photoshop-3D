// Geekatplay 3D Layers - renders the Creative Cloud Marketplace images.
// by Geekatplay Studio - Vladimir Chopine - https://www.geekatplay.com
//
//   npm run dev:web                        (in another terminal)
//   node distribution/make-assets.mjs
//
// Writes distribution/assets/:
//   icon-48.png, icon-96.png, icon-192.png   from source/icon.svg
//   publisher-logo-250.png                   from source/publisher-logo.html (shared with the ComfyUI Bridge)
//   screenshot-1.png ... screenshot-5.png    1360 x 800, made from the real panel and 3D editor
//                                            (mock host, demo models from scripts/make-demo-models.py)
// and the plugin's own icons plugin/icons/plugin@1x.png, plugin@2x.png and app-256.png.
import { chromium } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const assets = join(here, "assets");
const tmp = join(root, ".tmp", "listing");
mkdirSync(assets, { recursive: true });
mkdirSync(tmp, { recursive: true });
const base = process.env.DOCS_BASE_URL ?? "http://localhost:5317";
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const log = (f) => console.log(f.replace(root, "").replace(/\\/g, "/"));
const dataUrl = (file) => `data:image/png;base64,${readFileSync(file).toString("base64")}`;

/* ------------------------------------------------------------------ icons */
const iconSvg = readFileSync(join(here, "source", "icon.svg"), "utf8").replace(/width="192" height="192"/, 'width="100%" height="100%"');
async function renderIcon(size, out) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(`<html><body style="margin:0;background:transparent;width:${size}px;height:${size}px">${iconSvg}</body></html>`);
    await page.screenshot({ path: out, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    await page.close();
    log(out);
}
for (const s of [48, 96, 192]) await renderIcon(s, join(assets, `icon-${s}.png`));
await renderIcon(48, join(root, "plugin", "icons", "plugin@1x.png"));
await renderIcon(96, join(root, "plugin", "icons", "plugin@2x.png"));
await renderIcon(256, join(root, "plugin", "icons", "app-256.png"));

{
    const page = await browser.newPage({ viewport: { width: 1000, height: 1000 }, deviceScaleFactor: 0.25 });
    await page.goto(`file:///${join(here, "source", "publisher-logo.html").replace(/\\/g, "/")}`);
    await page.screenshot({ path: join(assets, "publisher-logo-250.png") });
    await page.close();
    log(join(assets, "publisher-logo-250.png"));
}

/* ------------------------------------------------------- captures of the UI */
const hideToasts = (page) => page.addStyleTag({ content: '[role="status"], [role="tooltip"], [data-testid="update-banner"] { display: none !important; }' });

async function panel(query, prepare, out) {
    const page = await browser.newPage({ viewport: { width: 360, height: 730 }, deviceScaleFactor: 2 });
    page.on("pageerror", (e) => console.error(`page error: ${e.message}`));
    await page.goto(`${base}/panel.html?demo=1${query}`);
    await page.getByTestId("create-section").waitFor();
    await prepare(page);
    await hideToasts(page);
    await page.evaluate(() => document.querySelector("main")?.scrollTo(0, 0));
    await page.waitForTimeout(500);
    await page.screenshot({ path: out });
    await page.close();
    return out;
}

const shots = {};
shots.create = await panel(
    "",
    async (page) => {
        await page.getByRole("button", { name: "Hide" }).click();
        await page.getByTestId("generate").click();
        await page.getByTestId("job-card").first().getByText("Ready", { exact: true }).waitFor({ timeout: 20_000 });
    },
    join(tmp, "panel-create.png"),
);
shots.layer3d = await panel(
    "&layer3d=Toy%20rocket",
    async (page) => {
        await page.getByRole("button", { name: "Hide" }).click();
    },
    join(tmp, "panel-3dlayer.png"),
);
shots.library = await panel(
    "",
    async (page) => {
        await page.getByTestId("tab-library").click();
        await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="library-card"]')].every((c) => c.querySelector("img")), null, { timeout: 90_000 });
        await page.waitForTimeout(800);
    },
    join(tmp, "panel-library.png"),
);
shots.settings = await panel(
    "",
    async (page) => {
        await page.getByTestId("tab-settings").click();
        await page.getByRole("button", { name: "Test connection" }).first().click();
        await page.getByTestId("test-result-meshy").waitFor();
    },
    join(tmp, "panel-settings.png"),
);

/** The 3D editor as it opens on a 3D layer, with a pose and a light preset. */
async function editor(width, height, turn, preset, screenshot, aspect = 1) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    page.on("pageerror", (e) => console.error(`page error: ${e.message}`));
    await page.goto(`${base}/editor.html?demo=1&model=lib_rocket&mode=update&name=${encodeURIComponent("Toy rocket")}`);
    await page.waitForFunction(() => !document.querySelector('[data-testid="editor-ok"]')?.hasAttribute("disabled"), null, { timeout: 120_000 });
    await page.getByTestId("rotate-y").fill(String(turn));
    await page.getByRole("button", { name: preset }).click();
    // Tall crops: no cast shadow, so the crop centres on the model (the contact shadow stays).
    if (aspect < 1) await page.getByRole("switch", { name: "Cast shadow" }).click();
    await page.waitForTimeout(2500);
    if (screenshot) {
        await page.screenshot({ path: screenshot });
        await page.close();
        return screenshot;
    }
    // Render: the PNG the editor would place into the document.
    await page.getByTestId("editor-ok").click();
    await page.waitForFunction(() => window.__ps3dEditorResult !== undefined, null, { timeout: 90_000 });
    // Crop to the model (plus a margin) so it fills the card.
    const png = await page.evaluate(async (aspect) => {
        const r = window.__ps3dEditorResult;
        const img = new Image();
        img.src = `data:image/png;base64,${r.pngBase64}`;
        await img.decode();
        const b = r.contentBounds ?? { left: 0, top: 0, right: r.width, bottom: r.height };
        // aspect = width / height of the crop; a tall crop trims the long shadow at the sides.
        const h = (aspect < 1 ? b.bottom - b.top : Math.max(b.bottom - b.top, (b.right - b.left) / aspect)) * 1.12;
        const w = h * aspect;
        const cx = (b.left + b.right) / 2;
        const cy = (b.top + b.bottom) / 2;
        const c = document.createElement("canvas");
        c.width = Math.round(900 * aspect);
        c.height = 900;
        c.getContext("2d").drawImage(img, cx - w / 2, cy - h / 2, w, h, 0, 0, c.width, c.height);
        return c.toDataURL("image/png");
    }, aspect);
    await page.close();
    return png;
}

// Screenshot 2 is the editor itself.
await editor(1360, 800, -30, "Golden Hour", join(assets, "screenshot-2.png"));
log(join(assets, "screenshot-2.png"));
const renders = {
    golden: await editor(1000, 1000, -30, "Golden Hour"),
    goldenTall: await editor(1000, 1000, -30, "Golden Hour", undefined, 0.6),
    dramatic: await editor(1000, 1000, 35, "Dramatic", undefined, 0.6),
    moon: await editor(1000, 1000, 150, "Moonlight", undefined, 0.6),
};

/* ------------------------------------------------------------ compositions */
const CSS = `
*{box-sizing:border-box}
html,body{margin:0;width:1360px;height:800px;overflow:hidden}
body{font-family:"Segoe UI Variable Display","Segoe UI",system-ui,sans-serif;color:#fff;
  background:linear-gradient(135deg,#2b1366 0%,#16124a 55%,#0a0f2e 100%)}
body:before{content:"";position:absolute;inset:0;background:
  radial-gradient(circle at 22% 18%,rgba(124,58,237,.45),rgba(124,58,237,0) 55%),
  linear-gradient(rgba(255,255,255,.035) 1px,transparent 1px) 0 0/40px 40px,
  linear-gradient(90deg,rgba(255,255,255,.035) 1px,transparent 1px) 0 0/40px 40px}
.col{position:absolute;left:60px;top:44px;width:800px;bottom:40px;display:flex;flex-direction:column}
.brand{display:flex;align-items:center;gap:14px;font-weight:700;letter-spacing:4px;font-size:15px;color:#d8ccff}
.brand img{width:36px;height:36px}
h1{margin:22px 0 0;font-size:58px;line-height:1.08;font-weight:800;letter-spacing:-.5px}
.g{background:linear-gradient(90deg,#22d3ee,#a78bfa 50%,#f472b6);-webkit-background-clip:text;background-clip:text;color:transparent}
p.sub{margin:18px 0 0;width:760px;font-size:21px;line-height:1.45;color:#d6d0f5}
.visual{position:relative;margin-top:30px;flex:1}
.panel{position:absolute;right:52px;top:40px;width:372px;height:720px;border-radius:12px;overflow:hidden;
  background:#323232;box-shadow:0 30px 80px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.08)}
.panel .bar{height:24px;background:#262626;display:flex;align-items:center;padding:0 10px;font-size:11px;color:#ddd;font-family:"Segoe UI",sans-serif}
.panel .bar span{background:#3a3a3a;padding:3px 9px;border-radius:3px 3px 0 0}
.panel img{display:block;width:360px;margin-left:6px}
.stage{position:absolute;inset:0;border-radius:18px;overflow:hidden;
  background:radial-gradient(ellipse at 50% 85%,rgba(167,139,250,.28),rgba(20,16,60,.0) 60%),linear-gradient(180deg,rgba(255,255,255,.06),rgba(255,255,255,.02));
  border:1px solid rgba(255,255,255,.1)}
.chip{position:absolute;left:18px;bottom:16px;padding:8px 14px;border-radius:10px;background:rgba(10,8,30,.75);border:1px solid rgba(255,255,255,.15);font-weight:700;letter-spacing:2px;font-size:13px}
.chip b{color:#7dd3fc}
`;
const icon = dataUrl(join(assets, "icon-96.png"));
const page = (title, sub, visual, panelImg) => `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>
<div class="col"><div class="brand"><img src="${icon}">GEEKATPLAY 3D LAYERS</div>
<h1>${title}</h1><p class="sub">${sub}</p><div class="visual">${visual}</div></div>
<div class="panel"><div class="bar"><span>3D Layers</span></div><img src="${dataUrl(panelImg)}"></div>
</body></html>`;

async function compose(name, html) {
    const p = await browser.newPage({ viewport: { width: 1360, height: 800 }, deviceScaleFactor: 1 });
    await p.setContent(html);
    await p.waitForTimeout(300);
    const out = join(assets, `screenshot-${name}.png`);
    await p.screenshot({ path: out });
    await p.close();
    log(out);
}

await compose(
    "1",
    page(
        `Any layer, <span class="g">in 3D.</span>`,
        `Send a layer to Meshy, Tripo, Hitem3D or your own ComfyUI. Pose and light the model, and it lands in your document as a layer you can change any time.`,
        `<div class="stage"><img src="${renders.golden}" style="position:absolute;left:50%;top:50%;height:96%;transform:translate(-50%,-50%)">
         <div class="chip">3D LAYER · <b>GOLDEN HOUR</b></div></div>`,
        shots.create,
    ),
);

const card = (src, label) => `<div style="position:relative;flex:1;height:100%;border-radius:16px;overflow:hidden;border:1px solid rgba(255,255,255,.12);
  background:radial-gradient(ellipse at 50% 80%,rgba(167,139,250,.25),transparent 65%),rgba(255,255,255,.04)">
  <img src="${src}" style="position:absolute;left:8px;right:8px;top:10px;width:calc(100% - 16px);height:calc(100% - 60px);object-fit:contain">
  <div style="position:absolute;left:0;right:0;bottom:14px;text-align:center;font-weight:700;letter-spacing:2px;font-size:13px;color:#d8ccff">${label}</div></div>`;
await compose(
    "3",
    page(
        `Re-pose and relight <span class="g">any time.</span>`,
        `Double-click the 3D layer: the editor opens with its pose and light. <b>Update Layer</b> replaces it in place and keeps its position, masks and effects.`,
        `<div style="position:absolute;inset:0;display:flex;gap:22px">${card(renders.goldenTall, "GOLDEN HOUR")}${card(renders.dramatic, "DRAMATIC")}${card(renders.moon, "MOONLIGHT")}</div>`,
        shots.layer3d,
    ),
);

const chips = ["GLB", "glTF", "FBX", "OBJ", "DAE", "USDZ", "3DS", "STL", "PLY", "3MF", "AMF", "VRML", "VOX"]
    .map((f) => `<span style="padding:10px 16px;border-radius:10px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.14);font-weight:700;font-size:17px;letter-spacing:1px">${f}</span>`)
    .join("");
const feature = (t, d) => `<div style="margin-top:14px"><div style="font-weight:700;font-size:20px">${t}</div><div style="color:#c9c2ee;font-size:16px;margin-top:3px">${d}</div></div>`;
await compose(
    "4",
    page(
        `Your 3D library, <span class="g">organized.</span>`,
        `Every model is kept on your computer with a preview, so it opens instantly and never expires. Bring your own files too.`,
        `<div style="display:flex;flex-wrap:wrap;gap:10px">${chips}</div>
         <div style="margin-top:18px">
           ${feature("Folders, search and favorites", "Drag models into folders; search looks in all of them.")}
           ${feature("Drag and drop", "Drop 3D files or whole folders on the panel: textures and materials come along.")}
           ${feature("Browse your services", "Import what you made on Meshy, Tripo, Hitem3D or ComfyUI in one click.")}
         </div>`,
        shots.library,
    ),
);

const service = (name, line, accent) => `<div style="padding:18px 20px;border-radius:14px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.13)">
  <div style="font-weight:800;font-size:24px;color:${accent}">${name}</div><div style="color:#d6d0f5;font-size:16px;margin-top:4px">${line}</div></div>`;
await compose(
    "5",
    page(
        `Meshy, Tripo, Hitem3D <span class="g">or your own ComfyUI.</span>`,
        `Use the service you like, with its latest models. Keys stay on your computer; each test shows your balance.`,
        `<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
           ${service("Meshy", "Meshy 7.1 · Smart Topology low-poly", "#7dd3fc")}
           ${service("Tripo", "v3.1 · P1/P2 low-poly · texture v3.5", "#a78bfa")}
           ${service("Hitem3D", "hi3d v3.0 · PBR materials · de-shading", "#f9a8d4")}
           ${service("ComfyUI", "TRELLIS.2 built in · free on your GPU", "#fdba74")}
         </div>`,
        shots.settings,
    ),
);

await browser.close();
