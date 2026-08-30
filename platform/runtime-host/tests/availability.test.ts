import { describe, expect, it, vi } from "vitest";
import { StaticAgentCatalog, type AgentCatalogEntry } from "@sre/config";
import {
  DesiredStateSource,
  NOTHING_OBSERVED,
  ProbeAvailabilityMonitor,
  effectiveCatalog,
  foldStatus,
  reconcile,
  unobserved,
  type RuntimeProbe,
  type Signal,
} from "@sre/runtime-host";

/**
 * THE MANAGER ROUTES ONLY TO AGENTS THAT ARE ACTUALLY AVAILABLE.
 *
 * Desired state says an Agent SHOULD be running; that is not the same as it
 * being reachable. The Manager used to be offered the first while needing the
 * second, so a merged, enabled Agent with a crash-looping pod was routed to on
 * merit, failed at fan-out, and came back to the user as a degraded answer with
 * an evidence gap — when it should never have been offered.
 *
 * The rule that makes this safe rather than fragile is FAIL-OPEN ON UNKNOWN:
 * only a positive observation of failure removes an Agent. Nothing is invented
 * in either direction.
 */
const entry = (agentId: string): AgentCatalogEntry => ({
  agentId,
  endpoint: `http://sre-agent-${agentId}.ns.svc`,
  owner: "sre-platform",
  description: agentId,
  enabled: true,
  environments: ["prod"],
  requiredRoles: ["infra-read"],
  allowedNeedsDomains: [],
  routing: { capabilities: [], exclusions: [] },
});

function sourceOf(agentIds: string[]): DesiredStateSource {
  const catalog = new StaticAgentCatalog(agentIds.map(entry));
  return new DesiredStateSource(
    () => ({ registry: {} as never, catalog, environment: "production", enabledAgentIds: agentIds, overlays: new Map() }),
    () => "revision",
    { revalidateMs: 0, now: () => 0 },
  );
}

describe("the effective catalog intersects desired state with observation", () => {
  it("offers an Agent nobody has observed, rather than emptying the catalog", () => {
    // a deployment with no probe wired observes nothing; treating that as
    // "unavailable" would take routing down everywhere the probe is not set up
    const catalog = effectiveCatalog(sourceOf(["a", "b"]), NOTHING_OBSERVED);
    expect(catalog.listEnabled("prod").map(item => item.agentId)).toEqual(["a", "b"]);
    expect(catalog.filterAuthorized(["a"], ["infra-read"], "prod")).toEqual(["a"]);
  });

  it("removes only an Agent observed to be failing", () => {
    const catalog = effectiveCatalog(sourceOf(["a", "b"]), {
      signal: (id) => (id === "b" ? { state: "degraded", detail: "the pod did not answer" } : unobserved("not probed")),
    });
    expect(catalog.listEnabled("prod").map(item => item.agentId)).toEqual(["a"]);
  });

  it("enforces availability on the AUTHORITATIVE gate, not only on what was offered", () => {
    // filterAuthorized is what runs immediately before dispatch and on the
    // Round-2 follow-up path; gating only listEnabled would let a discovered
    // domain reach a pod that is known to be down
    const catalog = effectiveCatalog(sourceOf(["a"]), { signal: () => ({ state: "degraded", detail: "down" }) });
    expect(catalog.filterAuthorized(["a"], ["infra-read"], "prod")).toEqual([]);
  });

  it("still RESOLVES an unavailable Agent, so a real domain stays distinct from a typo", () => {
    // Round 2 reports "invalid-domain" and "not-enabled" differently, and
    // collapsing them would send an operator to fix the wrong thing
    const catalog = effectiveCatalog(sourceOf(["a"]), { signal: () => ({ state: "degraded", detail: "down" }) });
    expect(catalog.resolve("a")).toBeDefined();
    expect(catalog.resolve("never-existed")).toBeUndefined();
  });

  it("follows desired state as it changes, without being rebuilt", () => {
    let agentIds = ["a"];
    const source = new DesiredStateSource(
      () => ({ registry: {} as never, catalog: new StaticAgentCatalog(agentIds.map(entry)), environment: "production", enabledAgentIds: agentIds, overlays: new Map() }),
      () => agentIds.join(","),
      { revalidateMs: 0, now: () => 0 },
    );
    const catalog = effectiveCatalog(source, NOTHING_OBSERVED);
    expect(catalog.listEnabled("prod")).toHaveLength(1);
    agentIds = ["a", "b"];
    expect(catalog.listEnabled("prod").map(item => item.agentId)).toEqual(["a", "b"]);
  });
});

