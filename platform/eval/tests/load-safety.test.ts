import { loadAppConfig } from "@sre/config";
import { describe, expect, it } from "vitest";
import { assertLoadProfileSafe } from "../load/run-load.ts";

describe("load safety", () => {
  it("refuses the storm profile against real ToolHive", () => {
    const config = loadAppConfig({ SRE_CLIENT_TOOLHIVE: "real", SRE_TOOLHIVE_URL: "https://toolhive.internal", SRE_TOOL_CREDENTIAL_TOKEN_ENDPOINT: "https://sts.internal/token" });
    expect(() => assertLoadProfileSafe(config, "storm", true)).toThrow(/50-user storm.*mock ToolHive/iu);
  });

  it("allows the storm profile against mocks only", () => {
    expect(() => assertLoadProfileSafe(loadAppConfig({}), "storm")).not.toThrow();
  });

  it("refuses the storm profile against a real agent client", () => {
    const config = loadAppConfig({
      SRE_CLIENT_AGENT: "real",
      SRE_INTERNAL_OIDC_JWKS_URI: "https://workload-idp.internal/jwks",
      SRE_WORKLOAD_TOKEN_FILE: "/var/run/secrets/sre/token",
    });
    expect(() => assertLoadProfileSafe(config, "storm", true)).toThrow(/mock agent client/iu);
  });

  it("requires explicit approval for any real-backend load", () => {
    const config = loadAppConfig({ SRE_CLIENT_TOOLHIVE: "real", SRE_TOOLHIVE_URL: "https://toolhive.internal", SRE_TOOL_CREDENTIAL_TOKEN_ENDPOINT: "https://sts.internal/token" });
    expect(() => assertLoadProfileSafe(config, "normal", false)).toThrow(/owner approval/iu);
  });
});
