# Groq PoC — provider-agnostic model path

The PoC default model path is now the **Groq OpenAI-compatible API** with native
tool calling. The provider is configuration only: swap the base URL and model
ids for an on-prem air-gapped endpoint later with no code change. Ollama remains
supported but is no longer required.

> ⚠️ **Cloud data safety.** Groq is a cloud endpoint. Use only synthetic/local
> test data. Do **not** send production credentials, enterprise secrets, or real
> customer/user data. The target production architecture remains air-gapped/on-prem.

## Required environment variables

```bash
SRE_CLIENT_LLM=real
SRE_LLM_BASE_URL=https://api.groq.com/openai/v1     # provider endpoint (on-prem later)
SRE_LLM_API_KEY=<GROQ_API_KEY>                       # Bearer token; omit for keyless on-prem

# logical profile → served model id
SRE_MODEL_MANAGER=qwen/qwen3.8-27b                   # profile manager-router
SRE_MODEL_TOOL_CALLER=qwen/qwen3.8-27b               # profile tool-caller
SRE_MODEL_SYNTHESIS=qwen/qwen3.8-27b                 # profile tier-l-synthesis
```

No Groq URL or model name is hardcoded in business logic — profiles
(`manager-router`, `tool-caller`, `tier-l-synthesis`) map through config.

## Startup (distributed local PoC — Groq + local MCPs)

```bash
# infra: local Keycloak/Prometheus + the wikikb MCP (unchanged)
docker compose up -d
# your existing wikikb MCP on :8642 (docker start wikikb)

# agents (manager + specialists), Groq provider overlay
GROQ_API_KEY=<key> docker compose -f docker-compose.agents.yml -f docker-compose.groq.yml up -d
./scripts/verify-local-stack.sh
```

MCP execution stays local: `Groq → our runtime → ToolHive → local MCP`. The Groq
API never connects to Keycloak, Prometheus, the Wiki MCP, or ToolHive.

## Ask the Manager (curl)

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/dev/token/alice | sed -E 's/.*"token":"([^"]+)".*/\1/')
curl -s -X POST http://localhost:3000/v1/query -H "authorization: Bearer $TOKEN" -H "content-type: application/json" -d '{"question":"According to our documentation, how should Keycloak login failures be investigated?","environment":"prod"}'
```

## Automated tests (no real key required)

`npm run check` — 129 unit/integration tests pass, including
`packages/llm/tests/provider.test.ts` covering: base URL configurable, API key
Bearer, manager/tool-caller/synthesis profile→model mapping, native tool-call
parsing, assistant-tool-call + tool-result replay across turns, no-tool response
terminates as answer, rate-limit (429), invalid/non-JSON response, 5xx provider
failure, and the deterministic mock without any provider. `npm run eval`:
pass@1/pass^8 = 0.983, 0 tool-policy violations (deterministic mock; validates
harness/runtime, not model reliability).

## Real Groq integration tests

Run with a key present:

```bash
export GROQ_API_KEY=<key>
# Test A — Manager routing
curl ... '{"question":"Is AD replication healthy?"}'
# Test B — Wiki-only investigation
curl ... '{"question":"According to our documentation, how should Keycloak login failures be investigated?"}'
# Test C — Domain MCP (Prometheus)
curl ... '{"question":"Show current Prometheus packet-loss for the core uplinks."}'
# Test D — Multi-step (docs + live)
curl ... '{"question":"What does the runbook say to check for Keycloak login failures, and what is currently wrong?"}'
# Test E — Multi-agent routing
curl ... '{"question":"Users are experiencing Keycloak login failures. Is this caused by Keycloak configuration or service/runtime health?"}'
# Test F — Round 2: a specialist returns needsDomain → bounded second round
```

| Test | Result |
|---|---|
| A Manager routing | NOT TESTED (no GROQ_API_KEY in this environment) |
| B Wiki-only | NOT TESTED |
| C Domain MCP | NOT TESTED |
| D Multi-step | NOT TESTED |
| E Multi-agent | NOT TESTED |
| F Round 2 | NOT TESTED |

## Model comparison (fill when a key is available)

| Scenario | qwen/qwen3.8-27b | openai/gpt-oss-20b |
|---|---|---|
| routing | — | — |
| tool selection | — | — |
| multi-step convergence | — | — |
| latency | — | — |
| grounded answer | — | — |

Start with `qwen/qwen3.8-27b`; only if convergence/tool selection is poor, re-run
the identical scenarios with `openai/gpt-oss-20b` (set `SRE_MODEL_*`) and report
the comparison — do not switch automatically.

## Budgets

Per specialist: `maxModelTurns` / `maxToolCalls` (raise to 6/6 for multi-step PoC
via the agent YAML), plus timeout/evidence/context/request budgets. No unlimited
loops; budget exhaustion returns a safe insufficient-evidence result.

## Remaining blockers

- **GROQ_API_KEY not present** in this environment → real integration tests A–F
  are NOT TESTED. Provide a key and run the curls above.
- Exact Groq model ids must be valid for your account (`qwen/qwen3.8-27b`,
  `openai/gpt-oss-20b`); an invalid id returns a provider error surfaced safely.
