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

const ZONES = ["agent-engine", "orchestrator", "runtime-host", "contracts", "shared"] as const;

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
    const offenders = internalImports("agent-engine").filter((entry) => entry.name === "orchestrator");
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

  it("check-boundaries agrees", () => {
    const output = execFileSync("node", ["--import", "tsx", "scripts/check-boundaries.ts"], { encoding: "utf8" });
    expect(output).toContain("boundaries ok");
  });
});
