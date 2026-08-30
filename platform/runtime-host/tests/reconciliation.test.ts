import { describe, expect, it } from "vitest";
import {
  ArgoCdStatusSource,
  DesiredStateSource,
  HttpRuntimeProbe,
  fingerprint,
  foldStatus,
  reconcile,
  unobserved,
  type Signal,
} from "@sre/runtime-host";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The rules that decide what colour an operator sees.
 *
 * Every case here is one that was previously answered by guessing: an unprobed
 * agent reported as reachable, a still-syncing pod reported as broken, a
 * deliberately disabled agent reported as degraded. The point of these is that
 * an honest `unknown` is a legitimate answer and a fabricated green is not.
 */
const ok: Signal = { state: "ok", detail: "ok" };
const pending: Signal = { state: "pending", detail: "pending" };
const degraded: Signal = { state: "degraded", detail: "degraded" };
const unknown: Signal = unobserved("nothing is configured to observe this");

describe("folding four signals into one status", () => {
  it("is ACTIVE on positive desired state even when nothing observes actual state", () => {
    // a deployment with neither Argo nor a probe wired would otherwise never
    // show a single healthy agent, which would make the badge meaningless
    expect(foldStatus({ git: ok, argo: unknown, runtime: unknown, manager: ok, draft: false, disabled: false })).toBe("active");
  });

  it("is RECONCILING while Argo is still syncing, however the pod answers", () => {
    // every onboarding passes through this window; calling it degraded would
    // mean every successful create flashed red on its way to working
    expect(foldStatus({ git: ok, argo: pending, runtime: degraded, manager: pending, draft: false, disabled: false })).toBe("reconciling");
  });

  it("is DEGRADED once the pod is failing and Argo has finished", () => {
    expect(foldStatus({ git: ok, argo: ok, runtime: degraded, manager: ok, draft: false, disabled: false })).toBe("degraded");
  });

  it("is DISABLED rather than degraded when the Agent is off on purpose", () => {
    // a terminating pod for an agent someone deliberately turned off is not an
    // incident, and reporting it as one trains people to ignore "degraded"
    expect(foldStatus({ git: pending, argo: degraded, runtime: degraded, manager: pending, draft: false, disabled: true })).toBe("disabled");
  });

  it("is FAILED when desired state itself does not load, whatever is running", () => {
    expect(foldStatus({ git: degraded, argo: ok, runtime: ok, manager: ok, draft: false, disabled: false })).toBe("failed");
  });
});

describe("the git signal names which half of desired state is missing", () => {
  const base = { agentId: "a", environment: "production", routable: false, argo: unknown, runtime: unknown };

  it("distinguishes 'not deployed here' from 'deliberately disabled'", () => {
    // the catalog collapses both into enabled:false; the console must not
    const notDeployed = reconcile({ ...base, lifecycle: "active" as const });
    const turnedOff = reconcile({ ...base, lifecycle: "active" as const, overlay: { apiVersion: "sre.ai/v1alpha1", kind: "AgentDeployment", agentId: "a", enabled: false } });
    expect(notDeployed.status).toBe("reconciling");
    expect(notDeployed.git.detail).toMatch(/no deployment overlay/u);
    expect(turnedOff.status).toBe("disabled");
    expect(turnedOff.git.detail).toMatch(/enabled: false/u);
  });

  it("says why an agent is not routable instead of only that it is not", () => {
    const result = reconcile({ ...base, lifecycle: "disabled" as const });
    expect(result.manager.state).not.toBe("ok");
    expect(result.manager.detail).toMatch(/lifecycle is "disabled"/u);
  });
});

describe("Argo CD status, read rather than assumed", () => {
  const source = (handler: (url: string) => Response) =>
    new ArgoCdStatusSource({ baseUrl: "https://argo.internal", token: "t", fetchImplementation: async (input) => handler(String(input)), now: () => 0, ttlMs: 0 });

  it("treats a missing Application as PENDING, not as a failure", async () => {
    // the ApplicationSet has not generated it yet — the normal state seconds
    // after a merge, and the moment an operator is most likely to be watching
    const signal = await source(() => new Response("", { status: 404 })).status("kafka");
    expect(signal.state).toBe("pending");
    expect(signal.detail).toContain("sre-agent-kafka");
  });

  it("reports Degraded health as degraded, with the sync and health words", async () => {
    const signal = await source(() => Response.json({ status: { sync: { status: "Synced" }, health: { status: "Degraded" } } })).status("kafka");
    expect(signal).toEqual({ state: "degraded", detail: "sync Synced, health Degraded" });
  });

  it("reports UNKNOWN, never degraded, when Argo itself cannot be reached", async () => {
    // an unreachable control plane says nothing about the agent, and rendering
    // it as the agent's failure would send someone to debug the wrong thing
    const signal = await source(() => { throw new Error("ECONNREFUSED https://argo.internal"); }).status("kafka");
    expect(signal.state).toBe("unknown");
    // and never echoes the transport error, which can disclose internal hosts
    expect(signal.detail).not.toContain("argo.internal");
  });
});

