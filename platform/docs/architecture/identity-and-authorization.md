# Identity and authorization

There are **two separate authorization problems**. They are never merged.

| Problem | Question | Authority | Enforced where |
|---|---|---|---|
| User → Agent | May this human invoke/manage this Agent? | Keycloak (human realm roles) + Backstage permissions | `AuthorizationService.authorizeAgent`, portal permission checks |
| Agent → MCP → Tool | May this Agent workload call this tool on this MCP? | Canonical Agent policy, represented in Keycloak | `AuthorizationService.preflightTool`, then ToolHive |

Backstage saying a human may edit an Agent grants that Agent nothing. The
runtime re-evaluates every tool call regardless of what the portal believes.

## Workload identity — one client per Agent

Every specialist has its own Keycloak client, derived from its name:

```
keycloak         → sre-agent-keycloak
observability    → sre-agent-observability
active-directory → sre-agent-active-directory
```

`workloadClientId()` in `@sre/agent-schema` is the single derivation used by the
runtime, the provisioner and the portal. The schema rejects a document whose
`spec.identity.clientId` disagrees with it, so a hand-edited client id fails
config load rather than silently creating a second identity.

There is deliberately no shared Agent credential.

## Audience-bound tokens

A token must be usable against exactly one MCP. This is modelled with **one
optional Keycloak client scope per MCP**, each carrying an audience mapper:

```
client scope sre-toolhive-keycloak   → aud = sre-toolhive:keycloak
client scope sre-toolhive-wiki       → aud = sre-toolhive:wiki
```

The scopes are *optional*, which is the whole point. Audience mappers attached
to the client itself would put every audience into every token — the
`aud = all-mcps` design the architecture forbids. As optional scopes, the
workload requests one scope per call:

```
POST /token
  grant_type=client_credentials
  client_id=sre-agent-keycloak
  scope=sre-toolhive-keycloak
→ access token with aud = sre-toolhive:keycloak only
```

A token minted for `sre-toolhive:keycloak` therefore does not authorize
Prometheus, AD or Check Point.

Tokens are short-lived (`access.token.lifespan = 60`). `KeycloakWorkloadCredentialExchanger`
caches per `(workload, audience)` with a 5-second skew guard, and — when a JWKS
is configured — verifies the returned `aud` actually matches what was requested,
so a drifted mapper fails closed instead of quietly widening reach.

## Human identity stays separate

The human is carried as a signed, audience-bound **delegated credential**, not
an unsigned header. The Agent workload is the RFC 8693 `act` (actor) claim:

```
sub = the human who asked
act.sub = sre-agent-keycloak   (the workload that executed)
azp = sre-agent-keycloak
aud = sre-toolhive:keycloak
```

ToolHive verifies the token itself and derives both principals from it. The
audit chain can therefore state *initiated by* and *executed by* independently:

```
User → Manager → Keycloak Agent → Keycloak MCP
```

The verifier rejects a credential whose envelope claims a different workload
than the signed `act` claim, so the actor cannot be swapped after signing.

Traces carry `user.subject_hash`, never a raw subject, and never token contents.

## Defense in depth

Authorization does not live only in Keycloak. Before any call the runtime checks:

1. the Agent's lifecycle is `active` (a disabled Agent is denied outright)
2. the MCP appears in the Agent's `access` policy
3. the tool appears under **that** MCP (per-MCP scoping — a tool granted on one
   server is not granted on another exposing the same name)
4. the tool is `readOnlyVerified` in the approved catalog and the Agent is read-only
5. the tool is approved for the request environment
6. the credential's audience equals the audience the policy declares for that MCP
7. the request is within its tool-call, model-turn, deadline and evidence budgets

Only then is the audience-bound token presented to ToolHive, which independently
verifies issuer, audience, expiry, caller and policy before the MCP is reached.

A compromised Agent cannot reach another MCP by simply asking for it, and a
stolen `sre-toolhive:keycloak` token does not open Prometheus.

## Backend credentials stay behind the MCP

The Keycloak JWT authorizes the *platform* hop. It does not replace a backend's
native mechanism:

```
AD Agent → OIDC/JWT → ToolHive → AD MCP → Kerberos/gMSA → Active Directory
```

Agents never receive backend credentials.

## Secrets

Never in Git, Agent YAML, the Backstage catalog, browser storage, traces or
logs. `assertNoSecretMaterial` runs at config load and rejects credential-shaped
keys structurally; a security regression test greps every `agents/*.yaml`. Client
secrets and Git tokens are supplied through callbacks so they can be sourced from
OpenShift Secrets or a vault and rotated without rebuilding objects.
