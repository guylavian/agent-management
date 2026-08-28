import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "contracts/*/tests/**/*.test.ts",
      "runtime/packages/*/tests/**/*.test.ts",
      "runtime/app/tests/**/*.test.ts",
      "management/packages/*/tests/**/*.test.ts",
      "eval/tests/**/*.test.ts",
    ],
    environment: "node",
    testTimeout: 15_000,
  },
});
