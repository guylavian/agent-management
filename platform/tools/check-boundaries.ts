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

// `libs/` nests contracts and shared for organisation only. The zones stay
// distinct: contracts may not reach shared, which is what keeps a contract a
// contract rather than a facade over implementation.
// The engine is a repository-root sibling of the platform, not a child of it:
// it is a generic Specialist engine that the SRE platform USES. The paths differ
// from every other zone for exactly that reason.
const AGENT_ENGINE_DIR = "../agent-engine";
const CONTRACTS_DIR = "contracts";
const SHARED_DIR = "shared";
const CONTRACT_PACKAGES = packageNames(CONTRACTS_DIR);
const SHARED_PACKAGES = packageNames(SHARED_DIR);
const ORCHESTRATOR_DIR = "orchestrator";
const RUNTIME_HOST_DIR = "runtime-host";
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

/** Every bare import specifier in a file (not just `@sre/*`), with its line number. */
function allImports(file: string): Array<{ specifier: string; line: number }> {
  const found: Array<{ specifier: string; line: number }> = [];
  const lines = readFileSync(file, "utf8").split("\n");
  for (const [index, text] of lines.entries()) {
    for (const match of text.matchAll(/from\s+["']([^"'.][^"']*)["']/gu)) {
      found.push({ specifier: match[1] as string, line: index + 1 });
    }
  }
  return found;
}

/** Non-`@sre/*` dependencies a workspace declares. */
function declaredDependencies(manifest: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { dependencies?: Record<string, string> };
    return Object.keys(parsed.dependencies ?? {}).filter((name) => !name.startsWith("@sre/"));
  } catch {
    return [];
  }
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
check(RUNTIME_HOST_DIR, (name: string) =>
  CONTRACT_PACKAGES.has(name) || SHARED_PACKAGES.has(name) || [AGENT_ENGINE, ORCHESTRATOR, RUNTIME_HOST].includes(name)
    ? undefined
    : `runtime-host imports "@sre/${name}" — the composition root may compose only agent-engine, orchestrator, shared and contracts`,
);

// the contract must stay dependency-free so both planes can share it safely
check(CONTRACTS_DIR, (name: string) =>
  CONTRACT_PACKAGES.has(name)
    ? undefined
    : `contract imports "@sre/${name}" — contracts must not depend on either plane`,
);

check(SHARED_DIR, (name: string) =>
  CONTRACT_PACKAGES.has(name) || SHARED_PACKAGES.has(name)
    ? undefined
    : `shared imports "@sre/${name}" — shared may depend only on contracts and shared`,
);

/**
 * The Agent engine is generic. It may rest on CONTRACTS and on nothing else —
 * not on shared, and above all not on the orchestrator, because an engine that
 * could reach routing or fan-out could reach another Agent, and
 * agent-to-agent communication is a red line.
 *
 * Excluding `shared` is the stricter half of this rule and the newer one. The
 * engine used to import @sre/auth, @sre/config, @sre/llm, @sre/redaction and
 * @sre/telemetry — five platform implementations — which meant "generic engine"
 * was true of its behaviour but not of its dependencies. It now declares ports
 * and the composition root adapts this platform onto them. A shared import here
 * would be the first step back.
 */
check(AGENT_ENGINE_DIR, (name: string) =>
  CONTRACT_PACKAGES.has(name) || name === AGENT_ENGINE
    ? undefined
    : `agent-engine imports "@sre/${name}" — the engine may depend only on contracts; adapt the platform onto an engine port in runtime-host instead`,
);

/**
 * The orchestrator dispatches to specialists through the SpecialistTransport
 * contract and must never import the engine that runs one — not even in
 * single-process local mode, where it would be easy and wrong. The in-process
 * adapter therefore lives in the composition root, not here.
 */
check(ORCHESTRATOR_DIR, (name: string) =>
  CONTRACT_PACKAGES.has(name) || SHARED_PACKAGES.has(name) || name === ORCHESTRATOR
    ? undefined
    : `orchestrator imports "@sre/${name}" — the orchestrator may depend only on contracts and shared${name === AGENT_ENGINE ? "; reach specialists through SpecialistTransport instead" : ""}`,
);

/**
 * EXTERNAL PROTOCOL EXPOSURE IS AN ADAPTER CONCERN.
 *
 * OpenAI Responses, A2A, MCP server exposure and enterprise messaging are ways
 * the platform is SPOKEN TO. They belong at the execution boundary, in
 * runtime-host, next to the HTTP app and the transports. Adding, replacing or
 * removing one must not change Agent execution, orchestration, evidence,
 * authorization or tool-execution semantics — and it cannot, if the protocol
 * never reaches the components that decide them.
 *
 * The distinction that matters is CONSUME vs EXPOSE. agent-engine speaks MCP as
 * a CLIENT, because calling a tool through ToolHive is what a specialist does;
 * that is consumption and it is legitimate. Serving MCP — becoming an MCP
 * server other systems call — is exposure, and belongs in the adapter layer.
 * So the rule is written against the SDK's server entrypoints, not the package.
 *
 * The internal Orchestrator→Specialist protocol stays
 * `contracts/agent-protocol::SpecialistTransport`. An external protocol must
 * never become the internal one by default.
 */
const PROTOCOL_SERVER_PACKAGES = new Set([
  // HTTP/websocket servers — the surface an external caller connects to
  "express", "fastify", "koa", "@hapi/hapi", "ws", "socket.io",
  // external agent/model protocol SDKs
  "openai", "@a2aproject/a2a-js", "a2a-js", "@google-a2a/a2a-js",
]);

/** Specifiers that expose a protocol rather than consume one. */
const PROTOCOL_SERVER_SPECIFIERS = ["@modelcontextprotocol/sdk/server"];

/**
 * The engine is held to the stricter rule: it speaks NO external protocol at
 * all, in either direction. It used to consume MCP as a client, which was
 * legitimate but concrete — it meant the engine knew that "a tool" is an MCP
 * tool behind a gateway. Tool access is now a port, and the client that speaks
 * MCP is an adapter in runtime-host, so the engine has no protocol left to
 * consume and must not reacquire one.
 */
const ENGINE_FORBIDDEN_PACKAGES = new Set([...PROTOCOL_SERVER_PACKAGES, "@modelcontextprotocol/sdk", "@opentelemetry/api", "jose", "pg"]);

for (const dependency of declaredDependencies(join(AGENT_ENGINE_DIR, "package.json"))) {
  if (ENGINE_FORBIDDEN_PACKAGES.has(dependency)) {
    violations.push({
      file: join(AGENT_ENGINE_DIR, "package.json"),
      line: 1,
      detail: `agent-engine declares "${dependency}" — the engine speaks no protocol and reaches no infrastructure; put the adapter in runtime-host`,
    });
  }
}
for (const file of sourceFiles(AGENT_ENGINE_DIR)) {
  for (const { specifier, line } of allImports(file)) {
    const root = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : (specifier.split("/")[0] as string);
    if (ENGINE_FORBIDDEN_PACKAGES.has(root)) {
      violations.push({ file, line, detail: `agent-engine imports "${specifier}" — the engine speaks no protocol and reaches no infrastructure` });
    }
  }
}

for (const zone of [AGENT_ENGINE_DIR, ORCHESTRATOR_DIR]) {
  for (const dependency of declaredDependencies(join(zone, "package.json"))) {
    if (PROTOCOL_SERVER_PACKAGES.has(dependency)) {
      violations.push({
        file: join(zone, "package.json"),
        line: 1,
        detail: `${zone} declares "${dependency}" — external protocol exposure is an adapter concern and belongs in runtime-host`,
      });
    }
  }
  for (const file of sourceFiles(zone)) {
    for (const { specifier, line } of allImports(file)) {
      const exposure = PROTOCOL_SERVER_SPECIFIERS.find((prefix) => specifier.startsWith(prefix));
      if (exposure !== undefined) {
        violations.push({
          file,
          line,
          detail: `${zone} imports "${specifier}" — consuming a protocol is fine here, SERVING one is an adapter concern for runtime-host`,
        });
      }
    }
  }
}

if (violations.length > 0) {
  console.error("boundary violations:\n");
  for (const violation of violations) console.error(`  ${violation.file}:${violation.line}\n    ${violation.detail}`);
  process.exit(1);
}

console.log(
  `boundaries ok — ${CONTRACT_PACKAGES.size} contract, ${SHARED_PACKAGES.size} shared, 3 code components, external protocols confined to the adapter layer`,
);
