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

/**
 * A gitSync sidecar shares its pod's NetworkPolicy. Enabling it behind an
 * enabled policy that names no route to the git remote produced a pod that
 * could never sync — observed in a live cluster as a five-day CrashLoopBackOff
 * whose only symptom was "Couldn't connect to server". The chart must refuse to
 * render that pod instead of shipping it, and must write the egress rule when
 * the operator names where the remote lives.
 */
function renderGitSync(args: string[]): string {
  return execFileSync("helm", ["template", "np", chart, "--set", "agent.mode=manager", "--set", "agent.name=probe", "--set", "networkPolicy.enabled=true", "--set", "gitSync.enabled=true", "--set", "gitSync.repoURL=https://git.example/repo.git", ...args], { encoding: "utf8" });
}

describe("a gitSync pod cannot be rendered unable to reach its remote", () => {
  it("refuses to render when the policy is on and no route to the remote is named", () => {
    // fail closed at render time: the alternative is a pod that starts,
    // reports itself alive, and never once reads desired state
    expect(() => renderGitSync([])).toThrow(/gitSync\.egressCIDRs/u);
  });

  it("writes an egress rule to the named remote when the operator declares it", () => {
    const rendered = renderGitSync(["--set", "gitSync.egressCIDRs={10.20.0.0/16}"]);
    const policy = rendered.split(/^---$/mu).map((doc) => parse(doc) as Record<string, unknown>).find((doc) => doc?.kind === "NetworkPolicy") as { spec: { egress: Rule[] } };
    const gitRule = policy.spec.egress.find((rule) => (rule.to ?? []).some((peer) => (peer as { ipBlock?: { cidr: string } }).ipBlock?.cidr === "10.20.0.0/16"));
    expect(gitRule).toBeDefined();
    expect((gitRule?.ports ?? []).map((port) => port.port)).toContain(443);
  });

  it("leaves the policy alone when gitSync is off", () => {
    const rendered = execFileSync("helm", ["template", "np", chart, "--set", "agent.mode=manager", "--set", "agent.name=probe", "--set", "networkPolicy.enabled=true"], { encoding: "utf8" });
    expect(rendered).not.toContain("ipBlock");
  });
});

/**
 * The built-in egress shapes cover the platform services this chart knows about.
 * A deployment whose model endpoint, IdP or collector sits somewhere those
 * selectors cannot name has no way to reach it, and the failure appears as a
 * timeout inside the runtime rather than as a policy decision. The escape hatch
 * is explicit and empty by default, so the closed posture is what you get
 * unless an operator writes a rule down.
 */
describe("an operator can permit egress the built-in shapes cannot express", () => {
  it("emits nothing extra by default", () => {
    const rendered = execFileSync("helm", ["template", "np", chart, "--set", "agent.mode=specialist", "--set", "agent.name=probe", "--set", "networkPolicy.enabled=true"], { encoding: "utf8" });
    expect(rendered).not.toContain("11434");
  });

  it("emits the operator's rule verbatim when one is given", () => {
    const rendered = execFileSync("helm", ["template", "np", chart, "--set", "agent.mode=specialist", "--set", "agent.name=probe", "--set", "networkPolicy.enabled=true",
      "--set", "networkPolicy.extraEgress[0].ports[0].protocol=TCP",
      "--set", "networkPolicy.extraEgress[0].ports[0].port=11434"], { encoding: "utf8" });
    const policy = rendered.split(/^---$/mu).map((doc) => parse(doc) as Record<string, unknown>).find((doc) => doc?.kind === "NetworkPolicy") as { spec: { egress: Rule[] } };
    expect(policy.spec.egress.some((rule) => (rule.ports ?? []).some((port) => port.port === 11434))).toBe(true);
  });
});

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
