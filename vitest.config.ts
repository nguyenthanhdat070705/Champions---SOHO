import { defineConfig } from "vitest/config";

// Vitest runs the pure-logic unit tests under src/ (validators, step logic).
// The PayOS server tests under test/ run separately via `node --test` (they use
// the node:test runner), so they are excluded here to avoid double-execution.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["test/**", "node_modules/**", "dist/**"],
  },
});
