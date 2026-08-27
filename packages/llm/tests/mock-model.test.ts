import { describe, expect, it } from "vitest";
import { MockModelClient } from "../src/index.ts";

describe("mock OpenAI-compatible model", () => {
  it("returns deterministic guided JSON", async () => {
    const model = new MockModelClient();
    const response = await model.chat({ model: "tier-s", messages: [{ role: "user", content: "Why is OpenShift slow?" }], guidedJsonSchema: { type: "object" } });
    expect(JSON.parse(response.content ?? "{}")).toMatchObject({ agents: ["openshift", "network-observability"], abstain: false });
  });
});
