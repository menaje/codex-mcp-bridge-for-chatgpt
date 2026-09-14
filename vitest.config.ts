import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["output/**", "dist/**", "node_modules/**"]
  }
});
