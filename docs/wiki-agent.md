# Wiki specialist — configuration and smoke test

Read-only internal-documentation specialist backed by the existing **LLM Wiki
MCP** (`wikikb`). It searches wiki knowledge, retrieves runbooks/procedures/
architecture docs, and always reports **documented/expected** state, never
live infrastructure state. It is orchestrated only by the Manager and is never
called by another specialist.

## Files

| File | Change |
|---|---|
| `agents/wiki.yaml` | new specialist (RAG off; mcp server `wiki`; allowedTools `wiki_search`, `wiki_read_page`, `wiki_route`) |
| `prompts/wiki.md` | read-only, untrusted-data, documentation-vs-live system prompt |
| `agents/registry.yaml` | `wiki` entry with routing `description`/`capabilities`/`exclusions` (dynamic Manager catalog) |
| `agents/manager.yaml` | `agents.allowed` += `wiki` |
| `policies/approved-tools.yaml` | wiki tools, `readOnlyVerified`, `evidenceKind: wiki` |
| `packages/config/src/schemas.ts` | approved-tool `evidenceKind` field |
| `packages/mcp/src/normalizer.ts` | wiki results become `kind:"wiki"` Evidence with `sourceModifiedAt` (doc version), not `observedAt` |
| `packages/mcp/src/toolhive-client.ts` | MockToolHive serves the wiki tools |
| `packages/llm/src/client.ts` | mock Manager routes doc/runbook/procedure/wiki questions to `wiki` with a task |
| `packages/runtime/tests/wiki.test.ts` | 12 wiki tests |
| `deploy/helm/values/wiki.yaml` | per-agent Helm values |

## Wiki agent configuration (`agents/wiki.yaml`)

- `spec.mcp.servers: [wiki]`, `allowedTools: [wiki_search, wiki_read_page, wiki_route]`
  — `wiki_ask` is deliberately excluded because it can write (`file_back=true`);
  the agent is strictly read-only.
- `spec.rag.enabled: false` — knowledge comes from the wiki MCP, not platform RAG.
- Tool visibility remains `YAML allowlist ∩ approved catalog ∩ user authz ∩
  environment` and is enforced through ToolHive; the runtime never hardcodes
  MCP endpoints or tool names.

## Required MCP / ToolHive environment

```bash
LLM_WIKI_MCP_ENDPOINT=http://localhost:8642/mcp        # wikikb Streamable-HTTP MCP
LLM_WIKI_ALLOWED_TOOLS=wiki_search,wiki_read_page,wiki_route
SRE_TOOLHIVE_URL=http://localhost:<toolhive-port>      # runtime → ToolHive → wikikb
SRE_CLIENT_TOOLHIVE=real                               # real path (mock for tests/demo)
```

`LLM_WIKI_MCP_ENDPOINT` is registered on the **ToolHive** side (server id
`wiki`); the runtime only knows `SRE_TOOLHIVE_URL` + server id, so the wiki path
does not bypass ToolHive.

## Real smoke test (ask the Manager)

Start the wikikb MCP (already running in Docker as `wikikb`, `POST
http://localhost:8642/mcp`), register it behind ToolHive as server `wiki`, then:

```bash
# once the manager is running (dev:local or deployed):
curl -s -X POST http://localhost:3000/v1/query \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"question":"What does the internal wiki say about Keycloak authentication troubleshooting?","environment":"prod"}'

curl -s -X POST http://localhost:3000/v1/query \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"question":"According to our documentation, how should Keycloak login failures be investigated?","environment":"prod"}'
```

Expected path: `Manager → Wiki Agent → ToolHive → LLM Wiki MCP → Evidence
(kind:wiki) → final answer`, with the answer distinguishing documentation from
live evidence.

## Verified vs blocked

| Item | Result | Evidence |
|---|---|---|
| Wiki agent + routing + evidence + 12 tests | **PASS** | `npm run check` (123 tests) |
| Manager routes doc/cross-domain questions to Wiki with a focused task | **PASS** | wiki tests 1–3; `executeRequest` demo routes `["wiki"]` with a wiki citation |
| wikikb MCP reachable + returns real content | **PASS** | MCP SDK: `wiki_route("keycloak login failures") → {"domains":["keycloak"],"confident":true}` |
| Wiki tool call through ToolHive; unauthorized/unknown/malformed blocked; injection ignored; not-live; no-result | **PASS** | wiki tests 4–11 |
| Real `Manager → ToolHive → wikikb` end-to-end | **BLOCKED** | no ToolHive gateway is running locally; wikikb is a standalone Streamable-HTTP MCP. Unblock by running ToolHive with `wiki` → `LLM_WIKI_MCP_ENDPOINT` registered, then run the curl above. Not reported as PASS because it was not executed against real ToolHive. |
