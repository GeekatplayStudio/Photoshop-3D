import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listFiles, readZip, validateManifest, zipFolder } from "./ccx.mjs";
import { sectionFor } from "./release-notes.mjs";

const manifest = JSON.parse(readFileSync(new URL("../plugin/manifest.json", import.meta.url), "utf8"));
const required = ["index.html", "host.js", "manifest.json", "build-info.json", "web/panel.html", "web/editor.html", "icons/plugin@1x.png", "icons/plugin@2x.png", "icons/panel-dark@1x.png", "icons/panel-dark@2x.png", "icons/panel-light@1x.png", "icons/panel-light@2x.png"];

describe("ccx packaging", () => {
    it("zips without directory entries, with forward slashes, skipping sourcemaps", () => {
        const dir = mkdtempSync(join(tmpdir(), "ps3d-ccx-"));
        mkdirSync(join(dir, "web", "assets"), { recursive: true });
        writeFileSync(join(dir, "manifest.json"), "{}");
        writeFileSync(join(dir, "web", "assets", "a.js"), "x");
        writeFileSync(join(dir, "web", "assets", "a.js.map"), "{}");
        writeFileSync(join(dir, ".DS_Store"), "");
        expect(listFiles(dir)).toEqual(["manifest.json", "web/assets/a.js", "web/assets/a.js.map"]);
        const entries = Object.keys(readZip(zipFolder(dir)));
        expect(entries.sort()).toEqual(["manifest.json", "web/assets/a.js"]);
        expect(entries.some((e) => e.endsWith("/") || e.includes("\\"))).toBe(false);
    });

    it("accepts the real manifest with all files present", () => {
        expect(validateManifest({ ...manifest, version: "1.2.3" }, required)).toEqual([]);
    });

    it("requires @1x/@2x icon files and chrome panel icons, so the dock icon shows on Windows", () => {
        // The v0.1.1 layout: 1x files without "@1x" and panel icons without a species.
        const oldFiles = required.map((f) => f.replace("@1x.png", ".png"));
        const panel = manifest.entrypoints.find((e) => e.type === "panel");
        const oldManifest = { ...manifest, version: "1.2.3", entrypoints: [{ ...panel, icons: panel.icons.map(({ species: _, ...i }) => i) }] };
        const problems = validateManifest(oldManifest, oldFiles).join("\n");
        expect(problems).toMatch(/icon file missing: icons\/panel-dark@1x\.png/);
        expect(problems).toMatch(/icon file missing: icons\/plugin@1x\.png/);
        expect(problems).toMatch(/species.*chrome/);
    });

    it("rejects what Adobe's installer or the plugin cannot use", () => {
        const problems = validateManifest({ ...manifest, version: "1.2", icons: [], host: { app: "PS", minVersion: "24.0.0" }, requiredPermissions: {} }, required.filter((f) => f !== "web/editor.html"));
        expect(problems.join("\n")).toMatch(/version must be x\.y\.z/);
        expect(problems.join("\n")).toMatch(/plugin icons missing/);
        expect(problems.join("\n")).toMatch(/minVersion must be ≥ 26/);
        expect(problems.join("\n")).toMatch(/webview permission/);
        expect(problems.join("\n")).toMatch(/web\/editor\.html/);
    });
});

describe("release notes", () => {
    it("extracts one version's section from the changelog", () => {
        const log = "# Changelog\n\n## [Unreleased]\n\n## [0.2.0] - 2026-10-10\n- New thing\n\n## [0.1.0] - 2026-10-02\n- First\n";
        expect(sectionFor(log, "0.2.0")).toBe("- New thing");
        expect(sectionFor(log, "0.1.0")).toBe("- First");
        expect(sectionFor(log, "9.9.9")).toBeNull();
    });
});
