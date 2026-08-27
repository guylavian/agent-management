import autocannon from "autocannon";
import { pathToFileURL } from "node:url";
import type { AppConfig } from "@sre/config";
import { MockOidcClient } from "@sre/auth";
import { buildDependencies, createApp } from "../../apps/api/src/app.ts";

export type LoadProfile = "normal" | "burst" | "storm";

export function assertLoadProfileSafe(config: AppConfig, profile: LoadProfile, realApproved = false): void {
  if (profile === "storm" && config.clients.toolhive !== "mock") throw new Error("REFUSED: the 50-user storm profile requires mock ToolHive mode");
  if (profile === "storm" && config.clients.agent !== "mock") throw new Error("REFUSED: the 50-user storm profile requires the mock agent client; a real client would storm deployed specialist services");
  if (config.clients.toolhive === "real" && !realApproved) throw new Error("REFUSED: real ToolHive load requires explicit owner approval");
}

export async function runLoad(profile: LoadProfile, env: Record<string, string | undefined> = process.env): Promise<Record<string, unknown>> {
  const deps = buildDependencies(env);
  if (deps.mode !== "manager") throw new Error("load harness requires manager mode");
  assertLoadProfileSafe(deps.config, profile, env.SRE_LOAD_REAL_APPROVED === "true");
  const profileSettings = { normal: { connections: 5, duration: 10 }, burst: { connections: 20, duration: 15 }, storm: { connections: 50, duration: 20 } }[profile];
  let target = env.SRE_LOAD_URL;
  let close: (() => Promise<void>) | undefined;
  let token = env.SRE_LOAD_TOKEN;
  if (target === undefined) {
    const app = createApp(deps);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    target = address;
    close = () => app.close();
    if (deps.oidc instanceof MockOidcClient) token = await deps.oidc.issueTestToken("alice");
  }
  if (token === undefined) throw new Error("SRE_LOAD_TOKEN is required for an external target");
  try {
    const result = await autocannon({ url: `${target.replace(/\/$/u, "")}/v1/query`, connections: profileSettings.connections, duration: Number(env.SRE_LOAD_DURATION_SECONDS ?? profileSettings.duration), method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ question: "Is AD replication healthy?", environment: "prod" }) });
    return { profile, clientMode: deps.config.clients.toolhive, connections: profileSettings.connections, requests: result.requests, latency: result.latency, errors: result.errors, timeouts: result.timeouts };
  } finally { await close?.(); }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const requested = process.argv[2] ?? "normal";
  if (!(["normal", "burst", "storm"] as string[]).includes(requested)) throw new Error("profile must be normal, burst, or storm");
  process.stdout.write(`${JSON.stringify(await runLoad(requested as LoadProfile), null, 2)}\n`);
}
