/** Entry of panel.html, the UI inside the docked "3D Layers" panel. */
import React from "react";
import { createRoot } from "react-dom/client";
import "../styles.css";
import { getBridge } from "../bridge/client";
import { PanelApp } from "./App";
import { PanelProvider } from "./store";
import { installTooltips } from "../components/tooltips";

installTooltips();

window.addEventListener("error", (e) => {
    void getBridge().then((b) => b.call("log.write", { level: "error", message: `panel: ${e.message}`, data: { file: e.filename, line: e.lineno } }));
});
window.addEventListener("unhandledrejection", (e) => {
    void getBridge().then((b) => b.call("log.write", { level: "warn", message: `panel: unhandled rejection`, data: String((e.reason as Error)?.message ?? e.reason) }));
});

void getBridge().then(() => {
    createRoot(document.getElementById("root")!).render(
        <React.StrictMode>
            <PanelProvider>
                <PanelApp />
            </PanelProvider>
        </React.StrictMode>,
    );
});
