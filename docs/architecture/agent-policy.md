# Agent policy

One canonical Agent definition, in `packages/agent-schema`. It is consumed by the
runtime, Git validation, the tests, Keycloak provisioning and (through the
management API's projections) the portal. There is no second Agent model.

```yaml
apiVersion: sre.ai/v1alpha1
kind: Agent
metadata:
  name: keycloak
  owner: identity-platform
  displayName: Keycloak Agent
spec:
  type: specialist
  lifecycle: active                 # draft | active | disabled | decommissioning | removed
  model: { tier: small, profile: tool-caller }
  prompt: { systemFile: prompts/keycloak.md }
  identity: { provider: keycloak, clientId: sre-agent-keycloak }
  access:                           # THE canonical Agent → MCP → Tool policy
    - mcp: keycloak
      audience: sre-toolhive:keycloak
      tools: [keycloak_read, keycloak_health, list_realms, list_clients, get_client, find_user, resolve_client_uuid]
    - mcp: wiki
      audience: sre-toolhive:wiki
      tools: [wiki_search, wiki_read_page, wiki_route]
  execution: { maxToolCalls: 6, maxModelTurns: 6, timeoutMs: 120000, ... }
  discovery: { allowedNeedsDomains: [observability] }
  authorization: { requiredRoles: [infra-read] }
  security: { readOnly: true }
```

Every object is `.strict()`: unknown keys — loops, branches, expressions,
embedded code, workflow constructs — are rejected, not ignored.

## What `access` replaced, and why

The previous shape was a flat pair:

```yaml
mcp:
  servers: [keycloak, wiki]
  allowedTools: [list_clients, wiki_search, ...]
```

Authorization was `servers.includes(serverId) && allowedTools.includes(toolName)`
— a cross product. A tool granted for one server was authorized on **any** server
the Agent could reach that happened to expose the same tool name.

`access[]` scopes tools to their MCP, so `isToolAllowed(spec, serverId, toolName)`
is exact. The same list drives the runtime allowlist, the ToolHive audience and
the Keycloak client roles, which is what keeps those three from drifting.

## Derived, never authored

| Value | Derivation | Enforcement |
|---|---|---|
| Workload client id | `sre-agent-<name>` | schema rejects any other value |
| ToolHive audience | `sre-toolhive:<mcp>` | schema rejects a mismatched `audience` |
| Keycloak client scope | `sre-toolhive-<mcp>` | provisioner |
| Keycloak client role | `<mcp>:<tool>` | provisioner |

Writing `audience: sre-toolhive:keycloak` under `mcp: wiki` is a validation
failure, not a silent privilege change.

## What is deliberately elsewhere

Routing vocabulary — exact terms, entity patterns, capabilities, exclusions,
service endpoints — lives in `agents/registry.yaml`, the separately validated
`AgentServiceRegistry` the Manager loads. Duplicating it into the Agent document
would create drift between the Manager's view of an Agent and the Agent's own
config. Semantic validation cross-checks the two: the Manager may not route to an
Agent whose lifecycle is not `active`.

## Tool classification

The approved catalog (`policies/approved-tools.yaml`) admits only
`readOnlyVerified: true` tools. A tool absent from the catalog is **UNKNOWN**,
never READ. The portal renders UNKNOWN explicitly and refuses to select it;
`validateSemantics` rejects an Agent granting a tool the catalog does not list for
that MCP. Fail closed.

## Lifecycle

```
draft → active → disabled → decommissioning → removed
```

Only `active` may route or hold a usable workload credential. `isAgentEnabled` is
checked in `authorizeAgent`, so disabling stops *execution*, not merely Manager
routing — routing disablement alone is not treated as a security control.

Reconciliation disables the Keycloak client for any non-active lifecycle. It never
deletes a workload identity automatically: destroying one discards the audit
linkage of everything that identity ever did.

## Secrets

The schema has no field that could hold a credential, and `assertNoSecretMaterial`
rejects credential-shaped keys at config load. The regex is deliberately specific
so it catches `clientSecret` and `privateKey` without flagging legitimate limits
such as `maxContextTokens`.
