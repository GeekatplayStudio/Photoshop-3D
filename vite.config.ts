import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const root = fileURLToPath(new URL(".", import.meta.url));

/**
 * Ships three.js' Draco and Basis decoders with the UI (web/draco, web/basis) so
 * compressed GLBs open offline instead of fetching decoders from a CDN.
 */
function decoders(): Plugin {
    const dirs = {
        draco: resolve(root, "node_modules/three/examples/jsm/libs/draco/gltf"),
        basis: resolve(root, "node_modules/three/examples/jsm/libs/basis"),
    };
    return {
        name: "ps3d-decoders",
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                const m = /^\/(draco|basis)\/([\w.]+)$/.exec(req.url?.split("?")[0] ?? "");
                if (!m) return next();
                try {
                    const body = readFileSync(resolve(dirs[m[1] as keyof typeof dirs], m[2]));
                    res.setHeader("Content-Type", m[2].endsWith(".wasm") ? "application/wasm" : "text/javascript");
                    res.end(body);
                } catch {
                    next();
                }
            });
        },
        generateBundle() {
            for (const [name, dir] of Object.entries(dirs)) {
                for (const file of readdirSync(dir).filter((f) => /\.(js|wasm)$/.test(f))) {
                    this.emitFile({ type: "asset", fileName: `${name}/${file}`, source: readFileSync(resolve(dir, file)) });
                }
            }
        },
    };
}

/*
 * The WebView UI (panel + 3D editor). It is built into dist/plugin/web and loaded by
 * the UXP host inside <webview> elements, so asset paths must stay relative ("./").
 * `npm run dev:web` serves the same pages in a normal browser against a mock host
 * (src/web/bridge/mockHost.ts); sample models come from tests/fixtures/public and are
 * never part of the plugin build.
 */
export default defineConfig(({ command }) => ({
    root: resolve(root, "src/web"),
    base: "./",
    publicDir: command === "serve" ? resolve(root, "tests/fixtures/public") : false,
    plugins: [react(), tailwindcss(), decoders()],
    // The import converter loads these on first use; listing them stops the dev server from
    // discovering them at run time and reloading the page in the middle of an import.
    optimizeDeps: {
        include: ["FBXLoader", "OBJLoader", "MTLLoader", "STLLoader", "PLYLoader", "ColladaLoader", "3MFLoader", "AMFLoader", "TDSLoader", "VRMLLoader", "USDLoader", "VOXLoader", "TGALoader"]
            .map((l) => `three/examples/jsm/loaders/${l}.js`)
            .concat("three/examples/jsm/exporters/GLTFExporter.js"),
    },
    resolve: {
        alias: {
            "@shared": resolve(root, "src/shared"),
            "@web": resolve(root, "src/web"),
        },
    },
    build: {
        outDir: resolve(root, "dist/plugin/web"),
        emptyOutDir: true,
        target: "es2022",
        sourcemap: true,
        chunkSizeWarningLimit: 2500,
        rollupOptions: {
            input: {
                panel: resolve(root, "src/web/panel.html"),
                editor: resolve(root, "src/web/editor.html"),
            },
        },
    },
    server: {
        port: 5317,
        strictPort: true,
    },
}));
