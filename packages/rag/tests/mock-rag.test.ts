import { describe, expect, it } from "vitest";
import { MockRagClient } from "../src/index.ts";

describe("mock RAG ACLs", () => {
  it("returns only chunks authorized for each user", async () => {
    const rag = new MockRagClient();
    const request = { query: "replication", collections: ["ad-wiki"], environment: "prod", topK: 8, requestId: "req", identity: { subject: "alice", groups: [], roles: [] } };
    expect((await rag.retrieve(request)).length).toBeGreaterThan(0);
    expect(await rag.retrieve({ ...request, identity: { subject: "bob", groups: [], roles: [] } })).toEqual([]);
  });
});
