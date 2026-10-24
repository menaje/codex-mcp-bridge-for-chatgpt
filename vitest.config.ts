import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration fixtures open real SQLite databases and spawn runtimes.
    // This outer budget does not change the product deadlines they assert.
    testTimeout: 15_000,
    include: ["test/**/*.test.ts"],
    exclude: ["output/**", "dist/**", "node_modules/**"]
  }
});
