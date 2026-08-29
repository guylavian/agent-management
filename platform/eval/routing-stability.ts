import { CONFIG_PATHS, deployEnvironmentDir, loadAgentInstance, loadEffectiveAgentCatalog, loadModelProfiles, type ManagerAgentConfig } from "@sre/config";
import { RealOpenAiCompatibleClient } from "@sre/llm";
import { ManagerRouter } from "@sre/orchestrator";

/**
 * ROUTING STABILITY.
 *
 * Routing is a model decision, so "correct" is not a property this file can
 * assert — it can only measure whether the SAME question reaches the SAME
 * specialist twice. That is the thing temperature 0 and a sharper prompt are
 * supposed to buy, and the only honest way to know is to ask repeatedly.
 *
 * This deliberately calls the real provider. A mock would report a stability of
 * 100% and mean nothing.
 *
 *   SRE_LLM_BASE_URL=... SRE_LLM_API_KEY=... SRE_MODEL_MANAGER=... \
 *     npm run eval:routing -- --runs 20
 *
 * The `expect` field is a NOTE, not a gate. A case where the model consistently
 * disagrees with the note is a finding to read, not a test to make pass by
 * adding a rule — the moment routing is corrected by code it stops being
 * semantic, which is the property this whole design is protecting.
 */

interface RoutingCase {
  id: string;
  question: string;
  /** what a domain expert would expect; used for reporting, never for control flow */
  expect: string;
  why: string;
}

const CASES: RoutingCase[] = [
  {
    id: "live-workload-state",
    question: "Are any pods restarting in the sre-assistant namespace?",
    expect: "the Kubernetes/OpenShift workload owner",
    why: "current state of a workload, which its administrator reports directly",
  },
  {
    id: "trend-over-time",
    question: "Have pod restarts increased over the last 6 hours?",
    expect: "the metrics/observability specialist",
    why: "a rate over a window, which only a time-series store can answer",
  },
  {
    id: "causal-cross-domain",
    question: "Why are payments pods restarting?",
    expect: "the workload owner, plus observability if justified",
    why: "causal questions may genuinely span current state and history",
  },
  {
    id: "identity-state",
    question: "Is the Keycloak sre-test realm healthy?",
    expect: "the identity specialist",
    why: "the realm's own administrator holds the authoritative answer",
  },
  {
    id: "no-owner",
    question: "What is the office wifi password?",
    expect: "abstain",
    why: "no specialist owns this; abstaining is the correct answer",
  },
];

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/**
 * A rate limit is a fact about the quota, not about routing.
 *
 * Counting a 429 as "the route changed" would report instability the prompt
 * cannot fix. Back off and ask again; only a decision or a real failure counts.
 */
async function routeOnce(route: () => Promise<string>, attempts: number, backoffMs: number): Promise<{ outcome: string } | { failure: string }> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return { outcome: await route() };
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "UNKNOWN";
      if (code !== "MODEL_RATE_LIMITED" || attempt === attempts - 1) return { failure: code };
      await sleep(backoffMs * (attempt + 1));
    }
  }
  return { failure: "MODEL_RATE_LIMITED" };
}

function arg(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function main(): Promise<void> {
  const runs = arg("runs", 20);
  // paced so the measurement is of routing rather than of a quota
  const delayMs = arg("delay", 1200);
  const backoffMs = arg("backoff", 8000);
  const baseUrl = process.env.SRE_LLM_BASE_URL ?? process.env.SRE_LLM_TIER_S_URL;
  if (baseUrl === undefined) {
    console.error("set SRE_LLM_BASE_URL (and SRE_MODEL_MANAGER) — this harness measures a real provider");
    process.exit(2);
  }
  const environment = process.env.SRE_DEPLOYMENT_ENVIRONMENT ?? "production";
  const registry = loadEffectiveAgentCatalog({ ...CONFIG_PATHS, deploymentEnvironmentDir: deployEnvironmentDir(environment) });
  const manager = loadAgentInstance({ configFile: "config/agents/manager.yaml" }) as ManagerAgentConfig;
  const offered = registry.listEnabled().map((agent) => agent.agentId);

  // the profile's declared temperature reaches the provider exactly as it does
  // in the runtime; measuring with different settings would measure nothing
  const temperatureMap: Record<string, number> = {};
  for (const profile of loadModelProfiles(CONFIG_PATHS.modelProfilesFile).profiles) {
    if (profile.temperature !== undefined) temperatureMap[profile.id] = profile.temperature;
  }
  const model = new RealOpenAiCompatibleClient(baseUrl, {
    ...(process.env.SRE_LLM_API_KEY ? { apiKey: process.env.SRE_LLM_API_KEY } : {}),
    modelMap: { "manager-router": process.env.SRE_MODEL_MANAGER ?? process.env.SRE_LLM_MODEL ?? "manager-router" },
    temperatureMap,
  });

  console.log(`environment ${environment} · offered: ${offered.join(", ")}`);
  console.log(`manager-router temperature: ${temperatureMap["manager-router"] ?? "provider default"}`);
  console.log(`${runs} runs per case\n`);

  let unstable = 0;
  for (const testCase of CASES) {
    const outcomes = new Map<string, number>();
    const failures = new Map<string, number>();
    for (let run = 0; run < runs; run += 1) {
      if (run > 0) await sleep(delayMs);
      const result = await routeOnce(async () => {
        const decision = await new ManagerRouter(model, registry, manager).selectAgents(testCase.question, offered, {});
        return decision.abstain ? "(abstain)" : decision.routes.map((route) => route.agent).sort().join("+");
      }, 4, backoffMs);
      if ("outcome" in result) outcomes.set(result.outcome, (outcomes.get(result.outcome) ?? 0) + 1);
      else failures.set(result.failure, (failures.get(result.failure) ?? 0) + 1);
    }
    const ranked = [...outcomes.entries()].sort((a, b) => b[1] - a[1]);
    const decided = [...outcomes.values()].reduce((total, count) => total + count, 0);
    const top = ranked[0];
    const stability = decided === 0 ? 0 : Math.round(((top?.[1] ?? 0) / decided) * 100);
    if (stability < 100) unstable += 1;

    console.log(`${testCase.id}  —  ${stability}% stable (${decided}/${runs} decided)`);
    console.log(`  q: ${testCase.question}`);
    console.log(`  expected: ${testCase.expect} — ${testCase.why}`);
    for (const [route, count] of ranked) console.log(`    ${String(count).padStart(3)}x  ${route}`);
    for (const [code, count] of failures) console.log(`    ${String(count).padStart(3)}x  FAILED ${code}`);
    console.log("");
  }

  console.log(unstable === 0 ? "every case routed identically on every run" : `${unstable}/${CASES.length} case(s) varied between runs`);
}

await main();
