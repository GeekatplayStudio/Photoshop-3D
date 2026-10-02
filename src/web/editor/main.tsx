/**
 * Entry of editor.html, the page inside the modal 3D editor dialog.
 * Asks the host what to edit (editor.getInit), then hands the result back
 * (editor.complete) or cancels (editor.cancel); the host closes the dialog.
 */
import React, { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "../styles.css";
import type { EditorInit, EditorResult } from "@shared/protocol";
import type { LightingDefaults } from "@shared/threeD";
import { bridge, getBridge } from "../bridge/client";
import { modelUrl, resolveLibraryBase } from "../three/modelSource";
import ThreeDLayerEditor from "./ThreeDLayerEditor";

function EditorApp() {
    const [init, setInit] = useState<EditorInit | null>(null);
    const [url, setUrl] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        (async () => {
            const b = await getBridge();
            const info = await b.call("app.info");
            document.documentElement.dataset.theme = info.theme;
            b.on("theme.changed", ({ theme }) => (document.documentElement.dataset.theme = theme));
            const data = await b.call("editor.getInit");
            setInit(data);
            const base = await resolveLibraryBase(info.libraryBaseUrl);
            setUrl(base && data.model.url ? data.model.url : await modelUrl(null, data.model.file));
        })().catch((err: Error) => setError(err.message));
    }, []);

    const complete = useCallback(async (result: EditorResult) => {
        await bridge().call("editor.complete", result);
    }, []);
    const cancel = useCallback(() => {
        void bridge().call("editor.cancel");
    }, []);
    const remember = useCallback((lighting: LightingDefaults) => {
        void bridge().call("editor.rememberLighting", lighting);
    }, []);

    if (error) {
        return (
            <div className="h-full flex flex-col items-center justify-center gap-3 p-6 text-center">
                <p className="text-sm">The 3D editor could not start.</p>
                <p className="text-xs text-muted-foreground max-w-md">{error}</p>
                <button type="button" className="px-3 py-1.5 rounded border border-border text-xs" onClick={cancel}>
                    Close
                </button>
            </div>
        );
    }
    if (!init || !url) return <div className="h-full flex items-center justify-center text-xs text-muted-foreground">Opening the 3D editor…</div>;
    return <ThreeDLayerEditor init={init} modelUrl={url} onComplete={complete} onCancel={cancel} onRememberLighting={remember} />;
}

window.addEventListener("error", (e) => {
    void getBridge().then((b) => b.call("log.write", { level: "error", message: `editor: ${e.message}`, data: { file: e.filename, line: e.lineno } }));
});

// Startup diagnostics (window size, paint loop) — visible in the plugin log.
void getBridge().then((b) => {
    let frames = 0;
    const tick = () => {
        frames++;
        requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const report = (when: string) =>
        b.call("log.write", { level: "debug", message: `editor page ${when}`, data: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio, visible: document.visibilityState, frames, canvas: document.querySelector("canvas")?.width ?? null } });
    void report("start");
    setTimeout(() => void report("after 3s"), 3000);
});

createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
        <EditorApp />
    </React.StrictMode>,
);
