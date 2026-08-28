# Management plane

| Plane | Component | Responsibility |
|---|---|---|
| Management | Backstage (`management/portal`) | Agent management UI, auth shell, catalog, ownership, plugin host |
| Execution | Runtime (`runtime/app`) | Manager, Specialists, runtime authorization — **authoritative** |
| Security | Keycloak | Identity, AuthN, AuthZ for humans and Agent workloads |
| Access | ToolHive | MCP security boundary; verifies issuer, audience, expiry, caller |
| Configuration | Git | Source of truth for Agent policy |
| Deployment | Argo CD / OpenShift | Reconciles merged configuration |
| Observability | OpenTelemetry, Prometheus, Grafana | Execution traces and metrics |

Backstage is **not** the Agent runtime, **not** an MCP proxy, and **not** the
enforcement point for runtime tool calls.

## Request path (unchanged)

```
User → Manager → Specialists → Runtime authorization → ToolHive → MCP → Infrastructure
```

The Manager decides *who* investigates; the Specialist decides *what* it needs;
the runtime decides whether that is *allowed*; ToolHive controls *how* the MCP is
reached. Specialists never call each other — cross-domain work returns through
the Manager as a bounded Round 2.

## Management API

Read-only, mounted on the Manager behind the same human OIDC authentication as
`/v1/query`, and only when the full agent registry is present in the process.

```
GET  /management/agents
GET  /management/agents/:id
GET  /management/agents/:id/health
GET  /management/agents/:id/metrics
GET  /management/mcp-servers
GET  /management/permissions
GET  /management/runs
GET  /management/runs/:id
GET  /management/evaluations
POST /management/agents/preview   (pure — validates a draft, renders YAML)
POST /management/agents/change    (opens a pull request)
```

It never returns tokens, secrets, credentials, model reasoning or unredacted tool
output — asserted by test. There is no endpoint that deploys to production.

Where a backend is absent the API says `not-configured` rather than returning
plausible-looking numbers. Agent health reports `reachability: unknown` because
nothing probes the specialists yet; inventing "healthy" would be fabricated
telemetry.

## GitOps

```
Portal → validate canonical Agent → generate YAML → policy validation → preview
       → pull request → review → merge → reconcile (runtime, Keycloak, ToolHive)
       → Argo CD → OpenShift
```

The portal offers *Preview YAML* and *Create Pull Request*. It has no Deploy
button, and a security regression test asserts no such route exists. A new Agent
is written with `lifecycle: draft`, so merging the file does not by itself put an
Agent into rotation.

With no Git provider configured, the change endpoint reports `not-configured`
rather than pretending a pull request was opened.

## Backstage permissions

Eleven management permissions (`agent.read`, `agent.create`, `agent.edit`,
`agent.disable`, `agent.prompt.edit`, `agent.access.edit`, `agent.tools.edit`,
`agent.gitops.createPr`, `mcp.read`, `run.read`, `evaluation.read`) are registered
by the backend plugin and checked per route for the human caller.

These govern who may *manage*. They never grant an Agent access to anything.

## Catalog

Agent entities are derived from the runtime's projection of `agents/*.yaml` by an
entity provider, not from a second hand-maintained `catalog-info.yaml`. Each Agent
becomes a Component owned by its team, depending on Resources for the MCPs its
policy allows. With no runtime configured the provider emits nothing rather than
placeholder entities.
