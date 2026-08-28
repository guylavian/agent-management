# Local development environment — Keycloak + Prometheus (+ MCP)

Assets live under `deploy/local/`; this page is the human guide to them.

For the supported no-mock Manager-to-specialist path, use
[`docs/REAL-POC.md`](../docs/REAL-POC.md). The commands below describe only the
individual infrastructure services and older narrow component checks.

Reproducible local stack for the SRE agent PoC. Everything below was verified on
macOS (arm64) with Docker. No manual browser/UI setup is required — the realm,
client, user, role, metrics, and Prometheus scrape config are all provisioned
automatically.

## Quick start

```bash
ollama pull qwen3:8b            # local model for the agents
docker compose -f deploy/local/compose.yaml up -d   # Keycloak + Prometheus
./scripts/verify-local-stack.sh # health + scrape verification, no browser
```

`docker compose -f deploy/local/compose.yaml up -d` alone brings up a healthy Keycloak with the `sre-test`
realm imported and Prometheus already scraping it.

## Local URLs (defaults)

```text
Keycloak (OIDC / app):   http://localhost:8080
Keycloak realm:          http://localhost:8080/realms/sre-test
Keycloak metrics:        http://localhost:9000/metrics      (MANAGEMENT port, not 8080)
Keycloak health:         http://localhost:9000/health/ready
Prometheus:              http://localhost:9090
Prometheus targets:      http://localhost:9090/targets
Ollama:                  http://localhost:11434
```

Ports are configurable (compose reads these env vars, with the defaults shown):

| Variable | Default | Purpose |
|---|---|---|
| `KEYCLOAK_HTTP_PORT` | `8080` | Keycloak app/OIDC |
| `KEYCLOAK_MGMT_PORT` | `9000` | Keycloak management (`/health`, `/metrics`) |
| `PROMETHEUS_PORT` | `9090` | Prometheus |
| `KEYCLOAK_ADMIN` / `KEYCLOAK_ADMIN_PASSWORD` | `admin` / `admin` | dev bootstrap admin (test-prep only) |

> The metrics endpoint is on the **management port (9000)**, deliberately not the
> application port (8080). Prometheus scrapes `keycloak:9000/metrics` on the
> compose network (see `deploy/local/prometheus/prometheus.yml`).

## What is provisioned

- **Keycloak 26.6** in `start-dev` mode (H2 in-memory; dev only, no production
  write capabilities). Metrics + health enabled; user login-event metrics
  enabled via the `user-event-metrics` feature.
- **Realm import** `deploy/local/keycloak/realm-sre-test.json`:
  - realm `sre-test` (events enabled, login/login-error captured)
  - client `sre-test-client` (confidential; secret `sre-test-client-secret`;
    direct-access-grants on for scripted login testing)
  - user `sre-test-user` / password `sre-test-password`
  - realm role `sre-test-role`
- **Prometheus 2.55** scraping Keycloak every 15s.

## Useful Keycloak metrics for the PoC

Availability / runtime:
```text
up{job="keycloak"}                          # 1 = target scraped OK
jvm_memory_used_bytes / jvm_threads_live_threads
process_cpu_seconds_total
```

Request-related (Micrometer HTTP server metrics):
```text
http_server_requests_seconds_count{uri="/realms/{realm}/protocol/{protocol}/token", status="401"}
http_server_requests_seconds_count{status="200"}
http_server_requests_seconds_bucket   # latency histogram
```

Login / user-event metrics (enabled here):
```text
keycloak_user_events_total{realm="sre-test", event="login", error=""}                        # successes
keycloak_user_events_total{realm="sre-test", event="login", error="invalid_user_credentials"} # failures
```

Example failure-rate query:
```text
sum(rate(keycloak_user_events_total{realm="sre-test", event="login", error!=""}[5m]))
```

## Reproducible test signals

```bash
# 1 successful + N failed logins, then prints the resulting user-event metrics
./scripts/generate-keycloak-test-events.sh 5

# 3-5. verify Keycloak recorded them and Prometheus scraped them
curl -s 'http://localhost:9000/metrics' | grep keycloak_user_events_total
curl -s 'http://localhost:9090/api/v1/query?query=keycloak_user_events_total{realm="sre-test"}'
```

Then (6) ask the multi-agent system to investigate — the observability
specialist queries Prometheus through the Prometheus MCP.

## MCP servers

Endpoints are configurable (never hardcoded in runtime code). See `.env.example`.

### Prometheus MCP (read-only)

Required upstream: `https://github.com/prometheus/prometheus-mcp`. Clone and
build the pinned release with `scripts/prepare-real-poc.sh`; start it and its
ToolHive proxy with `scripts/start-real-poc.sh`.

```bash
./scripts/prepare-real-poc.sh
./scripts/start-real-poc.sh
```

Only the approved upstream query/read tools reach the Observability agent.
Dangerous TSDB admin tools and the `reload`/`quit` management tools are not exposed.

If the MCP runs **inside** a container instead of on the host, point it at
`http://host.docker.internal:9090` (the compose file already makes host-gateway
work for that direction).

The real verifier requires a `query` citation whose result observes the Keycloak target.

### Keycloak MCP (read-only) — VERIFIED

The local Keycloak MCP (`/Users/guylavian/Projects/Active/mcp/keycloak-mcp-server`)
is read-only by default and **refuses cleartext http**, so it needs Keycloak on
HTTPS. The realm import provisions a dedicated read-only service account
(`sre-mcp-reader`, `view-*` realm-management roles only). Enable TLS and run it:

```bash
# 1. self-signed localhost cert + Keycloak HTTPS on 8443 (dev only)
./scripts/gen-keycloak-cert.sh
docker compose -f deploy/local/compose.yaml -f deploy/local/keycloak/tls.override.yml up -d

# 2. run the Keycloak MCP against it (stdio)
KEYCLOAK_URL=https://localhost:8443 \
KEYCLOAK_REALM=sre-test \
KEYCLOAK_CLIENT_ID=sre-mcp-reader \
KEYCLOAK_CLIENT_SECRET=sre-mcp-reader-secret \
KEYCLOAK_VERIFY_TLS=false \
uv run --project /Users/guylavian/Projects/Active/mcp/keycloak-mcp-server keycloak-mcp-server
```

Smoke-tested with the MCP SDK: `keycloak_health` returns
`visible_realms:["sre-test"], read_operations:148, secret_reads_enabled:false`
and `list_clients` returns the realm's clients. No write tool is registered
under the default config.

`KEYCLOAK_MCP_ENDPOINT` remains available for an HTTP-fronted MCP; when unset the
verify script reports the MCP check as SKIP rather than faking success.

## Docker networking (macOS)

- Agents / MCP servers run on the **host** → reach Keycloak/Prometheus at
  `http://localhost:8080` / `:9000` / `:9090`.
- A component running **inside Docker** that must reach a host service (Ollama,
  a host MCP) uses `host.docker.internal` (e.g. `http://host.docker.internal:11434`).
- Prometheus (in Docker) scrapes Keycloak (in Docker) by service name:
  `keycloak:9000`.

## Teardown

```bash
docker compose -f deploy/local/compose.yaml down   # stop; keeps nothing (H2 is in-memory)
```
