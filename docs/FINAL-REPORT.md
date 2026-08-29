# Agent Management Platform — implementation report

Factual state as of the current commit. Every classification below was checked
against the code, the test run, or the live stack — not asserted from intent.

**Classification key**

| Label | Meaning |
|---|---|
| IMPLEMENTED | Working, tested, and exercised end to end |
| WIRED BUT REQUIRES CONFIGURATION | Code path complete and tested; inert until env/config is supplied |
| UI ONLY | Renders, but is not connected to a working action |
| NOT IMPLEMENTED | Absent |

---

## 1. Final monorepo tree

```
/
├── contracts/
│   └── agent-schema/              canonical Agent definition (zero deps)
│
├── runtime/                       EXECUTION PLANE — authoritative
│   ├── app/                       Manager + Specialist runtime (Express)
│   ├── packages/                  agent-client, agent-protocol, agent-registry,
│   │                              auth, config, evidence, llm, mcp, routing,
│   │                              runtime, session, telemetry
│   └── deploy/                    helm/ (chart + 6 per-agent values), openshift/, postgres/
│
├── management/                    MANAGEMENT PLANE — a console
│   ├── portal/                    Backstage 1.54 (own yarn workspace)
│   │   ├── packages/{app,backend}
│   │   └── plugins/{agent-management, agent-management-backend}
│   ├── packages/                  management-api, keycloak-provisioning
│   └── deploy/portal/             Helm chart
│
├── agents/  prompts/  policies/   configuration = source of truth
├── infra/  scripts/  eval/  docs/  schemas/
```

## 2. Apps created

| App | Location | State |
|---|---|---|
| Agent runtime | `runtime/app` | pre-existing, **moved**, not rewritten |
| Backstage portal | `management/portal` | **created** (Backstage 1.54, new frontend system) |

## 3. Packages created

| Package | Purpose | Status |
|---|---|---|
| `contracts/agent-schema` | THE canonical Agent definition | IMPLEMENTED |
| `management/packages/keycloak-provisioning` | desired state + idempotent reconciler | IMPLEMENTED (library) |
| `management/packages/management-api` | read-only projections, run graph, YAML/GitOps | IMPLEMENTED |

## 4. Plugins created

| Plugin | Purpose | Status |
|---|---|---|
| `agent-management` | product UI (7 screens + wizard) | IMPLEMENTED |
| `agent-management-backend` | permissions, runtime proxy, catalog provider | IMPLEMENTED |

## 5. Files and directories moved

All moves used `git mv`, so history is preserved.

| From | To |
|---|---|
| `apps/api` | `runtime/app` |
| `apps/portal` | `management/portal` |
| `deploy` | `runtime/deploy` |
| `packages/{12 runtime pkgs}` | `runtime/packages/*` |
| `packages/agent-schema` | `contracts/agent-schema` |
| `packages/{management-api,keycloak-provisioning}` | `management/packages/*` |
| `packages/rag` | **deleted** (dead since RAG left active execution; nothing imported it) |

## 6. Agent schema — IMPLEMENTED

One definition in `contracts/agent-schema`, consumed by the runtime, Git
validation, tests and provisioning. The portal consumes its *projections* over
HTTP rather than importing it, so there is no second Agent model.

Added to the existing schema:

- `metadata.displayName`
- `spec.lifecycle` — draft | active | disabled | decommissioning | removed
- `spec.identity` — `{provider, clientId}`, clientId must equal `sre-agent-<name>`
- `spec.access[]` — `{mcp, audience, tools}`, **replacing** flat `mcp.servers` + `mcp.allowedTools`
- `spec.security.readOnly` — literal `true`

**Why `access[]` replaced the flat pair.** The old check was
`servers.includes(id) && allowedTools.includes(tool)` — a cross product. A tool
granted for one server was authorized on *any* server the agent could reach that
exposed the same tool name. `isToolAllowed(spec, serverId, toolName)` is now
exact per MCP.

Derived, never authored (schema rejects mismatches): workload client id,
ToolHive audience, Keycloak client scope, Keycloak client role.

Deliberately **not** added: routing vocabulary (terms, capabilities,
exclusions). It already lives in `agents/registry.yaml`; duplicating it would
create drift between the Manager's view of an agent and the agent's own config.
Semantic validation cross-checks the two instead.

## 7. Backstage implementation — IMPLEMENTED

Backstage 1.54, new declarative frontend system. Its default sidebar is replaced
with the product rail, and `noHeader` removes Backstage page chrome, so the
platform does not read as "Backstage with a plugin".

Screens, all verified rendering live data: Overview, Agents directory
(search + 4 filters + table/card), Agent Detail (8 tabs), Permissions matrix,
MCP Servers, Runs, Run execution graph, Create Agent wizard.

