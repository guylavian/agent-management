import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "libs/contracts/*/tests/**/*.test.ts",
      "libs/shared/*/tests/**/*.test.ts",
      "core/agent-engine/tests/**/*.test.ts",
      "core/orchestrator/tests/**/*.test.ts",
      "core/runtime-host/tests/**/*.test.ts",
      "engineering/tools/keycloak-provisioning/tests/**/*.test.ts",
      "engineering/eval/tests/**/*.test.ts",
      "engineering/tests/**/*.test.ts",
    ],
    environment: "node",
    testTimeout: 15_000,
  },
});
