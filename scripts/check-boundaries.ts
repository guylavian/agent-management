import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Enforces the architectural dependency graph.
 *
 *     runtime-host ──► agent-engine ──┐
 *          │      └──► orchestrator ──┤
 *          └───────────────────────►  shared ──► contracts ──► (nothing)
 *
 * The two rules that matter most are the two that are missing from that
 * picture: agent-engine ✕→ orchestrator and orchestrator ✕→ agent-engine.
 * A specialist that could reach routing could reach another specialist, and an
 * orchestrator that could reach the engine would collapse the transport
 * boundary the moment someone ran both in one process — which local dev does
 * every day. Only the composition root sees both sides.
 *
 * Zones are resolved from each workspace's package NAME, not from its directory
 * name, because the two deliberately differ (shared/config-loader publishes
 * @sre/config).
 */

interface Violation {
  file: string;
  line: number;
  detail: string;
}

/** Package names published from a zone root, e.g. shared/ -> {"auth", "config", ...}. */
function packageNames(zone: string): Set<string> {
  const names = new Set<string>();
  for (const entry of readdirSync(zone)) {
    try {
      const parsed = JSON.parse(readFileSync(join(zone, entry, "package.json"), "utf8")) as { name?: string };
      if (parsed.name?.startsWith("@sre/")) names.add(parsed.name.slice("@sre/".length));
    } catch {
      // not a workspace directory
    }
  }
  return names;
}

const CONTRACT_PACKAGES = packageNames("contracts");
const SHARED_PACKAGES = packageNames("shared");
const AGENT_ENGINE = "agent-engine";
const ORCHESTRATOR = "orchestrator";
const RUNTIME_HOST = "runtime-host";

const violations: Violation[] = [];

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* sourceFiles(path);
    else if (path.endsWith(".ts") || path.endsWith(".tsx")) yield path;
  }
}

/** Every `@sre/<name>` specifier in a file, with its line number. */
function imports(file: string): Array<{ name: string; line: number }> {
  const found: Array<{ name: string; line: number }> = [];
  const lines = readFileSync(file, "utf8").split("\n");
  for (const [index, text] of lines.entries()) {
    for (const match of text.matchAll(/["']@sre\/([a-z0-9-]+)["']/gu)) {
      found.push({ name: match[1] as string, line: index + 1 });
    }
  }
  return found;
}

function check(dir: string, rule: (name: string, file: string) => string | undefined): void {
  for (const file of sourceFiles(dir)) {
    for (const { name, line } of imports(file)) {
      const problem = rule(name, file);
      if (problem !== undefined) violations.push({ file, line, detail: problem });
    }
  }
}

/**
 * The composition root may see everything below it — that is its job — but not
 * the Keycloak provisioner: that carries the Admin API client, and coupling
 * request handling to the Admin API is explicitly forbidden (TDD §31).
 * Provisioning is a configuration-path concern; runtime token acquisition is a
 * separate one.
 */
check("runtime-host", (name: string) =>
  CONTRACT_PACKAGES.has(name) || SHARED_PACKAGES.has(name) || [AGENT_ENGINE, ORCHESTRATOR, RUNTIME_HOST].includes(name)
    ? undefined
    : `runtime-host imports "@sre/${name}" — the composition root may compose only agent-engine, orchestrator, shared and contracts`,
);

// the contract must stay dependency-free so both planes can share it safely
check("contracts", (name: string) =>
  CONTRACT_PACKAGES.has(name)
    ? undefined
    : `contract imports "@sre/${name}" — contracts must not depend on either plane`,
);

check("shared", (name: string) =>
  CONTRACT_PACKAGES.has(name) || SHARED_PACKAGES.has(name)
    ? undefined
    : `shared imports "@sre/${name}" — shared may depend only on contracts and shared`,
);

/**
 * The Specialist engine is generic. It may rest on contracts and shared and on
 * nothing else — in particular not on the orchestrator, because a specialist
 * that could reach routing or fan-out could reach another specialist, and
 * specialist-to-specialist communication is a red line.
 */
check("agent-engine", (name: string) =>
  CONTRACT_PACKAGES.has(name) || SHARED_PACKAGES.has(name) || name === AGENT_ENGINE
    ? undefined
    : `agent-engine imports "@sre/${name}" — the engine may depend only on contracts and shared`,
);

/**
 * The orchestrator dispatches to specialists through the SpecialistTransport
 * contract and must never import the engine that runs one — not even in
 * single-process local mode, where it would be easy and wrong. The in-process
 * adapter therefore lives in the composition root, not here.
 */
check("orchestrator", (name: string) =>
  CONTRACT_PACKAGES.has(name) || SHARED_PACKAGES.has(name) || name === ORCHESTRATOR
    ? undefined
    : `orchestrator imports "@sre/${name}" — the orchestrator may depend only on contracts and shared${name === AGENT_ENGINE ? "; reach specialists through SpecialistTransport instead" : ""}`,
);

if (violations.length > 0) {
  console.error("boundary violations:\n");
  for (const violation of violations) console.error(`  ${violation.file}:${violation.line}\n    ${violation.detail}`);
  process.exit(1);
}

console.log(
  `boundaries ok — ${CONTRACT_PACKAGES.size} contract, ${SHARED_PACKAGES.size} shared, 3 code components`,
);
