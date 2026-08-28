import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Enforces the architectural dependency direction the platform depends on.
 *
 * The rule is a DIRECTION, not a naming convention:
 *
 *     management/*  ──►  contracts/*  ◄──  runtime/*
 *                          ▲
 *                       shared/*
 *
 * The management plane may consume the canonical Agent contract, but it must
 * never import runtime code. If it could, the portal would become a second
 * place where authorization is decided, and a portal change could weaken
 * enforcement without touching the runtime. The runtime must likewise never
 * depend on the management plane, so a console outage cannot affect execution.
 *
 * `contracts` depends on nothing, which is what keeps it a contract, and
 * `shared` may rest only on contracts and other shared modules — otherwise the
 * plane boundary would be routable through it.
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
const RUNTIME_PACKAGES = packageNames("runtime/packages");
const MANAGEMENT_PACKAGES = packageNames("management/packages");

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
 * Management SOURCE may reach the contract, never the runtime. Tests are
 * exempt: they legitimately load real agent YAML through the runtime's config
 * loader so the projections are asserted against the same documents the
 * runtime enforces, rather than against fixtures that could drift from it.
 */
check("management/packages", (name, file) =>
  RUNTIME_PACKAGES.has(name) && !file.includes("/tests/")
    ? `management source imports runtime package "@sre/${name}" — the management plane must not depend on execution-plane code`
    : undefined,
);

/**
 * The runtime hosts the read-only management API, so depending on
 * `management-api` is intended. What it must NOT depend on is the Keycloak
 * provisioner: that carries the Admin API client, and coupling request
 * handling to the Admin API is explicitly forbidden (TDD §31). Provisioning is
 * a management/configuration-path concern; runtime token acquisition is a
 * separate one.
 */
check("runtime", (name) =>
  name === "keycloak-provisioning"
    ? `runtime imports "@sre/${name}" — request handling must not be coupled to the Keycloak Admin API (TDD §31)`
    : undefined,
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
  `boundaries ok — ${CONTRACT_PACKAGES.size} contract, ${SHARED_PACKAGES.size} shared, ${RUNTIME_PACKAGES.size} runtime, ${MANAGEMENT_PACKAGES.size} management package(s)`,
);
