import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";

/**
 * ON-PREM EXAMPLES MUST BE CONSISTENT WITH THE PER-SPECIALIST CREDENTIAL MODEL.
 *
 * Each specialist must authenticate as its own Keycloak client using its own
 * Secret (sre-agent-<agent>-secrets). Sharing a credential boundary would
 * make every specialist a vector for every other — one stolen key speaks for all.
 *
 * The chart default (specialistSecret: "") means "use sre-agent-<agent>-secrets",
 * which is the correct per-agent model. The on-prem examples must not override
 * this to a single shared secret; they must agree with the design and the
 * secrets they create.
 */
describe("on-prem examples agree on the per-specialist credential model", () => {
  const deployRoot = join(import.meta.dirname, "..", "..", "deploy");
  const runtimeValuesExample = parseAllDocuments(
    readFileSync(join(deployRoot, "on-prem", "runtime-values.example.yaml"), "utf8"),
  )[0]?.toJS() as {
    specialistSecret?: string;
  };

  const secretsExample = parseAllDocuments(
    readFileSync(join(deployRoot, "on-prem", "secrets.example.yaml"), "utf8"),
  ).map((doc) => doc.toJS() as {
    metadata?: { name?: string };
    kind?: string;
  });

  it("runtime-values.example.yaml uses the default per-agent secret model (empty string)", () => {
    // Empty string means "sre-agent-<agent>-secrets", per the chart default
    expect(runtimeValuesExample.specialistSecret).toBe("");
  });

  it("secrets.example.yaml creates per-agent secrets, not a shared one", () => {
    // Find the specialist secret in the examples
    const specialistSecrets = secretsExample.filter(
      (doc) => doc.kind === "Secret" && doc.metadata?.name?.includes("agent"),
    );

    // Should have per-agent examples, not a single shared "specialist-secrets"
    const hasSharedSecret = specialistSecrets.some((doc) => doc.metadata?.name === "sre-agent-specialist-secrets");
    expect(hasSharedSecret).toBe(false);

    // Should mention the per-agent pattern in a comment (we check this indirectly
    // by verifying the current example has sre-agent-keycloak-secrets as an example)
    const hasPerAgentExample = specialistSecrets.some((doc) => doc.metadata?.name === "sre-agent-keycloak-secrets");
    expect(hasPerAgentExample).toBe(true);
  });
});
