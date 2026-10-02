/**
 * Ambient declarations for the UXP runtime modules the host uses.
 *
 * Adobe does not publish TypeScript types for UXP, so only the surface this plugin
 * touches is declared here, loosely. Everything Photoshop-specific is wrapped in
 * src/host/ps/* — no other file should need these modules.
 */

declare module "uxp" {
    export const entrypoints: {
        setup(config: {
            plugin?: { create?: () => void; destroy?: () => void };
            panels?: Record<string, { create?: (root: HTMLElement) => void; show?: (root: HTMLElement) => void; hide?: () => void; destroy?: () => void; menuItems?: unknown[]; invokeMenu?: (id: string) => void }>;
            commands?: Record<string, (() => unknown) | { run: () => unknown }>;
        }): void;
    };
    export const storage: {
        localFileSystem: UxpLocalFileSystem;
        formats: { binary: unknown; utf8: unknown };
        secureStorage: {
            getItem(key: string): Promise<Uint8Array | null | undefined>;
            setItem(key: string, value: string | Uint8Array): Promise<void>;
            removeItem(key: string): Promise<void>;
        };
    };
    export const shell: {
        openExternal(url: string, developerText?: string): Promise<string>;
        openPath(path: string, developerText?: string): Promise<string>;
    };
    export const host: { name: string; version: string; uiLocale?: string };
    export const versions: { uxp: string; plugin: string };
}

declare module "photoshop" {
    export const app: any;
    export const core: any;
    export const action: any;
    export const imaging: any;
    export const constants: any;
}

declare module "os" {
    export function platform(): string;
    export function release(): string;
}

interface UxpEntry {
    name: string;
    nativePath: string;
    isFile: boolean;
    isFolder: boolean;
    delete(): Promise<void>;
}
interface UxpFile extends UxpEntry {
    read(options?: { format?: unknown }): Promise<string | ArrayBuffer>;
    write(data: string | ArrayBuffer, options?: { format?: unknown; append?: boolean }): Promise<number>;
}
interface UxpFolder extends UxpEntry {
    getEntry(name: string): Promise<UxpEntry>;
    getEntries(): Promise<UxpEntry[]>;
    createFile(name: string, options?: { overwrite?: boolean }): Promise<UxpFile>;
    createFolder(name: string): Promise<UxpFolder>;
}
interface UxpLocalFileSystem {
    getDataFolder(): Promise<UxpFolder>;
    getPluginFolder(): Promise<UxpFolder>;
    getTemporaryFolder(): Promise<UxpFolder>;
    getFileForOpening(options?: { types?: string[]; allowMultiple?: boolean; initialDomain?: unknown }): Promise<UxpFile | UxpFile[] | null>;
    getEntryWithUrl(url: string): Promise<UxpEntry>;
    createSessionToken(entry: UxpEntry): string;
}

/** The <webview> element UXP adds to the DOM. */
interface UxpWebView extends HTMLElement {
    postMessage(message: unknown, targetOrigin?: string): void;
    src: string;
}

/** UXP's modal <dialog> extensions. */
interface HTMLDialogElement {
    uxpShowModal(options?: { title?: string; resize?: "none" | "horizontal" | "vertical" | "both"; size?: { width: number; height: number } }): Promise<unknown>;
}
