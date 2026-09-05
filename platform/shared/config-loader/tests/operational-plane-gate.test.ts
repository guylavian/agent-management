import { describe, expect, it } from "vitest";
import { ConfigValidationError, loadAppConfig } from "../src/index.ts";

/**
 * Turning the operational plane on decides ROUTING: an agent is routable only
 * when a reconciler has written its activation row and a fresh attestation.
 * Nothing in this repository runs that reconciler yet, so switching the flag on
 * without one means every agent reads as not-ready — a total routing outage
 * produced by a single environment variable.
 *
 * The flag therefore refuses to start unless the two things it depends on are
 * present and stated: a real database to read, and an acknowledged reconciler
 * writing into it.
 */

const base = {
  SRE_ENV: "production",
  SRE_CLIENT_OIDC: "real",
  SRE_CLIENT_LLM: "real",
  SRE_CLIENT_TOOLHIVE: "real",
  SRE_CLIENT_AGENT: "real",
  SRE_CLIENT_DELEGATION: "real",
  SRE_OIDC_JWKS_URI: "https://idp.test/jwks",
  SRE_INTERNAL_OIDC_JWKS_URI: "https://idp.test/jwks",
  SRE_INTERNAL_EXPECTED_SUBJECT: "system:serviceaccount:sre-assistant:sre-agent-manager",
  SRE_LLM_BASE_URL: "https://vllm.test",
  SRE_TOOLHIVE_ENDPOINTS_JSON: '{"keycloak":"https://toolhive.test/mcp"}',
  SRE_TOOL_CREDENTIAL_STRATEGY: "token-exchange",
  SRE_TOOL_CREDENTIAL_TOKEN_ENDPOINT: "https://idp.test/token",
  SRE_TOOL_CREDENTIAL_CLIENT_SECRET: "specialist-secret",
  SRE_WORKLOAD_TOKEN_FILE: "/var/run/secrets/sre-workload/token",
  SRE_DELEGATION_PUBLIC_KEY_FILE: "/etc/sre/delegation/public.pem",
  SRE_DELEGATION_PRIVATE_KEY_PKCS8: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----",
};

describe("operational plane refuses to run without what it depends on", () => {
  it("refuses to enable without a database to read agent state from", () => {
    expect(() => loadAppConfig({
      ...base,
      SRE_CLIENT_POSTGRES: "disabled",
      SRE_OPERATIONAL_PLANE: "on",
      SRE_OPERATIONAL_RECONCILER: "external",
    })).toThrow(/operational plane/iu);
  });

  it("refuses to enable when no reconciler is acknowledged, rather than reading an empty table as 'nothing is ready'", () => {
    expect(() => loadAppConfig({
      ...base,
      SRE_CLIENT_POSTGRES: "real",
      SRE_POSTGRES_URL: "postgres://user:pw@db/sre",
      SRE_OPERATIONAL_PLANE: "on",
    })).toThrow(/SRE_OPERATIONAL_RECONCILER/u);
  });

  it("starts when both the database and a reconciler are present", () => {
    const config = loadAppConfig({
      ...base,
      SRE_CLIENT_POSTGRES: "real",
      SRE_POSTGRES_URL: "postgres://user:pw@db/sre",
      SRE_OPERATIONAL_PLANE: "on",
      SRE_OPERATIONAL_RECONCILER: "external",
    });
    expect(config.reconciliation.operationalPlane).toBe(true);
  });

  it("leaves the plane off alone — no reconciler is required when nothing reads agent state", () => {
    const config = loadAppConfig({ ...base, SRE_CLIENT_POSTGRES: "disabled" });
    expect(config.reconciliation.operationalPlane).toBe(false);
  });
});
