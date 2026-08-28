import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Enforces the plane boundary that the architecture depends on.
 *
 * The rule is a dependency DIRECTION, not a naming convention:
 *
 *     management/*  ──►  contracts/*  ◄──  runtime/*
 *
 * The management plane may consume the canonical Agent contract, but it must
 * never import runtime code. If it could, the portal would become a second
 * place where authorization is decided, and a portal change could weaken
 * enforcement without touching the runtime. The runtime must likewise never
 * depend on the management plane, so a console outage cannot affect execution.
 *
 * `contracts` depends on nothing, which is what keeps it a contract.
 */

interface Violation {
  file: string;
  line: number;
  detail: string;
}

const RUNTIME_PACKAGES = new Set(readdirSync("runtime/packages"));
const MANAGEMENT_PACKAGES = new Set(readdirSync("management/packages"));
const CONTRACT_PACKAGES = new Set(readdirSync("contracts"));

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

if (violations.length > 0) {
  console.error("plane boundary violations:\n");
  for (const violation of violations) console.error(`  ${violation.file}:${violation.line}\n    ${violation.detail}`);
  process.exit(1);
}

console.log(
  `plane boundaries ok — ${CONTRACT_PACKAGES.size} contract, ${RUNTIME_PACKAGES.size} runtime, ${MANAGEMENT_PACKAGES.size} management package(s)`,
);
