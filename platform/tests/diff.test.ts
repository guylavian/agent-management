import { diffFile, summarise } from "@sre/runtime-host";
import { describe, expect, it } from "vitest";

/**
 * Change-set diffs.
 *
 * The diffing is jsdiff's `structuredPatch`; what is tested here is the layer
 * around it — the status a file gets, the counts, the line numbering, and the
 * fact that unchanged regions do not reach the console.
 */

const YAML_BEFORE = `apiVersion: sre.ai/v1alpha1
kind: Agent
metadata:
  name: active-directory
  owner: domain-services
spec:
  type: specialist
  lifecycle: active
  model: { tier: small, profile: tool-caller }
  environments: ["prod", "dr"]
  access:
    - mcp: active-directory
      tools: [get_dc_health]
  security: { readOnly: true }
`;

const YAML_AFTER = `apiVersion: sre.ai/v1alpha1
kind: Agent
metadata:
  name: active-directory
  owner: platform-identity
spec:
  type: specialist
  lifecycle: active
  model: { tier: small, profile: tool-caller }
  environments: ["prod", "dr", "lab"]
  access:
    - mcp: active-directory
      tools: [get_dc_health, get_dns_health]
  security: { readOnly: true }
`;

describe("a file's status says what happened to it", () => {
  it("calls a file that is not on disk an addition, not a diff against nothing", () => {
    const diff = diffFile("config/agents/check-point.yaml", undefined, "kind: Agent\nname: check-point\n");
    expect(diff.status).toBe("added");
    expect(diff.additions).toBe(2);
    expect(diff.deletions).toBe(0);
  });

  it("calls a file with no proposed content a deletion", () => {
    const diff = diffFile("config/agents/old.yaml", "kind: Agent\nname: old\n", undefined);
    expect(diff.status).toBe("deleted");
    expect(diff.deletions).toBe(2);
    expect(diff.additions).toBe(0);
  });

  it("calls an edited file modified", () => {
    expect(diffFile("a.yaml", YAML_BEFORE, YAML_AFTER).status).toBe("modified");
  });

  it("calls an identical file unchanged and produces no hunks for it", () => {
    const diff = diffFile("a.yaml", YAML_BEFORE, YAML_BEFORE);
    expect(diff.status).toBe("unchanged");
    expect(diff.hunks).toEqual([]);
    expect(diff.additions + diff.deletions).toBe(0);
  });
});

describe("the counts are the counts", () => {
  it("counts each changed line once, on the correct side", () => {
    const diff = diffFile("a.yaml", YAML_BEFORE, YAML_AFTER);
    // three lines changed: owner, environments, tools
    expect(diff.additions).toBe(3);
    expect(diff.deletions).toBe(3);
  });

  it("numbers lines against the file each side belongs to", () => {
    const diff = diffFile("a.yaml", "one\ntwo\nthree\n", "one\nTWO\nthree\n");
    const lines = diff.hunks.flatMap(hunk => hunk.lines);
    const removed = lines.find(line => line.kind === "remove");
    const added = lines.find(line => line.kind === "add");

    expect(removed).toMatchObject({ text: "two", before: 2 });
    expect(removed?.after).toBeUndefined();
    expect(added).toMatchObject({ text: "TWO", after: 2 });
    expect(added?.before).toBeUndefined();
  });

  it("emits a git-style header per hunk", () => {
    const diff = diffFile("a.yaml", YAML_BEFORE, YAML_AFTER);
    for (const hunk of diff.hunks) expect(hunk.header).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@$/u);
  });
});

describe("unchanged regions do not reach the console", () => {
  it("shows the change and its context, not the rest of the file", () => {
    const before = `${Array.from({ length: 60 }, (_v, index) => `line ${index}`).join("\n")}\n`;
    const after = before.replace("line 30", "line 30 CHANGED");

    const diff = diffFile("long.yaml", before, after);
    const shown = diff.hunks.reduce((total, hunk) => total + hunk.lines.length, 0);

    // one change plus three lines of context either side
    expect(shown).toBeLessThanOrEqual(8);
    expect(shown).toBeGreaterThan(1);
    expect(diff.hunks).toHaveLength(1);
  });

  it("keeps distant changes in separate hunks rather than joining them", () => {
    const before = `${Array.from({ length: 80 }, (_v, index) => `line ${index}`).join("\n")}\n`;
    const after = before.replace("line 5", "FIRST").replace("line 70", "SECOND");
    expect(diffFile("long.yaml", before, after).hunks).toHaveLength(2);
  });
});

describe("a prompt is diffed the same way a config file is", () => {
  it("diffs markdown by line, with no special casing", () => {
    const before = "# Active Directory specialist\n\nYou investigate AD.\n\n- Use the wiki tools.\n";
    const after = "# Active Directory specialist\n\nYou investigate Active Directory and DNS.\n\n- Use the wiki tools.\n";

    const diff = diffFile("config/prompts/active-directory.md", before, after);
    expect(diff.status).toBe("modified");
    expect(diff.additions).toBe(1);
    expect(diff.deletions).toBe(1);
    expect(diff.hunks[0]?.lines.some(line => line.kind === "add" && line.text.includes("DNS"))).toBe(true);
  });
});

describe("a binary file is reported, not rendered", () => {
  it("produces no hunks for an image and says why", () => {
    const diff = diffFile("assets/agents/keycloak.png", undefined, "iVBORw0KGgo=", true);
    expect(diff.binary).toBe(true);
    expect(diff.hunks).toEqual([]);
    // it is still a real part of the change-set, so it still has a status
    expect(diff.status).toBe("added");
  });
});

describe("the summary is what the header shows", () => {
  it("totals a multi-file change-set and counts only what changed", () => {
    const summary = summarise([
      diffFile("config/agents/a.yaml", YAML_BEFORE, YAML_AFTER),
      diffFile("config/prompts/a.md", "old prompt\n", "new prompt\n"),
      diffFile("deploy/environments/local/agents/a.yaml", "enabled: true\n", "enabled: true\n"),
      diffFile("assets/agents/a.png", undefined, "bytes", true),
    ]);

    expect(summary.additions).toBe(4);
    expect(summary.deletions).toBe(4);
    // the unchanged overlay is present in the list but not counted as a change
    expect(summary.changed).toBe(3);
    expect(summary.files).toHaveLength(4);
  });
});
