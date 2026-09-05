---
name: add-agent
description: The canonical procedure for adding or enabling an SRE specialist Agent — through the portal or by hand — including which files a change-set contains, why a draft deploys nothing, and how to pick the right environment. Use when creating, enabling, disabling or removing an Agent, or when asked how onboarding works.
---

# Adding an Agent

Git is desired state. Argo and the pod are actual state. Nothing here writes to
a cluster: the portal writes Git, Argo does the rest.

## Preferred: through the portal

Create Agent → set **Lifecycle** → Preview YAML → Create Pull Request → merge.

**Lifecycle is the field that decides whether anything deploys.** The deployment
overlay's `enabled` is derived from it, so the two files cannot disagree:

- `draft` — merged, listed in the portal, **nothing is deployed**. No rendered
  Helm values are written at all, because Argo's generator globs `rendered/`
  and `render-agent-deployment.ts` prunes disabled overlays. This is a
  deliberate state, not a failure.
- `active` — deploys on merge.
- `disabled` — stops deploying; Argo prunes the Application.

The change-set targets **the environment the runtime serves**, not a fixed one.
A runtime serving `local` writes `deploy/environments/local/...`. Confirm with
`GET /management/manager` → `environment` before proposing, if it matters.

An **active** Agent produces four files; a **draft** produces three:

```
platform/config/agents/<name>.yaml                        the Agent
platform/config/prompts/<name>.md                         its prompt
deploy/environments/<env>/agents/<name>.yaml              the overlay
deploy/environments/<env>/rendered/agents/<name>.yaml     active only
```

## By hand

1. `platform/config/agents/<name>.yaml` — identity, routing, access, limits.
   See `docs/architecture/agent-policy.md`.
2. `platform/config/prompts/<name>.md` — a missing or empty prompt fails config
   load for the whole registry, not just this Agent.
3. A new MCP server, if involved: `platform/config/mcp-servers/<server>.yaml`.
   Only `readOnlyVerified` tools may be approved.
4. `deploy/environments/<env>/agents/<name>.yaml` — where it runs.
5. `npm --prefix platform run render:deploy && npm --prefix platform run check`

## What you never do

- **Do not edit `platform/config/agents/manager.yaml` to add a route.** It has
  no `agents.allowed` field; the schema is `.strict()`, so a leftover block is
  a load error. Routing is derived:
  `lifecycle active ∩ enabled here ∩ not observed failing`.
- **Do not hand-edit anything under `rendered/`.** Those files say
  `GENERATED — DO NOT EDIT` and CI re-renders and fails on any diff.
- **Do not invent the workload client id or the ToolHive audience.** Both are
  derived from the name.
- **Do not create workloads imperatively.** No `kubectl apply`, no `helm
  install`. If that seems necessary, stop and report it.

## After merging

The Manager re-reads desired state while running — no restart. The portal polls,
so no browser refresh. Expect `reconciling`, then `active` once Argo has synced
and the pod answers. A merged Agent whose deployment fails stays listed as
`degraded` with the signal that caused it.

Reconcile Keycloak separately with `@sre/keycloak-provisioning` — idempotent,
dry-run first.

If the Agent does not appear or does not deploy, use the
`diagnose-undeployed-agent` skill rather than guessing.