describe("the availability monitor sweeps in the background", () => {
  const probeReturning = (answers: Record<string, Signal>): RuntimeProbe => ({
    status: async (agentId) => answers[agentId] ?? unobserved("no answer configured"),
  });

  it("records the last answer per Agent", async () => {
    const monitor = new ProbeAvailabilityMonitor(
      probeReturning({ a: { state: "ok", detail: "answered" }, b: { state: "degraded", detail: "did not answer" } }),
      () => [entry("a"), entry("b")],
    );
    await monitor.sweep();
    expect(monitor.signal("a").state).toBe("ok");
    expect(monitor.signal("b").state).toBe("degraded");
  });

  it("reports an Agent it has not reached yet as unknown, not as available-by-default", () => {
    const monitor = new ProbeAvailabilityMonitor(probeReturning({}), () => []);
    expect(monitor.signal("a").state).toBe("unknown");
    expect(monitor.signal("a").detail).toMatch(/has not been probed/u);
  });

  it("does not let one unreachable pod freeze every other observation", async () => {
    const monitor = new ProbeAvailabilityMonitor(
      { status: async (agentId) => { if (agentId === "a") throw new Error("boom"); return { state: "ok", detail: "answered" }; } },
      () => [entry("a"), entry("b")],
    );
    await monitor.sweep();
    // a probe that THREW observed nothing — recording it as a failure would
    // remove a healthy Agent from routing because of a bug in the prober
    expect(monitor.signal("a").state).toBe("unknown");
    expect(monitor.signal("b").state).toBe("ok");
  });

  it("forgets an Agent that leaves desired state", async () => {
    let entries = [entry("a")];
    const monitor = new ProbeAvailabilityMonitor(probeReturning({ a: { state: "degraded", detail: "down" } }), () => entries);
    await monitor.sweep();
    expect(monitor.signal("a").state).toBe("degraded");
    entries = [];
    await monitor.sweep();
    // a stale "degraded" left behind would silently block the Agent on the day
    // someone adds it back
    expect(monitor.signal("a").state).toBe("unknown");
  });

  it("never keeps the process alive with its timer", () => {
    const unref = vi.fn();
    const spy = vi.spyOn(global, "setInterval").mockReturnValue({ unref } as never);
    try {
      new ProbeAvailabilityMonitor(probeReturning({}), () => []).start();
      expect(unref).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("the lifecycle states an operator reads", () => {
  const base = { agentId: "a", environment: "production", routable: false } as const;
  const ok: Signal = { state: "ok", detail: "ok" };
  const missing: Signal = { state: "degraded", detail: "sync Synced, health Missing" };

  it("separates DRAFT from DISABLED", () => {
    const draft = reconcile({ ...base, lifecycle: "draft", argo: unobserved("n/a"), runtime: unobserved("n/a") });
    const disabled = reconcile({ ...base, lifecycle: "disabled", argo: missing, runtime: missing });
    expect(draft.status).toBe("draft");
    expect(disabled.status).toBe("disabled");
  });

  it("calls a disable RECONCILING until Argo has actually pruned the workload", () => {
    const overlay = { apiVersion: "sre.ai/v1alpha1", kind: "AgentDeployment", agentId: "a", enabled: false } as const;
    // saying DISABLED while the pod is still serving is the one wrong answer
    // that matters in this step
    expect(reconcile({ ...base, lifecycle: "active", overlay, argo: ok, runtime: ok }).status).toBe("reconciling");
    expect(reconcile({ ...base, lifecycle: "active", overlay, argo: missing, runtime: missing }).status).toBe("disabled");
  });

  it("explains a not-routable Agent with the observation that caused it", () => {
    const result = reconcile({
      ...base,
      lifecycle: "active",
      overlay: { apiVersion: "sre.ai/v1alpha1", kind: "AgentDeployment", agentId: "a", enabled: true },
      argo: ok,
      runtime: { state: "degraded", detail: "the pod did not answer /health/ready" },
    });
    expect(result.status).toBe("degraded");
    expect(result.manager.detail).toContain("did not answer");
  });

  it("keeps DRAFT ahead of every actual-state signal", () => {
    // a draft with a stale Application from a previous life must still read as
    // a draft; nothing was turned off and nothing is broken
    expect(foldStatus({ git: ok, argo: missing, runtime: missing, manager: ok, draft: true, disabled: false })).toBe("draft");
  });
});
