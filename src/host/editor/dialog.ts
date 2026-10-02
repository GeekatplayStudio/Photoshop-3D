/**
 * The modal 3D editor window.
 *
 * A resizable UXP <dialog> holding a <webview> with editor.html (the ImageExpress
 * ThreeDLayerEditor port). The page asks for its start data with `editor.getInit`,
 * and ends the session with `editor.complete` (render + settings) or `editor.cancel`.
 *
 * Two UXP quirks this works around (both verified in Photoshop 27):
 * - a webview must be created from script — one declared in HTML does not paint;
 * - percentage sizes inside a dialog resolve against the wrong box, so the webview
 *   is sized in pixels and resized to follow the dialog;
 * - a webview only gets real bounds when its size changes after the dialog is shown.
 */
import type { EditorInit, EditorResult } from "@shared/protocol";
import type { Logger } from "../platform/logger";

export type EditorSession = {
    init: EditorInit;
    resolve: (result: EditorResult | null) => void;
};

export class EditorDialog {
    private session: EditorSession | null = null;
    private dialog: HTMLDialogElement | null = null;

    constructor(
        private readonly deps: {
            log: Logger;
            webBase: string;
            /** Connects a webview to a bridge server; returns a disconnect function. */
            attach: (webview: UxpWebView) => () => void;
        },
    ) {}

    get active(): EditorSession | null {
        return this.session;
    }

    get isOpen(): boolean {
        return !!this.session;
    }

    /** Opens the editor and resolves with the render, or null when cancelled. */
    async open(init: EditorInit): Promise<EditorResult | null> {
        if (this.session) throw new Error("The 3D editor is already open.");
        let settle!: (r: EditorResult | null) => void;
        const done = new Promise<EditorResult | null>((resolve) => (settle = resolve));
        let result: EditorResult | null = null;
        this.session = {
            init,
            resolve: (r) => {
                result = r;
                this.close();
            },
        };

        const dialog = document.createElement("dialog");
        dialog.style.padding = "0";
        dialog.style.margin = "0";
        dialog.style.border = "0";
        dialog.style.overflow = "hidden";
        dialog.style.backgroundColor = "#1e1e1e";
        // Without an explicit size the dialog element only wraps its content, so its client
        // size says nothing about the window; at 100% it reports the window's inner size.
        dialog.style.width = "100%";
        dialog.style.height = "100%";
        const webview = document.createElement("webview") as UxpWebView;
        webview.setAttribute("src", `${this.deps.webBase}/editor.html`);
        webview.setAttribute("uxpAllowInspector", "true");
        // Start small on purpose: the webview loads while the dialog is still hidden and only
        // picks up its real bounds when its size CHANGES after the dialog is shown (verified in
        // Photoshop 27: without a change the page renders into an invisible 1921×2112 viewport).
        webview.style.width = "320px";
        webview.style.height = "240px";
        webview.style.border = "0";
        dialog.appendChild(webview);
        document.body.appendChild(dialog);
        this.dialog = dialog;
        const detach = this.deps.attach(webview);
        webview.addEventListener("loaderror", (e: Event) => this.deps.log.error("Editor page failed to load", { url: (e as unknown as { url: string }).url, message: (e as unknown as { message: string }).message }));

        let lastSize = "";
        const resize = setInterval(() => {
            const w = dialog.clientWidth;
            const h = dialog.clientHeight;
            const size = `${w}x${h}`;
            if (size !== lastSize) this.deps.log.debug(`Editor dialog ${size}, webview ${webview.clientWidth}x${webview.clientHeight}`);
            if (w > 100 && h > 100 && size !== lastSize) {
                lastSize = size;
                webview.style.width = `${w}px`;
                webview.style.height = `${h}px`;
            }
        }, 300);

        this.deps.log.info(`3D editor opened (${init.mode}) for ${init.model.name}`);
        dialog
            .uxpShowModal({ title: init.mode === "update" ? `Edit 3D Layer — ${init.model.name}` : `Place 3D Model — ${init.model.name}`, resize: "both", size: { width: 1180, height: 800 } })
            .catch((err: unknown) => this.deps.log.error("3D editor dialog error", err))
            .finally(() => {
                clearInterval(resize);
                detach();
                this.session = null;
                this.dialog = null;
                try {
                    dialog.remove();
                } catch {
                    // already gone
                }
                this.deps.log.info(`3D editor closed (${result ? "OK" : "cancelled"})`);
                settle(result);
            });
        return done;
    }

    close() {
        try {
            this.dialog?.close();
        } catch (err) {
            this.deps.log.warn("Could not close the 3D editor dialog", err);
        }
    }
}
