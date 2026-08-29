import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "contracts/*/tests/**/*.test.ts",
      "shared/*/tests/**/*.test.ts",
      "orchestrator/tests/**/*.test.ts",
      "runtime-host/tests/**/*.test.ts",
      "tools/keycloak-provisioning/tests/**/*.test.ts",
      "eval/tests/**/*.test.ts",
      "tests/**/*.test.ts",
    ],
    environment: "node",
    testTimeout: 15_000,
  },
});
