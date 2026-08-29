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
const ALLOWED_EXTERNAL = new Set(["@sre/evidence", "ajv", "zod", "node:crypto"]);

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
    expect(Object.keys(manifest.dependencies).sort()).toEqual(["@sre/evidence", "ajv", "zod"]);
  });

  it("names no product, vendor or domain", () => {
    // ToolHive, Keycloak, Prometheus, OpenShift and the PoC's domains were all
    // reachable from engine source before this refactor.
    const forbidden = /toolhive|keycloak|openshift|prometheus|active[-_ ]directory|backstage|argocd|\bsre\b/iu;
    const offenders = sources.filter(({ text }) => forbidden.test(text.replace(/@sre\/evidence/gu, ""))).map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("imports no external protocol SDK, as a client or as a server", () => {
    const forbidden = /^(@modelcontextprotocol|express|fastify|koa|ws|socket\.io|openai|@a2a)/u;
    const offenders = sources.flatMap(({ file, text }) => [...text.matchAll(/from\s+"([^"]+)"/gu)]
      .filter((match) => forbidden.test(match[1] as string))
      .map((match) => `${file}: ${match[1] as string}`));
    expect(offenders).toEqual([]);
  });

  /**
   * TWO protocol-flavoured names survive, and both are stated here rather than
   * quietly tolerated, because "do not hide incomplete decoupling" is a rule:
   *
   *   1. Evidence ids and citations use an `mcp:` / `mcp://` URI scheme.
   *   2. The shared error taxonomy has `MCP_*` codes.
   *
   * Neither is protocol CODE — there is no SDK, no transport and no protocol
   * semantics in the engine, and the import test above proves it. Both are
   * strings in a contract the engine shares with its host, and renaming either
   * would change every evidence id, stored run and evaluation fixture that
   * already depends on them. The cost is real and the benefit is cosmetic, so
   * they stay — confined, and confined by a test.
   */
  it("confines the inherited protocol naming to the contract surface", () => {
    const offenders = sources
      // MCP_* are RuntimeErrorCode members of the shared @sre/evidence taxonomy
      .map(({ file, text }) => ({ file, text: text.replace(/MCP_[A-Z_]+/gu, "") }))
      .filter(({ file, text }) => /mcp/iu.test(text) && !file.endsWith("tools/evidence.ts"))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("keeps src/ to directories and one index.ts", () => {
    const rootEntries = readdirSync(SRC).filter((entry) => !statSync(join(SRC, entry)).isDirectory());
    expect(rootEntries).toEqual(["index.ts"]);
  });
});

describe("the public API is the whole engine and nothing more", () => {
  it("exports the entry point, the ports and the guardrails", () => {
    for (const name of [
      "runAgent", "runLoop",
      "visibleTools", "invokeVisibleTool", "executeTool", "validateToolArguments",
      "authorizeAgent", "authorizeTool", "authorizeAudience", "isReadOnlyTool", "withDeadline",
      "normalizeEvidence", "enforceEvidenceBudget",
      "acquireCredentials", "hashSubject", "noopTelemetry",
      "CONTROL_TOOLS", "parseEnvelope", "isControlTool",
      "accessServers", "audienceFor", "isToolAllowed",
      "errorCode", "isTransient", "engineError", "safeToolMessage",
    ]) {
      expect(engine, `missing export: ${name}`).toHaveProperty(name);
    }
  });

  it("exports no host adapter", () => {
    for (const name of ["MockToolHiveClient", "RealToolHiveClient", "DirectMcpClient", "toolHiveAudience", "mcpEndpointsFromEnv"]) {
      expect(engine).not.toHaveProperty(name);
    }
  });
});
