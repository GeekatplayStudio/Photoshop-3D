import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
    resolve: {
        alias: {
            "@shared": resolve(root, "src/shared"),
            "@host": resolve(root, "src/host"),
            "@web": resolve(root, "src/web"),
        },
    },
    test: {
        include: ["src/**/*.test.{ts,tsx}", "tests/unit/**/*.test.{ts,tsx}", "scripts/**/*.test.mjs"],
        // Web component tests opt into jsdom with a `// @vitest-environment jsdom` header.
        environment: "node",
        restoreMocks: true,
    },
});
