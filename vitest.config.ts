import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Unit tests run in Node against the pure helpers and the service layer. No
 * React rendering here on purpose: the UI is thin, the logic that can be
 * wrong (tenant filter, access rules, export, key checks) is not in JSX.
 */
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["tests/**/*.{test,spec}.ts", "src/**/*.{test,spec}.ts"],
    exclude: ["node_modules", ".next", "mcp"],
  },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
});
