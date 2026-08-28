import { describe, expect, it } from "vitest";
import { MockModelClient } from "../src/index.ts";

describe("mock OpenAI-compatible model", () => {
  it("returns deterministic guided JSON", async () => {
    const model = new MockModelClient();
    const response = await model.chat({ model: "tier-s", messages: [{ role: "user", content: "Why is OpenShift slow?" }], guidedJsonSchema: { type: "object" } });
    const decision = JSON.parse(response.content ?? "{}");
    expect(decision).toMatchObject({ abstain: false });
    expect(decision.routes.map((route: { agent: string }) => route.agent)).toEqual(["openshift", "network-observability"]);
    expect(decision.routes.every((route: { task: string }) => route.task.length > 0)).toBe(true);
  });
});
