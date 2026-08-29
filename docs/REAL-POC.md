# Real local PoC runbook

This runbook is the supported no-mock path for Keycloak and Prometheus investigations. The data-plane path is always:

```text
Specialist -> ToolHive proxy -> upstream MCP -> real backend
```

The runtime never contacts the upstream MCP endpoints directly in `SRE_ENV=real-poc`.

## Pinned external components

- Keycloak `26.6` (`quay.io/keycloak/keycloak:26.6`)
- Prometheus `2.55.1` (`prom/prometheus:v2.55.1`)
- Prometheus MCP `v0.18.0`, cloned from `https://github.com/prometheus/prometheus-mcp.git`
- ToolHive `v0.28.3`, cloned from `https://github.com/stacklok/toolhive.git`
- Existing Keycloak MCP project `/Users/guylavian/Projects/Active/mcp/keycloak-mcp-server`
- Existing LLM Wiki MCP supplied by `LLM_WIKI_MCP_ENDPOINT`

The preparation script clones both Git repositories at exact tags and builds the Prometheus MCP and `thv` binaries locally. No custom Prometheus or Keycloak MCP is present in this repository.

## Start

```bash
cp .env.real-poc.example .env.real-poc
# edit every change-this-* value and configure the real LLM/Wiki endpoints

./engineering/tools/prepare-real-poc.sh
./engineering/tools/start-real-poc.sh
./engineering/tools/verify-real-poc.sh
```

`start-real-poc.sh` performs these operations:

1. Generates a local TLS certificate and starts Keycloak plus Prometheus with Docker Compose.
2. Reapplies the configurable local test-user/client/service secrets through `kcadm`.
3. Starts the existing Keycloak MCP over Streamable HTTP on `127.0.0.1:8201/mcp`, with every write namespace disabled.
4. Starts the cloned/built Prometheus MCP over Streamable HTTP on `127.0.0.1:8202/mcp`, without dangerous TSDB admin tools.
5. Starts Manager, Keycloak specialist and Observability specialist as separate real HTTP services.
6. Registers three upstream MCPs as ToolHive remote workloads and exposes the authenticated proxies on ports 8301-8303.

The existing Wiki MCP must already be running. The startup fails rather than substituting a Wiki mock.

## Runtime environment

Every runtime process receives:

```text
SRE_ENV=real-poc
SRE_CLIENT_OIDC=real
SRE_CLIENT_LLM=real
SRE_CLIENT_TOOLHIVE=real
SRE_CLIENT_POSTGRES=disabled
SRE_CLIENT_AGENT=real
SRE_CLIENT_DELEGATION=real
```

`postgres=disabled` means optional conversation persistence is off and supplies no backend data. It is not a mock. The real path requires no session ID.

Required user-provided variables are listed in `.env.real-poc.example`. The notable integration variables are:

| Variable | Purpose |
|---|---|
| `SRE_LLM_BASE_URL` | Real OpenAI-compatible model endpoint |
| `SRE_MODEL_MANAGER` | Real Manager routing model ID |
| `SRE_MODEL_TOOL_CALLER` | Real specialist tool-calling model ID |
| `SRE_MODEL_SYNTHESIS` | Real synthesis model ID |
| `SRE_LLM_API_KEY` | Optional provider credential |
| `LLM_WIKI_MCP_ENDPOINT` | Existing real Wiki MCP Streamable HTTP endpoint |
| `KEYCLOAK_MCP_PROJECT` | Existing Keycloak MCP checkout; defaults to the required project path |

All local passwords and client secrets live in `.env.real-poc`, which is ignored by Git. The values inside the committed realm import are disposable bootstrap values and are overwritten by the bootstrap script.

## ToolHive registrations

The script uses ToolHive's remote-server mode. These are the effective commands (with the shared OIDC flags omitted here for readability):

```bash
thv run http://127.0.0.1:8201/mcp --name sre-poc-keycloak --group sre-real-poc --proxy-port 8301 --tools <Keycloak-read-tools>
thv run http://127.0.0.1:8202/mcp --name sre-poc-prometheus --group sre-real-poc --proxy-port 8302 --tools <Prometheus-read-tools>
thv run "$LLM_WIKI_MCP_ENDPOINT" --name sre-poc-wiki --group sre-real-poc --proxy-port 8303 --tools wiki_search,wiki_read_page,wiki_route
```

The runtime endpoint map points only to these ToolHive proxies:

```json
{
  "keycloak": "http://127.0.0.1:8301/mcp",
  "prometheus": "http://127.0.0.1:8302/mcp",
  "wiki": "http://127.0.0.1:8303/mcp"
}
```

ToolHive validates a short-lived RS256 token with audience `sre-toolhive:<serverId>`. The token contains the effective human subject and entitlements derived from the Manager's verified delegation. No `x-effective-user` header is sent or trusted.

## Read-only boundary

The Keycloak MCP starts with `MCP_ENABLE_WRITES=false` and `KEYCLOAK_ALLOW_SECRET_READS=false`. Its service account receives only `view-*` and `query-*` realm-management roles. The specialist allow-list contains:

```text
keycloak_read, keycloak_health, list_realms, list_clients, get_client,
find_user, resolve_client_uuid
```

The Prometheus MCP is built from the upstream project and started without `--dangerous.enable-tsdb-admin-tools`. ToolHive and the Agent YAML expose only query/read tools. In particular, `reload`, `quit`, `clean_tombstones`, `delete_series` and `snapshot` are unavailable.

The runtime independently rejects destructive MCP annotations and mutation-like tool names before invocation.

## Provisioned Keycloak data

- realm: `sre-test`
- user: `sre-test-user`, with `sre-test-role` and `infra-read`
- client: `sre-test-client`
- realm role: `sre-test-role`
- read-only MCP service client: `sre-mcp-reader`
- Manager workload client: `sre-manager-workload`

Run `engineering/tools/generate-keycloak-login-failures.sh 5` to perform one real successful password grant and five real failed grants.

## Verification and evidence

`engineering/tools/verify-real-poc.sh` writes the four smoke responses to `.real-poc/results/`. A smoke test passes only if the expected routed agent IDs and real `mcp://<server>/<tool>` citations are present. It also checks all three readiness responses and rejects `mock`, `direct`, `inprocess`, or `http-local` dependency modes.