describe("the runtime probe asks the endpoint the router would use", () => {
  it("reports ok only when something actually answered", async () => {
    const probe = new HttpRuntimeProbe({ fetchImplementation: async () => new Response("", { status: 200 }), now: () => 0, ttlMs: 0 });
    expect((await probe.status("kafka", "http://sre-agent-kafka.ns.svc/")).state).toBe("ok");
  });

  it("reports a non-answering pod as degraded rather than unknown", async () => {
    const probe = new HttpRuntimeProbe({ fetchImplementation: async () => { throw new Error("refused"); }, now: () => 0, ttlMs: 0 });
    const signal = await probe.status("kafka", "http://sre-agent-kafka.ns.svc");
    expect(signal.state).toBe("degraded");
    expect(signal.detail).toMatch(/did not answer/u);
  });

  it("hits /health/ready on the catalog endpoint, without doubling the slash", async () => {
    const seen: string[] = [];
    const probe = new HttpRuntimeProbe({ fetchImplementation: async (input) => { seen.push(String(input)); return new Response("", { status: 200 }); }, now: () => 0, ttlMs: 0 });
    await probe.status("kafka", "http://sre-agent-kafka.ns.svc/");
    expect(seen).toEqual(["http://sre-agent-kafka.ns.svc/health/ready"]);
  });
});

describe("desired state re-reads, and fails closed only at startup", () => {
  it("throws on the FIRST load: a process whose configuration is invalid must not start", () => {
    expect(() => new DesiredStateSource(() => { throw new Error("invalid"); }, () => "r")).toThrow(/invalid/u);
  });

  it("keeps the last good snapshot when a LATER load fails, and records why", () => {
    let revision = "r1";
    let broken = false;
    const source = new DesiredStateSource(
      () => { if (broken) throw new Error("schema validation failed for kafka.yaml"); return good(); },
      () => revision,
      { revalidateMs: 0, now: () => 0 },
    );
    expect(source.current().error).toBeUndefined();
    broken = true;
    revision = "r2";
    const stale = source.current();
    // taking a working platform down because one NEW file is malformed would be
    // a worse failure than serving the last state that validated and saying so
    expect(stale.environment).toBe("production");
    expect(stale.error).toMatch(/kafka\.yaml/u);
  });

  it("does not reload when nothing changed, so polling is cheap", () => {
    let loads = 0;
    const source = new DesiredStateSource(() => { loads += 1; return good(); }, () => "same", { revalidateMs: 0, now: () => 0 });
    source.current();
    source.current();
    expect(loads).toBe(1);
  });
});

describe("the change-detector notices what actually changes on disk", () => {
  it("changes when a file is added, edited or removed", () => {
    const dir = mkdtempSync(join(tmpdir(), "sre-fingerprint-"));
    try {
      writeFileSync(join(dir, "a.yaml"), "one", "utf8");
      const first = fingerprint([dir]);
      // a NEW agent: the most important case, and the one a content hash of a
      // single file would miss entirely
      writeFileSync(join(dir, "b.yaml"), "two", "utf8");
      const second = fingerprint([dir]);
      expect(second).not.toBe(first);
      // size changes even when a ConfigMap remount leaves mtimes alone
      writeFileSync(join(dir, "b.yaml"), "two-longer", "utf8");
      expect(fingerprint([dir])).not.toBe(second);
      rmSync(join(dir, "b.yaml"));
      expect(fingerprint([dir])).toBe(first);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("distinguishes a missing path from an empty one", () => {
    expect(fingerprint(["/definitely/not/here"])).toContain("absent");
  });
});

function good() {
  return {
    registry: {} as never,
    catalog: { listEnabled: () => [] } as never,
    environment: "production",
    enabledAgentIds: [],
    overlays: new Map(),
  };
}
