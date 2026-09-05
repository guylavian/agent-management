import { describe, expect, it } from "vitest";
import { ConfigValidationError, loadAppConfig } from "../src/index.ts";

/**
 * Only one tool-credential strategy carries the human verifiably, so only one
 * may run in production. The weaker strategies exist for local work and are
 * refused at startup rather than left live where an operator would never see
 * that authorization had quietly become agent-only.
 */

const productionBase = {
  SRE_ENV: "production",
  SRE_CLIENT_OIDC: "real",
  SRE_CLIENT_LLM: "real",
  SRE_CLIENT_TOOLHIVE: "real",
  SRE_CLIENT_POSTGRES: "disabled",
  SRE_CLIENT_AGENT: "real",
  SRE_CLIENT_DELEGATION: "real",
  SRE_OIDC_JWKS_URI: "https://idp.test/jwks",
  SRE_INTERNAL_OIDC_JWKS_URI: "https://idp.test/jwks",
  SRE_INTERNAL_EXPECTED_SUBJECT: "system:serviceaccount:sre-assistant:sre-agent-manager",
  SRE_LLM_BASE_URL: "https://vllm.test",
  SRE_TOOLHIVE_ENDPOINTS_JSON: '{"keycloak":"https://toolhive.test/mcp"}',
  SRE_WORKLOAD_TOKEN_FILE: "/var/run/secrets/sre-workload/token",
  SRE_DELEGATION_PUBLIC_KEY_FILE: "/etc/sre/delegation/public.pem",
  SRE_DELEGATION_PRIVATE_KEY_PKCS8: "test-delegation-key-not-a-real-key",
};

describe("production tool-credential strategy", () => {
  it("accepts token-exchange, the one strategy that delegates the human", () => {
    const config = loadAppConfig({
      ...productionBase,
      SRE_TOOL_CREDENTIAL_STRATEGY: "token-exchange",
      SRE_TOOL_CREDENTIAL_TOKEN_ENDPOINT: "https://idp.test/token",
      SRE_TOOL_CREDENTIAL_CLIENT_SECRET: "specialist-secret",
    });
    expect(config.toolCredential.strategy).toBe("token-exchange");
  });

  it("refuses workload-client in production, which authorizes the agent and drops the person", () => {
    expect(() => loadAppConfig({
      ...productionBase,
      SRE_TOOL_CREDENTIAL_STRATEGY: "workload-client",
      SRE_TOOL_CREDENTIAL_TOKEN_ENDPOINT: "https://idp.test/token",
      SRE_TOOL_CREDENTIAL_CLIENT_SECRET: "s",
    })).toThrow(ConfigValidationError);
  });

  it("refuses signed-jwt in production, where one platform key could speak for any agent", () => {
    expect(() => loadAppConfig({
      ...productionBase,
      SRE_TOOL_CREDENTIAL_STRATEGY: "signed-jwt",
      SRE_TOOL_CREDENTIAL_PRIVATE_KEY_FILE: "/etc/sre/tool.pem",
    })).toThrow(/signed-jwt|production/u);
  });

  it("requires client authentication for the production exchange", () => {
    expect(() => loadAppConfig({
      ...productionBase,
      SRE_TOOL_CREDENTIAL_STRATEGY: "token-exchange",
      SRE_TOOL_CREDENTIAL_TOKEN_ENDPOINT: "https://idp.test/token",
    })).toThrow(/CLIENT_SECRET/u);
  });

  it("still allows the weaker strategies outside production", () => {
    const config = loadAppConfig({
      ...productionBase,
      SRE_ENV: "real-poc",
      SRE_TOOL_CREDENTIAL_STRATEGY: "signed-jwt",
      SRE_TOOL_CREDENTIAL_PRIVATE_KEY_FILE: ".real-poc/private.pem",
    });
    expect(config.toolCredential.strategy).toBe("signed-jwt");
  });
});

describe("manager identity binding", () => {
  it("requires the expected manager subject when specialists accept real workload tokens", () => {
    const { SRE_INTERNAL_EXPECTED_SUBJECT: _omitted, ...withoutSubject } = productionBase;
    expect(() => loadAppConfig({
      ...withoutSubject,
      SRE_TOOL_CREDENTIAL_STRATEGY: "token-exchange",
      SRE_TOOL_CREDENTIAL_TOKEN_ENDPOINT: "https://idp.test/token",
      SRE_TOOL_CREDENTIAL_CLIENT_SECRET: "s",
    })).toThrow(/SRE_INTERNAL_EXPECTED_SUBJECT/u);
  });

  it("carries the expected subject through to config", () => {
    const config = loadAppConfig({
      ...productionBase,
      SRE_TOOL_CREDENTIAL_STRATEGY: "token-exchange",
      SRE_TOOL_CREDENTIAL_TOKEN_ENDPOINT: "https://idp.test/token",
      SRE_TOOL_CREDENTIAL_CLIENT_SECRET: "s",
    });
    expect(config.internalOidc.expectedSubject).toBe("system:serviceaccount:sre-assistant:sre-agent-manager");
  });
});
