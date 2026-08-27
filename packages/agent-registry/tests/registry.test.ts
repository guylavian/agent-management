import { describe, expect, it } from "vitest";
import { loadAgentServiceRegistry } from "../src/index.ts";

describe("agent service registry", () => {
  it("resolves logical IDs and filters by entitlement and environment", () => {
    const registry = loadAgentServiceRegistry("agents/registry.yaml");
    expect(registry.resolve("active-directory")?.endpoint).toContain("sre-agent-active-directory");
    expect(registry.filterAuthorized(["active-directory", "network-observability"], ["infra-read"], "prod")).toEqual(["active-directory"]);
    expect(registry.mayRequestDomain("active-directory", "network-observability")).toBe(true);
  });
});
