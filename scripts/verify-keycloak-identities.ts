import { CONFIG_PATHS, loadAgentRegistry } from "@sre/config";
import { HttpKeycloakAdmin, desiredClientFor, desiredClientsFor, reconcileClient } from "@sre/keycloak-provisioning";

/**
 * Verifies the per-Agent workload identity model against a REAL Keycloak.
 *
 * The unit tests reconcile against an in-memory realm; this asserts the same
 * properties where they actually matter — that Keycloak itself mints
 * single-audience tokens, refuses another Agent's audience scope, and stops
 * issuing tokens for a disabled Agent.
 *
 *   KEYCLOAK_URL, KEYCLOAK_REALM, KEYCLOAK_ADMIN, KEYCLOAK_ADMIN_PASSWORD
 *   npm run verify:keycloak
 *
 * It is a script, not a test: it needs live infrastructure, and a suite that
 * silently skips when infrastructure is missing is how "PASS" starts meaning
 * "not run". A missing Keycloak here is a non-zero exit, not a skip.
 *
 * Reads client secrets from the Admin API to exercise the flows and never
 * prints, logs or persists one.
 */

const baseUrl = (process.env.KEYCLOAK_URL ?? "").replace(/\/$/u, "");
const realm = process.env.KEYCLOAK_REALM ?? "sre-test";
const adminRealm = process.env.KEYCLOAK_ADMIN_REALM ?? "master";
const username = process.env.KEYCLOAK_ADMIN ?? "";
const password = process.env.KEYCLOAK_ADMIN_PASSWORD ?? "";
if (!baseUrl || !username || !password) {
  console.error("KEYCLOAK_URL, KEYCLOAK_ADMIN and KEYCLOAK_ADMIN_PASSWORD are required");
  process.exit(1);
}

const results: Array<{ name: string; state: "PASS" | "FAIL"; detail: string }> = [];
function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, state: ok ? "PASS" : "FAIL", detail });
}

async function adminToken(): Promise<string> {
  const response = await fetch(`${baseUrl}/realms/${adminRealm}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "password", client_id: "admin-cli", username, password }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Keycloak admin authentication failed (${response.status})`);
  return ((await response.json()) as { access_token: string }).access_token;
}

