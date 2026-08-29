import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The architectural dependency graph, asserted mechanically.
 *
 *     runtime-host ──► agent-engine ──┐
 *          │      └──► orchestrator ──┤
 *          └───────────────────────►  shared ──► contracts ──► (nothing)
 *
 * `npm run validate:boundaries` enforces this in CI; these tests exist so the
 * rule is also visible where the rest of the invariants live, and so the two
 * most important edges — the two that must NOT exist — are named explicitly
 * rather than implied by the absence of a violation.
 */

const ZONES = ["../agent-engine", "orchestrator", "runtime-host", "contracts", "shared"] as const;

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* sourceFiles(path);
    else if (path.endsWith(".ts") || path.endsWith(".tsx")) yield path;
  }
}

/** Internal `@sre/*` specifiers imported anywhere under a directory, with their file. */
function internalImports(dir: string): Array<{ file: string; name: string }> {
  const found: Array<{ file: string; name: string }> = [];
  for (const file of sourceFiles(dir)) {
    for (const match of readFileSync(file, "utf8").matchAll(/["']@sre\/([a-z0-9-]+)["']/gu)) {
      found.push({ file, name: match[1] as string });
    }
  }
  return found;
}

/** Every bare import specifier under a directory, internal or external. */
function internalOrExternalImports(dir: string): string[] {
  const found: string[] = [];
  for (const file of sourceFiles(dir)) {
    for (const match of readFileSync(file, "utf8").matchAll(/from\s+["']([^"'.][^"']*)["']/gu)) {
      found.push(match[1] as string);
    }
  }
  return found;
}

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

const CONTRACTS = packageNames("contracts");
const SHARED = packageNames("shared");

describe("architectural boundaries", () => {
  /**
   * A specialist that could reach routing or fan-out could reach another
   * specialist, and specialist-to-specialist communication is a red line.
   */
  it("agent-engine imports orchestrator ZERO times", () => {
    const offenders = internalImports("../agent-engine").filter((entry) => entry.name === "orchestrator");
    expect(offenders).toEqual([]);
  });

  /**
   * The edge that is easy to add and wrong: in single-process local mode the
   * orchestrator could just call the engine. It must not — the in-process
   * adapter belongs to the composition root, behind SpecialistTransport.
   */
  it("orchestrator imports agent-engine ZERO times", () => {
    const offenders = internalImports("orchestrator").filter((entry) => entry.name === "agent-engine");
    expect(offenders).toEqual([]);
  });

  it("contracts import no internal implementation", () => {
    const offenders = internalImports("contracts").filter((entry) => !CONTRACTS.has(entry.name));
    expect(offenders).toEqual([]);
  });

  it("shared rests only on contracts and shared", () => {
    const offenders = internalImports("shared").filter((entry) => !CONTRACTS.has(entry.name) && !SHARED.has(entry.name));
    expect(offenders).toEqual([]);
  });

  it("only runtime-host composes both engines", () => {
    const composers = ZONES.filter((zone) => {
      const names = new Set(internalImports(zone).map((entry) => entry.name));
      return names.has("agent-engine") && names.has("orchestrator");
    });
    expect(composers).toEqual(["runtime-host"]);
  });

  /**
   * The orchestrator reaches specialists only through the protocol contract, so
   * it cannot tell an HTTP specialist from an in-process one.
   */
  it("orchestrator dispatch depends only on the transport contract", () => {
    const names = new Set(internalImports("orchestrator/src/dispatch").map((entry) => entry.name));
    expect([...names]).toEqual(["agent-protocol"]);
  });

  it("both transports live in the composition root and implement one contract", () => {
    const http = readFileSync("runtime-host/src/transport/http.ts", "utf8");
    const inProcess = readFileSync("runtime-host/src/transport/in-process.ts", "utf8");
    expect(http).toContain("implements SpecialistTransport");
    expect(inProcess).toContain("implements SpecialistTransport");
    // only the in-process adapter may touch the engine, and only from here
    expect(inProcess).toContain("@sre/agent-engine");
    expect(http).not.toContain("@sre/agent-engine");
  });

  /**
   * External protocol exposure — OpenAI Responses, A2A, MCP server exposure,
   * enterprise messaging — is an ADAPTER concern that belongs at the execution
   * boundary in runtime-host. Adding or removing one must not change Agent,
   * orchestration, evidence, authorization or tool-execution semantics, and it
   * cannot if the protocol never reaches the components that decide them.
   */
  it("keeps external protocol surfaces out of the engines", () => {
    const servers = ["express", "fastify", "koa", "@hapi/hapi", "ws", "socket.io", "openai", "a2a-js"];
    for (const zone of ["../agent-engine", "orchestrator"]) {
      const declared = Object.keys((JSON.parse(readFileSync(`${zone}/package.json`, "utf8")) as { dependencies?: Record<string, string> }).dependencies ?? {});
      expect(declared.filter((name) => servers.includes(name)), zone).toEqual([]);
    }
    // ...and runtime-host is where the one we do speak actually lives
    const host = Object.keys((JSON.parse(readFileSync("runtime-host/package.json", "utf8")) as { dependencies?: Record<string, string> }).dependencies ?? {});
    expect(host).toContain("express");
  });

  /**
   * CONSUME vs EXPOSE still decides where an MCP client may live — but the
   * engine is now on the far side of BOTH. It used to consume MCP as a client,
   * which was legitimate; tool access is now a port, so the client that speaks
   * MCP is an adapter in runtime-host and the engine speaks no protocol at all.
   */
  it("keeps every MCP client in the adapter layer and every MCP server out of the platform", () => {
    for (const zone of ["../agent-engine", "orchestrator"]) {
      expect(internalOrExternalImports(zone).filter((specifier) => specifier.startsWith("@modelcontextprotocol")), zone).toEqual([]);
    }
    const host = internalOrExternalImports("runtime-host");
    expect(host.some((specifier) => specifier.startsWith("@modelcontextprotocol/sdk/client"))).toBe(true);
    expect(host.filter((specifier) => specifier.startsWith("@modelcontextprotocol/sdk/server"))).toEqual([]);
  });

  /**
   * The engine's dependency list IS its genericity claim. Five platform
   * implementations used to be in it.
   */
  it("leaves the engine depending on one neutral contract and two libraries", () => {
    const declared = Object.keys((JSON.parse(readFileSync("../agent-engine/package.json", "utf8")) as { dependencies?: Record<string, string> }).dependencies ?? {});
    expect(declared.sort()).toEqual(["@sre/evidence", "ajv", "zod"]);
  });

  /**
   * The engine's package contract is a curated list, not a barrel. Two internals
   * are reachable from `@sre/agent-engine/testing` so the platform can prove
   * authorization parity and tool visibility against its REAL catalog — claims
   * the engine cannot make about a host it is forbidden to import. Production
   * code must use the contract.
   */
  it("keeps the engine's test-only subpath out of production code", () => {
    const productionImports = (zone: string): string[] => [...sourceFiles(zone)]
      .filter((file) => !/\.test\.tsx?$/u.test(file) && !file.includes("/tests/"))
      .flatMap((file) => [...readFileSync(file, "utf8").matchAll(/from\s+"([^"]+)"/gu)].map((match) => match[1] as string));
    for (const zone of ["../agent-engine/src", "runtime-host", "orchestrator", "shared", "contracts", "eval"]) {
      expect(productionImports(zone).filter((specifier) => specifier === "@sre/agent-engine/testing"), zone).toEqual([]);
    }
    // ...and the conformance tests that legitimately use it still do
    const consumers = ["tests/architecture-gate.test.ts", "tests/security-regression.test.ts"];
    for (const file of consumers) {
      expect(readFileSync(file, "utf8"), file).toContain("@sre/agent-engine/testing");
    }
  });

  it("check-boundaries agrees", () => {
    const output = execFileSync("node", ["--import", "tsx", "tools/check-boundaries.ts"], { encoding: "utf8" });
    expect(output).toContain("boundaries ok");
  });
});
