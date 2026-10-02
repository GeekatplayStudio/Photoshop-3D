import { defineConfig, devices } from "@playwright/test";

/**
 * Browser tests of the WebView UI (panel + 3D editor) in Chromium — the same engine as
 * Photoshop's UXP WebView (WebView2) — against the mock host (src/web/bridge/mockHost.ts).
 * Photoshop itself is covered by the manual checklist in docs/TESTING.md.
 */
export default defineConfig({
    testDir: "tests/e2e",
    timeout: 60_000,
    expect: { timeout: 15_000 },
    fullyParallel: false,
    retries: process.env.CI ? 1 : 0,
    reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
    use: {
        baseURL: "http://localhost:5173",
        trace: "retain-on-failure",
        ...devices["Desktop Chrome"],
        launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
    },
    webServer: {
        command: "npm run dev:web",
        url: "http://localhost:5173/panel.html",
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
    },
});