async function adminGet<T>(path: string): Promise<T> {
  const response = await fetch(`${baseUrl}/admin/realms/${realm}${path}`, {
    headers: { authorization: `Bearer ${await adminToken()}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`GET ${path} failed (${response.status})`);
  return (await response.json()) as T;
}

/** Client-credentials token for a workload, optionally asking for one MCP scope. */
async function workloadToken(clientId: string, secret: string, scope?: string): Promise<{ ok: boolean; claims?: Record<string, unknown>; error?: string }> {
  const body = new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: secret });
  if (scope) body.set("scope", scope);
  const response = await fetch(`${baseUrl}/realms/${realm}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  const payload = (await response.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!payload.access_token) return { ok: false, error: payload.error_description ?? payload.error ?? String(response.status) };
  const segment = payload.access_token.split(".")[1] as string;
  return { ok: true, claims: JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown> };
}

const registry = loadAgentRegistry(CONFIG_PATHS);
const specialists = registry.listSpecialists();
const desired = desiredClientsFor(specialists);

// ---- every Agent has its own identity, and no two share one ------------------
const actual = await adminGet<Array<{ clientId: string; enabled: boolean; serviceAccountsEnabled?: boolean; publicClient?: boolean; standardFlowEnabled?: boolean }>>("/clients");
const provisioned = actual.filter((client) => client.clientId.startsWith("sre-agent-"));
record(
  "one dedicated workload client per Agent",
  desired.every((client) => provisioned.some((existing) => existing.clientId === client.clientId)) && new Set(provisioned.map((c) => c.clientId)).size === provisioned.length,
  `${provisioned.length} distinct clients for ${desired.length} agents`,
);
record(
  "no interactive or public flow on any workload client",
  provisioned.every((client) => client.serviceAccountsEnabled === true && client.publicClient === false && client.standardFlowEnabled === false),
  "service-account only, confidential, no standard flow",
);

// ---- audience isolation, proven by Keycloak rather than asserted -------------
const probe = specialists.find((agent) => agent.name === "keycloak");
if (probe === undefined) throw new Error("expected a keycloak specialist to probe with");
const probeId = probe.spec.identity.clientId;
const uuid = (await adminGet<Array<{ id: string }>>(`/clients?clientId=${encodeURIComponent(probeId)}`))[0]?.id;
if (uuid === undefined) throw new Error(`${probeId} is not provisioned; run npm run reconcile:keycloak -- --apply`);
const secret = (await adminGet<{ value: string }>(`/clients/${uuid}/client-secret`)).value;

const scoped = await workloadToken(probeId, secret, "sre-toolhive-keycloak");
const audiences = ([] as string[]).concat((scoped.claims?.aud as string | string[] | undefined) ?? []);
record(
  "a scoped token carries exactly one ToolHive audience",
  scoped.ok && audiences.includes("sre-toolhive:keycloak") && audiences.filter((aud) => aud.startsWith("sre-toolhive:")).length === 1,
  `aud=${JSON.stringify(audiences)}`,
);
record(
  "the workload is identifiable as the actor",
  scoped.claims?.azp === probeId,
  `azp=${String(scoped.claims?.azp)} — this is the claim the ToolHive Cedar policy authorizes on`,
);

const unscoped = await workloadToken(probeId, secret);
const unscopedAud = ([] as string[]).concat((unscoped.claims?.aud as string | string[] | undefined) ?? []);
record(
  "no ToolHive audience is granted without asking for the scope",
  unscoped.ok && unscopedAud.every((aud) => !aud.startsWith("sre-toolhive:")),
  `aud=${JSON.stringify(unscopedAud)}`,
);

const foreign = await workloadToken(probeId, secret, "sre-toolhive-network");
record(
  "another Agent's MCP audience is refused",
  !foreign.ok,
  foreign.ok ? `GRANTED aud=${JSON.stringify(foreign.claims?.aud)}` : `denied: ${foreign.error}`,
);

// ---- disabling an Agent stops token issuance, without destroying audit -------
const admin = new HttpKeycloakAdmin({ baseUrl, realm, accessToken: adminToken });
const disabled = desiredClientFor({ ...probe, spec: { ...probe.spec, lifecycle: "disabled" } });
await reconcileClient(admin, disabled);
const afterDisable = await workloadToken(probeId, secret, "sre-toolhive-keycloak");
const stillExists = (await adminGet<Array<{ clientId: string; enabled: boolean }>>(`/clients?clientId=${encodeURIComponent(probeId)}`))[0];
record(
  "a disabled Agent can no longer obtain a workload token",
  !afterDisable.ok,
  afterDisable.ok ? "STILL ISSUED — the disable did not take effect" : `denied: ${afterDisable.error}`,
);
record(
  "the disabled identity is retained, not deleted",
  stillExists !== undefined && stillExists.enabled === false,
  "the client remains so its audit history stays attributable",
);

// restore the probe to the state the canonical config declares
await reconcileClient(admin, desiredClientFor(probe));
const restored = await workloadToken(probeId, secret, "sre-toolhive-keycloak");
record("re-enabling restores token issuance", restored.ok, restored.ok ? "token issued again" : `still denied: ${restored.error}`);

const failures = results.filter((result) => result.state === "FAIL");
for (const result of results) console.log(`${result.state === "PASS" ? "PASS" : "FAIL"}  ${result.name}\n      ${result.detail}`);
console.log(`\n${results.length - failures.length} PASS, ${failures.length} FAIL`);
if (failures.length > 0) process.exit(1);