Design follows the supplied reference: Figtree, `#4f5be7` accent, `#f5f6fa`
canvas, 10px radius, CSS-grid tables, status pills, mono avatars, 38×22 toggles.
Technical values (model profiles, client ids, audiences, endpoints, timestamps,
durations) render in `ui-monospace/Menlo`; everything else in Figtree. Verified
in-browser via computed `font-family`.

## 8. Create Agent — IMPLEMENTED (preview) / WIRED (pull request)

Five steps: Basics & Routing → Intelligence → Identity, Knowledge & Tools →
Security & Runtime → Review & Create Change.

- Workload client id is **derived and read-only** in the UI
- Tool selection shows READ/WRITE/**UNKNOWN**; UNKNOWN and WRITE are not
  selectable — a tool absent from the approved catalog cannot be granted
- New agents default to `lifecycle: draft`
- Preview YAML is server-side, run through the same schema the runtime loads,
  so a previewed file cannot fail at startup
- **There is no Deploy button.** A security regression test asserts no such
  route exists.

## 9. Workload identity — IMPLEMENTED (model) / WIRED (runtime acquisition)

Every specialist has its own Keycloak client (`sre-agent-<name>`); five distinct
clients, no shared credential. Asserted by test.

The credential now carries **both** actors: the human as `sub`, the agent
workload as the RFC 8693 `act.sub` and `azp`. The verifier rejects a credential
whose envelope names a different workload than the signed `act` claim.

## 10. Keycloak AuthN — WIRED BUT REQUIRES CONFIGURATION

`KeycloakWorkloadCredentialExchanger` performs `client_credentials` against
Keycloak requesting exactly one MCP audience scope per call, caches per
`(workload, audience)` with a 5s skew guard, and — when a JWKS is configured —
verifies the returned `aud` really matches, so a drifted mapper fails closed.

**Not exercised by the running PoC:** `scripts/start-real-poc.sh` sets
`SRE_TOOL_CREDENTIAL_STRATEGY=signed-jwt`. Switching to `workload-client`
additionally requires `SRE_TOOL_CREDENTIAL_TOKEN_ENDPOINT` and
`SRE_TOOL_CREDENTIAL_CLIENT_SECRET`; startup fails closed without them.

## 11. Keycloak AuthZ — IMPLEMENTED (library) / NOT WIRED (no entrypoint)

`desiredClientFor(agent)` derives: a confidential service-account client, one
**optional** client scope per MCP carrying that MCP's audience mapper, and one
client role per `(mcp, tool)` grant.

**The optional-scope choice is the whole design.** Audience mappers attached to
the client itself would put every audience into every token — the `aud=all-mcps`
pattern the architecture forbids. As *optional* scopes, the workload requests one
scope per call and receives a token whose `aud` is only that MCP's resource.

The reconciler is idempotent (a second run writes nothing), supports
create/update/disable, re-hardens a client that drifted to public/interactive,
and **never deletes** a workload identity.

**Limitation:** no CLI or job invokes it. It is a library with 13 tests against
an in-memory realm; a human must call it from code or a script.

## 12. Agent → MCP → Tool enforcement — IMPLEMENTED

`AuthorizationService.preflightTool` checks, before every call:

1. lifecycle is `active` — a disabled agent is denied regardless of roles
2. MCP is in `access[]`
3. tool is in that MCP's list (per-MCP, no cross-MCP bleed)
4. tool is `readOnlyVerified` and the agent is read-only
5. environment matches
6. credential audience equals the policy's audience for that MCP

Proven against the live stack, not only in tests: the Keycloak specialist
produced `toolhive.call.keycloak.list_realms`, `list_clients` and
`keycloak_health` spans through ToolHive.

## 13. ToolHive changes — IMPLEMENTED (minimal, deliberately)

ToolHive remains mandatory and unchanged as a boundary. Changes on our side:
`toolHiveAudience` deduplicated into the contract; audience→resource binding
checked in the runtime before a credential is presented; the audit event now
records `workloadClientId` from the verified token.

## 14. GitOps — IMPLEMENTED (proposal) / WIRED (PR creation)

Preview is pure and changes nothing. `proposeAgentChange` produces branch,
title, body and an explicit "what merging this changes" effects list.
`GitHubGitOpsProvider` opens a PR and never pushes to the base branch. With no
provider configured the endpoint returns `not-configured` rather than pretending
a PR exists.

Requires `SRE_GITOPS_PROVIDER=github`, `SRE_GITOPS_OWNER`, `SRE_GITOPS_REPO`,
`SRE_GITOPS_TOKEN`.

## 15. OpenTelemetry — IMPLEMENTED

Existing spans retained. Added `workload.token` (attributes: agent id, workload
client id, MCP, audience — **never the token**) and `authorization.check`;
renamed the MCP span to `toolhive.call.<server>.<tool>`.

A test installs a recording tracer and asserts on emitted spans: no JWT, no
secret, and no raw human subject appears in any attribute; the human is carried
as `user.subject_hash`.

## 16. Tests added

| Area | File | Tests |
|---|---|---|
| Agent schema (§54) | `contracts/agent-schema/tests/agent-schema.test.ts` | 22 |
| Management projections (§56) | `management/packages/management-api/tests/` | 22 |
| Authorization matrix (§55) | `runtime/packages/auth/tests/agent-mcp-tool-authorization.test.ts` | 17 |
| Management HTTP contract | `runtime/app/tests/management-api.test.ts` | 14 |
| Security regression (§57) | `runtime/app/tests/security-regression.test.ts` | 13 |
| Keycloak provisioning (§58) | `management/packages/keycloak-provisioning/tests/` | 13 |
| Telemetry spans | `runtime/packages/runtime/tests/telemetry-spans.test.ts` | 4 |

Plus a `workload actor swapped after signing` case added to the Gate #1 suite.

## 17. Full test results

```
npm run check  →  exit 0

  plane boundaries ok — 1 contract, 12 runtime, 2 management package(s)
  Test Files  35 passed (35)
  Tests      238 passed (238)
  YAML validation: 7 passed
  helm: runtime chart lint+render OK, portal chart lint+render OK
```

Baseline at session start was 133 tests. Net +105 (one test removed with `rag`).

## 18. Real PoC regression

```
16 PASS, 3 FAIL, 0 BLOCKED
```

Baseline at session start: `0 PASS, 0 FAIL, 19 BLOCKED` (environment blocked).

All 14 infrastructure checks pass from the new paths, including "all runtimes
are real-poc with no mock/direct/in-process dependency" and ToolHive/MCP
reachability for Keycloak, Prometheus and Wiki.

**The 3 failures are external model-provider rate limiting, not regressions.**
Verified rather than assumed: the observability specialist's spans show
`exception.type: MODEL_RATE_LIMITED` on both LLM turns, so the model never
selected a tool. Routing was correct in all three cases. Earlier in the same
session, with the same code, smoke C passed with real MCP evidence — the failure
set moves between runs.

## 19. Remaining limitations

| Gap | Classification |
|---|---|
| Evaluations backend | NOT IMPLEMENTED — API and UI report `not-configured` |
| Agent health probing | NOT IMPLEMENTED — reports `reachability: unknown` rather than inventing "healthy" |
| Durable run history | NOT IMPLEMENTED — in-memory ring, capacity 200, lost on restart |
| Argo CD Application manifests | NOT IMPLEMENTED |
| Keycloak reconciler entrypoint | NOT WIRED — library only, no CLI or job |
| Decommission workflow | NOT IMPLEMENTED — lifecycle states exist; no guided flow |
| Sidebar sections Models / Evaluations / Deployments / Teams | NOT IMPLEMENTED — spec §18 lists 10, six are present |
| Enabled/Disabled toggle on Agent detail | READ-ONLY — shows what Git declares; disabled, with `aria-readonly` and a tooltip saying a change is a pull request. Lifecycle, routability and reachability are three separate cards, so `enabled` no longer reads as liveness |
| Edit button | IMPLEMENTED — `/agents/:id/edit` opens the create wizard prefilled from the Agent; the runtime renders it as an "Update" change-set. Proven lossless: all five shipping Agents regenerate a byte-identical document, asserted by a unit round-trip test and confirmed against the live manager |
| Editing a grant the approved catalog does not list | GUARDED, NOT SUPPORTED — the detail view intersects grants with the catalog, so such a grant would be silently dropped by an edit. It is already dead at runtime, and a test now fails the build rather than letting the portal delete it |
| Portal image | NOT BUILT — Helm chart references `registry.internal/sre-agent-portal:0.1.0`; no Dockerfile for the portal yet |
| Workload-client token path | WIRED — real PoC still uses `signed-jwt` |
| Enterprise RFC 8693 token exchange | BLOCKED — pre-existing integration blocker, unchanged |

## 20. Next recommended step

**Build and wire the Keycloak reconciler entrypoint**, because it is the one
place where the canonical policy is currently *described* but not *applied*.

Today `agents/*.yaml` drives the runtime allowlist and the ToolHive audience,
but the Keycloak side (client, optional scopes, tool roles) is still whatever
the bootstrap script created. That is a drift surface exactly where the
architecture says there should be none.

Concretely: a `scripts/reconcile-keycloak.ts` that loads the registry, calls
`desiredClientsFor`, and runs `reconcileAll` with `--dry-run` by default; then
call it from `start-real-poc.sh` so the local stack provisions the five
per-agent clients it currently lacks. That would move §10/§11 from
"IMPLEMENTED (library)" to "IMPLEMENTED", and would let the workload-client
token path (§10) actually be switched on and regression-tested.
