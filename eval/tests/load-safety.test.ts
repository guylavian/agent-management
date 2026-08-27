import { loadAppConfig } from "@sre/config";
import { describe, expect, it } from "vitest";
import { assertLoadProfileSafe } from "../load/run-load.ts";

describe("load safety", () => {
  it("refuses the storm profile against real ToolHive", () => {
    const config = loadAppConfig({ SRE_CLIENT_TOOLHIVE: "real", SRE_TOOLHIVE_URL: "https://toolhive.internal" });
    expect(() => assertLoadProfileSafe(config, "storm", true)).toThrow(/50-user storm.*mock ToolHive/iu);
  });

  it("allows the storm profile against mocks only", () => {
    expect(() => assertLoadProfileSafe(loadAppConfig({}), "storm")).not.toThrow();
  });

  it("requires explicit approval for any real-backend load", () => {
    const config = loadAppConfig({ SRE_CLIENT_TOOLHIVE: "real", SRE_TOOLHIVE_URL: "https://toolhive.internal" });
    expect(() => assertLoadProfileSafe(config, "normal", false)).toThrow(/owner approval/iu);
  });
});
