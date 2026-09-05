import { createServer } from "node:http";
import { loadAppConfig } from "@sre/config";
import { PostgresActivationStore, PostgresAttestationStore } from "@sre/orchestrator";
import { initializeTelemetry, shutdownTelemetry } from "@sre/telemetry";
import { configPaths } from "./bootstrap/dependencies.ts";
import { desiredStateSource } from "./bootstrap/desired-state.ts";
import { AgentReconciler, type AttestationStores } from "./bootstrap/reconciler.ts";
import { HttpRuntimeProbe } from "./management/reconciliation.ts";
import { GatewayToolAccessVerifier, KeycloakIdentityVerifier } from "./bootstrap/verifiers.ts";

/**
 * THE OPERATIONAL-PLANE RECONCILER, as a process.
 *
 * It is deliberately NOT the runtime. The runtime only ever READS the
 * operational plane — it holds no credential that can activate an Agent or
 * write an attestation — so the thing that writes them has to be somewhere
 * else, with its own identities. That separation is the whole point of the
 * four database roles below; putting this loop inside the Manager would hand
 * the request path the power to bless itself.
 *
 * It serves one endpoint, `/health/ready`, and it reports ready only once a
 * round has actually completed. A reconciler that starts but never converges
 * would otherwise look healthy while the estate ages out of the catalog
 * beneath it.
 */

const config = loadAppConfig(process.env);
const reconciliation = config.reconciliation;

function required(value: string | undefined, name: string): string {
  // fail closed and by name: a reconciler missing one credential would write
  // two thirds of a proof, and two thirds never routes
  if (value === undefined || value.length === 0) throw new Error(`the reconciler requires ${name}`);
  return value;
}

const activation = new PostgresActivationStore(required(reconciliation.activationUrl, "SRE_ACTIVATION_POSTGRES_URL"));
const attestation: AttestationStores = {
  runtime: new PostgresAttestationStore(required(reconciliation.attestRuntimeUrl, "SRE_ATTEST_RUNTIME_POSTGRES_URL")),
  identity: new PostgresAttestationStore(required(reconciliation.attestIdentityUrl, "SRE_ATTEST_IDENTITY_POSTGRES_URL")),
  tool_access: new PostgresAttestationStore(required(reconciliation.attestToolAccessUrl, "SRE_ATTEST_TOOL_ACCESS_POSTGRES_URL")),
};

const desiredState = desiredStateSource({ ...configPaths(config), deploymentEnvironmentDir: config.deploymentEnvironmentDir });
const snapshot = desiredState.current();

/*
 * An unconfigured verifier reports NOT ready rather than being skipped, so a
 * half-wired reconciler withholds routing instead of granting it. Constructing
 * them here — rather than letting the reconciler default — means the operator
 * sees the missing credential at startup, in the log, not as a fleet of
 * Agents that quietly never became routable.
 */
const identity = config.keycloakAdmin.url === undefined
  ? undefined
  : new KeycloakIdentityVerifier({
    adminUrl: config.keycloakAdmin.url,
    realm: config.keycloakAdmin.realm,
    adminRealm: "master",
    clientId: required(config.keycloakAdmin.clientId, "SRE_KEYCLOAK_ADMIN_CLIENT_ID"),
    clientSecret: () => required(config.keycloakAdmin.clientSecret, "SRE_KEYCLOAK_ADMIN_CLIENT_SECRET"),
  });

const toolAccess = new GatewayToolAccessVerifier({
  catalog: snapshot.registry.catalog,
  endpoints: new Map(Object.entries(config.toolhive.endpoints ?? {})),
});

await initializeTelemetry({
  exporter: config.telemetry.exporter,
  ...(config.telemetry.otlpEndpoint ? { endpoint: config.telemetry.otlpEndpoint } : {}),
  serviceName: "sre-agent-reconciler",
});

const reconciler = new AgentReconciler({
  desiredState,
  environment: snapshot.environment,
  activation,
  attestation,
  runtimeProbe: new HttpRuntimeProbe(),
  ...(identity ? { identity } : {}),
  toolAccess,
});

let lastRound: { at: number; ok: boolean; detail: string } | undefined;

// the first round runs before the server answers, so "ready" is never claimed
// on the strength of having merely started
const first = await reconciler.reconcile().then(
  (report) => ({ at: Date.now(), ok: report.skipped === undefined, detail: report.skipped ?? `activated ${report.activated.length}, attested ${report.attested.length}` }),
  (error: unknown) => ({ at: Date.now(), ok: false, detail: error instanceof Error ? error.message : String(error) }),
);
lastRound = first;
console.log(JSON.stringify({ level: first.ok ? "info" : "error", event: "reconcile.round", detail: first.detail }));

/*
 * One loop, run here rather than through `reconciler.start()`, because the
 * outcome of every round has to be recorded for readiness. Two loops would
 * draw two generations per interval and race each other's writes.
 */
const rounds = setInterval(() => {
  void reconciler.reconcile().then(
    (report) => { lastRound = { at: Date.now(), ok: report.skipped === undefined, detail: report.skipped ?? `activated ${report.activated.length}, attested ${report.attested.length}` }; },
    (error: unknown) => { lastRound = { at: Date.now(), ok: false, detail: error instanceof Error ? error.message : String(error) }; },
  );
}, reconciliation.intervalMs);
rounds.unref?.();

/*
 * Readiness mirrors the resolver's own patience: attestations age out after 90
 * seconds, so a reconciler whose last round is older than that is already
 * failing to hold the estate routable and should be restarted.
 */
const ROUND_STALE_MS = 90_000;
const server = createServer((request, response) => {
  if (request.url === "/health/live") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok", role: "reconciler" }));
    return;
  }
  if (request.url === "/health/ready") {
    const fresh = lastRound !== undefined && lastRound.ok && Date.now() - lastRound.at <= ROUND_STALE_MS;
    response.writeHead(fresh ? 200 : 503, { "content-type": "application/json" });
    response.end(JSON.stringify({
      status: fresh ? "ready" : "not ready",
      role: "reconciler",
      environment: snapshot.environment,
      lastRound: lastRound === undefined ? "none" : { agoMs: Date.now() - lastRound.at, ok: lastRound.ok, detail: lastRound.detail },
    }));
    return;
  }
  response.writeHead(404).end();
});
server.listen(config.port, "0.0.0.0");

const stop = async (): Promise<void> => {
  clearInterval(rounds);
  reconciler.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  // a half-written round is not a problem — every round is a full convergence
  // — but the pools must go back
  await Promise.allSettled([activation.close(), attestation.runtime.close(), attestation.identity.close(), attestation.tool_access.close()]);
  await shutdownTelemetry();
};
process.once("SIGTERM", () => { void stop(); });
process.once("SIGINT", () => { void stop(); });
