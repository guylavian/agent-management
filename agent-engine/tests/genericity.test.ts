import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as engine from "../src/index.ts";

/**
 * The engine's genericity is enforced here, not documented.
 *
 * A refactor that reintroduces a platform dependency, a product name or a
 * protocol SDK fails this file rather than being noticed in review — which is
 * the only version of "it stays generic" that survives contact with a deadline.
 */

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
  });
}

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const files = sourceFiles(SRC);
const sources = files.map((file) => ({ file, text: readFileSync(file, "utf8") }));

/** The one neutral contract the engine shares with a host: pure schemas, no implementation. */
const ALLOWED_EXTERNAL = new Set(["@sre/engine-contract", "ajv", "zod", "node:crypto"]);

describe("the engine depends on nothing platform-specific", () => {
  it("imports only the declared neutral dependencies", () => {
    const offenders: string[] = [];
    for (const { file, text } of sources) {
      for (const match of text.matchAll(/from\s+"([^"]+)"/gu)) {
        const specifier = match[1] as string;
        if (specifier.startsWith(".")) continue;
        if (!ALLOWED_EXTERNAL.has(specifier)) offenders.push(`${file}: ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("declares only those dependencies in package.json", () => {
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as { dependencies: Record<string, string> };
    expect(Object.keys(manifest.dependencies).sort()).toEqual(["@sre/engine-contract", "ajv", "zod"]);
  });

  it("names no product, vendor or domain", () => {
    // ToolHive, Keycloak, Prometheus, OpenShift and the PoC's domains were all
    // reachable from engine source before this refactor; "specialist", "wiki"
    // and "mcp" survived one audit longer as inherited contract vocabulary and
    // are forbidden outright since the versioned contract migration.
    //
    // Two `@sre/` specifiers are exempt and neither is domain knowledge: the
    // neutral engine contract, and the engine's own package name. The npm
    // scope is inherited from the repository that first hosted the engine and
    // is a publishing decision, not a dependency — renaming it would touch
    // every consumer for no behavioural gain.
    const forbidden = /toolhive|keycloak|openshift|prometheus|active[-_ ]directory|backstage|argocd|\bsre\b|\bspecialist\b|\bwiki\b|\bmcp\b|mcp_/iu;
    const offenders = sources
      .map(({ file, text }) => ({ file, text: text.replace(/@sre\/(engine-contract|agent-engine)/gu, "") }))
      .filter(({ text }) => forbidden.test(text))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("imports no external protocol SDK, as a client or as a server", () => {
    const forbidden = /^(@modelcontextprotocol|express|fastify|koa|ws|socket\.io|openai|@a2a)/u;
    const offenders = sources.flatMap(({ file, text }) => [...text.matchAll(/from\s+"([^"]+)"/gu)]
      .filter((match) => forbidden.test(match[1] as string))
      .map((match) => `${file}: ${match[1] as string}`));
    expect(offenders).toEqual([]);
  });

  it("keeps src/ to directories and one index.ts", () => {
    const rootEntries = readdirSync(SRC).filter((entry) => !statSync(join(SRC, entry)).isDirectory()).sort();
    // index.ts is the package contract; testing/ is the conformance-test subpath
    expect(rootEntries).toEqual(["index.ts"]);
  });
});

/** Names in an `export { … }` / `export type { … }` clause, ignoring `as` aliases' left side. */
function exportedNames(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const names: string[] = [];
  for (const match of text.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}\s+from/gu)) {
    for (const part of (match[1] as string).split(",")) {
      const name = part.trim().replace(/^type\s+/u, "").split(/\s+as\s+/u).pop()?.trim();
      if (name) names.push(name);
    }
  }
  return [...new Set(names)].sort();
}

/**
 * THE PACKAGE CONTRACT, pinned.
 *
 * This list is the whole host-facing API. It is asserted exactly — not with
 * `toContain` — so that ADDING an export is as deliberate as removing one. A
 * barrel that grows quietly is how an implementation detail becomes a
 * compatibility obligation.
 */
const PUBLIC_API = [
  // entry point
  "runAgent", "AgentRunContext", "EngineDependencies",
  // what an Agent is
  "AgentBudgets", "AgentDefinition", "AgentToolAccess", "AgentWorkload", "Principal", "ToolCredential",
  // Model port
  "Model", "ModelMessage", "ModelRequest", "ModelResponse", "ModelToolCall", "ModelToolSchema",
  // ToolProvider port and the policy that bounds it
  "ApprovedTool", "ListToolsOptions", "ToolCallRequest", "ToolCallResult", "ToolDescriptor", "ToolPolicy", "ToolProvider",
  // Sanitizer port (required) and Telemetry port (optional)
  "Sanitizer", "Telemetry", "SpanAttributes", "noopTelemetry",
  // CredentialProvider port
  "CredentialProvider", "WorkloadRef",
  // results and failures
  "AgentResult", "HandoffRequest", "Evidence", "EvidenceStatus", "EngineError", "EngineErrorCode", "engineError",
].sort();

/** Reachable from `@sre/agent-engine/testing`, and from nowhere else. */
const TESTING_API = [
  "authorizeAgent", "authorizeAudience", "authorizeTool", "AuthorizationDecision",
  "invokeVisibleTool", "visibleTools", "VisibleTool",
].sort();

describe("the public API is a curated contract, not a barrel", () => {
  it("exports exactly the host-facing surface", () => {
    expect(exportedNames(join(SRC, "index.ts"))).toEqual(PUBLIC_API);
  });

  it("keeps the implementation private", () => {
    const surface = new Set([...exportedNames(join(SRC, "index.ts")), ...Object.keys(engine)]);
    for (const internal of [
      // the loop and its result construction
      "runLoop", "answerResult", "insufficientResult", "handoffResult", "failed", "failedWithEvidence", "ResultScope",
      // model-output parsing and the virtual control tools
      "parseEnvelope", "isControlTool", "toStringArray", "CONTROL_TOOLS", "CONTROL_TOOL_NAMES", "AgentAction",
      // tool execution and evidence construction
      "executeTool", "ToolExecutionScope", "toolResultToEvidence", "toolFailureEvidence", "toolProblemEvidence",
      "visibleTools", "invokeVisibleTool", "VisibleTool", "validateToolArguments", "ArgumentValidation",
      // guardrail internals
      "authorizeAgent", "authorizeTool", "authorizeAudience", "AuthorizationDecision", "withDeadline", "isReadOnlyTool",
      // credential exchange
      "acquireCredentials", "exchangeFor", "requireCredentialFor", "workloadRef", "CredentialScope",
      // evidence normalisation and misc helpers
      "normalizeEvidence", "enforceEvidenceBudget", "hashSubject",
      "errorCode", "isTransient", "toolFailureCode", "safeToolMessage",
      "accessServers", "isToolAllowed", "audienceFor",
    ]) {
      expect(surface.has(internal), `internal leaked into the package contract: ${internal}`).toBe(false);
    }
  });

  it("confines the conformance-test surface to the testing subpath", () => {
    expect(exportedNames(join(SRC, "testing", "index.ts"))).toEqual(TESTING_API);
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as { exports: Record<string, string> };
    expect(manifest.exports).toEqual({ ".": "./src/index.ts", "./testing": "./src/testing/index.ts" });
  });

  it("exports no host adapter", () => {
    for (const name of ["MockToolHiveClient", "RealToolHiveClient", "DirectMcpClient", "toolHiveAudience", "mcpEndpointsFromEnv"]) {
      expect(engine).not.toHaveProperty(name);
    }
  });
});
