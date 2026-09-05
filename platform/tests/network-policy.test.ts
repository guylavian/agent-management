import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * The manager must not hold the specialists' data-plane access.
 *
 * The egress rule said so in a comment while permitting every platform-labelled
 * namespace on the same port ToolHive serves, so the separation existed only in
 * prose. A namespace the cluster labels as ToolHive is now excluded by the
 * selector itself.
 */

const chart = join(import.meta.dirname, "..", "..", "deploy", "runtime", "helm");

function render(mode: "manager" | "specialist"): Array<Record<string, unknown>> {
  const out = execFileSync("helm", ["template", "np", chart, "--set", `agent.mode=${mode}`, "--set", "agent.name=probe", "--set", "networkPolicy.enabled=true"], { encoding: "utf8" });
  return out.split(/^---$/mu).map((doc) => parse(doc) as Record<string, unknown>).filter((doc) => doc?.kind === "NetworkPolicy");
}

interface Peer { namespaceSelector?: { matchLabels?: Record<string, string>; matchExpressions?: Array<{ key: string; operator: string }> } }
interface Rule { to?: Peer[]; ports?: Array<{ port: number }> }

function platformEgress(mode: "manager" | "specialist"): Rule[] {
  const policy = render(mode)[0] as { spec: { egress: Rule[] } };
  return policy.spec.egress.filter((rule) => (rule.to ?? []).some((peer) => peer.namespaceSelector !== undefined));
}

describe("manager egress cannot reach ToolHive", () => {
  it("excludes a ToolHive-labelled namespace rather than relying on the port", () => {
    const rules = platformEgress("manager");
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      for (const peer of rule.to ?? []) {
        const expressions = peer.namespaceSelector?.matchExpressions ?? [];
        // the selector itself must rule ToolHive out; a port list cannot,
        // because ToolHive is reached on the same 443 as the IdP
        expect(expressions.some((expression) => /toolhive/iu.test(expression.key) && expression.operator === "DoesNotExist")).toBe(true);
      }
    }
  });

  it("still lets a specialist reach the platform namespaces it needs", () => {
    const rules = platformEgress("specialist");
    expect(rules.length).toBeGreaterThan(0);
    const ports = rules.flatMap((rule) => (rule.ports ?? []).map((port) => port.port));
    expect(ports).toContain(443);
    for (const rule of rules) {
      for (const peer of rule.to ?? []) {
        const expressions = peer.namespaceSelector?.matchExpressions ?? [];
        expect(expressions.some((expression) => /toolhive/iu.test(expression.key))).toBe(false);
      }
    }
  });
});
