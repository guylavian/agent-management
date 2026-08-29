import { describe, expect, it } from "vitest";
import { context, trace, type Attributes, type Span } from "@opentelemetry/api";
import { MockToolCredentialAuthority } from "@sre/auth";
import { CONFIG_PATHS, loadAgentRegistry } from "@sre/config";
import { MockModelClient } from "@sre/llm";
import { MockToolHiveClient } from "@sre/runtime-host";
import { classifyIntent } from "@sre/orchestrator";
import { runSpecialistInstance } from "@sre/runtime-host";
import type { ExecutionContext } from "@sre/orchestrator";

/**
 * TDD §44: the run must produce the required span tree, and no span may carry
 * token contents. Rather than assert on an exporter, this installs a recording
 * tracer provider so the assertions are about what the code actually emits.
 */
interface Recorded { name: string; attributes: Attributes }

function recordingTracer(): { recorded: Recorded[]; restore: () => void } {
  const recorded: Recorded[] = [];
  const original = trace.getTracer;
  // minimal span stub: withSpan only uses setStatus/recordException/end
  const span = {
    setStatus: () => span,
    recordException: () => {},
    end: () => {},
    spanContext: () => ({ traceId: "0".repeat(32), spanId: "0".repeat(16), traceFlags: 1 }),
    setAttribute: () => span,
    setAttributes: () => span,
    addEvent: () => span,
    updateName: () => span,
    isRecording: () => true,
    addLink: () => span,
    addLinks: () => span,
  } as unknown as Span;
  (trace as { getTracer: typeof trace.getTracer }).getTracer = () => ({
    startActiveSpan: ((name: string, optionsOrFn: unknown, maybeFn?: unknown) => {
      const options = typeof optionsOrFn === "function" ? {} : (optionsOrFn as { attributes?: Attributes });
      const fn = (typeof optionsOrFn === "function" ? optionsOrFn : maybeFn) as (s: Span) => unknown;
      recorded.push({ name, attributes: options.attributes ?? {} });
      return context.with(context.active(), () => fn(span));
    }) as never,
    startSpan: (() => span) as never,
  });
  return { recorded, restore: () => { (trace as { getTracer: typeof trace.getTracer }).getTracer = original; } };
}

const registry = loadAgentRegistry(CONFIG_PATHS);

async function runOnce(): Promise<Recorded[]> {
  const { recorded, restore } = recordingTracer();
  try {
    const agent = registry.getSpecialist("keycloak")!;
    const identity = { subject: "alice", groups: ["identity-platform"], roles: ["infra-read"], requestId: "req-span-1" };
    const authority = new MockToolCredentialAuthority({ issuer: "https://mock-toolhive-sts.sre.local", secret: "span-test-shared-secret-at-least-32b" });
    // the orchestrator's context is deliberately NOT the engine's: the host
    // projects the former onto the latter, exactly as the transports do
    const ctx: ExecutionContext = {
      request: { question: "which clients exist in the sre-test realm?", identity },
      identity,
      environment: "prod",
      intent: classifyIntent("which clients exist in the sre-test realm?", []),
      requestId: identity.requestId,
      deadline: Date.now() + 20_000,
    };
    await runSpecialistInstance(agent, registry.catalog, {
      question: ctx.request.question,
      principal: identity,
      environment: ctx.environment,
      requestId: ctx.requestId,
      deadline: ctx.deadline,
    }, {
      model: new MockModelClient(),
      toolhive: new MockToolHiveClient(authority),
      credentialExchanger: authority,
    });
    return recorded;
  } finally {
    restore();
  }
}

describe("execution telemetry", () => {
  it("emits the required security spans for a specialist run", async () => {
    const names = (await runOnce()).map((span) => span.name);
    expect(names).toContain("agent.keycloak.execute");
    expect(names).toContain("authorization.check");
    expect(names.some((name) => name.startsWith("llm.specialist."))).toBe(true);
    expect(names.some((name) => name.startsWith("workload.token"))).toBe(true);
    expect(names.some((name) => name.startsWith("toolhive.call."))).toBe(true);
  });

  it("names the workload and audience on the token span without recording the token", async () => {
    const recorded = await runOnce();
    const tokenSpan = recorded.find((span) => span.name === "workload.token");
    expect(tokenSpan?.attributes["workload.client_id"]).toBe("sre-agent-keycloak");
    expect(String(tokenSpan?.attributes["token.audience"])).toMatch(/^sre-toolhive:/u);
    expect(Object.keys(tokenSpan?.attributes ?? {})).not.toContain("token");
  });

  it("never puts token contents, secrets or a raw subject in any span attribute", async () => {
    const serialized = JSON.stringify(await runOnce());
    expect(serialized).not.toMatch(/eyJ[A-Za-z0-9_-]{8,}/u); // a JWT
    expect(serialized).not.toMatch(/secret|password|private[_-]?key/iu);
    // the human is carried as a hash, never as the raw subject
    expect(serialized).not.toMatch(/"alice"/u);
  });

  it("hashes the human subject on the agent execution span", async () => {
    const recorded = await runOnce();
    const executeSpan = recorded.find((span) => span.name === "agent.keycloak.execute");
    expect(String(executeSpan?.attributes["user.subject_hash"])).toMatch(/^[a-f0-9]{64}$/u);
  });
});
