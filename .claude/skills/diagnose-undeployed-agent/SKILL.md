---
name: diagnose-undeployed-agent
description: Runbook for an Agent that merged but does not appear in the portal, does not show in Argo, or is not routable. Walks the desired-state chain in order and names the first broken link. Use for "I merged and nothing happened", "not in Argo", "not routable", or an Agent stuck in reconciling.
---

# An Agent merged and nothing happened

Every failure below is **silent by construction** — no error is raised anywhere,
which is exactly why it needs a runbook instead of a log search.

Work in order. Stop at the first ✕; everything after it is a consequence.

## 1. Is the document actually there, and active?

```bash
cat platform/config/agents/<name>.yaml | grep -E "lifecycle|name:"
```

`lifecycle: draft` → **this is the answer.** A draft writes an overlay with
`enabled: false` and no rendered values at all. Nothing is meant to deploy.
Set it to `active` (portal: Lifecycle field) and propose again.

## 2. Which environment did the change land in?

```bash
ls deploy/environments/*/agents/<name>.yaml
ls deploy/environments/*/rendered/agents/<name>.yaml
```

## 3. Which environment does the cluster watch?

```bash
grep -A2 "files:" deploy/argocd/applicationsets/runtime*.yaml
grep "repoURL" deploy/argocd/applicationsets/runtime*.yaml
```

**If 2 and 3 name different environments, that is the answer.** The pull request
merged, the portal reported it merged, and Argo was never looking at that
directory. Check `repoURL` too — a placeholder host means nothing is watched at
all.

## 4. Is the rendered file present, and should it be?

Argo's git generator globs `rendered/agents/*.yaml`. The rule is exact:

- overlay `enabled: true` → rendered file **must** exist
- overlay `enabled: false` or absent → it **must not**

A missing render for an enabled Agent means `render:deploy` was never run. A
present render for a disabled Agent is stale — `render:deploy` deletes it, and
until someone runs it, `main` fails `check:generated`.

## 5. Which environment is the runtime serving?

```bash
curl -s -m 5 http://localhost:3000/health/ready
TOKEN=$(curl -s -X POST http://localhost:3000/dev/token/alice | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
curl -s -H "authorization: Bearer $TOKEN" http://localhost:3000/management/manager
```

`environment` in that response is what the portal will target when proposing.
`routable` and `notRouted` show the derived catalog. If `SRE_DEPLOYMENT_ENVIRONMENT_DIR`
is unset the runtime falls back to `production` — which may not be the
environment your cluster watches.

## 6. Is it routable, and if not, why?

Routing is derived: `lifecycle active ∩ enabled here ∩ not observed failing`.
The portal's reconciliation panel gives the four signals with a reason each:

```
Git      merged and enabled in <env>
Argo     sync Synced, health Degraded
Runtime  the pod did not answer /health/ready
Manager  not in the effective catalog: the pod did not answer
```

Read the FIRST non-ok line. The others are usually its consequence.

An `unknown` signal means this deployment has nothing wired to observe it —
`SRE_ARGOCD_BASE_URL` / `SRE_ARGOCD_TOKEN` for Argo, `SRE_RUNTIME_PROBE=on` for
readiness. `unknown` is honest, not a fault, and availability **fails open** on
it: only a positive observation of failure removes an Agent from routing.

## 7. Is anything stale?

The runtime re-reads desired state on a short interval, so a merge takes effect
without a restart. But a runtime **older than the current contract** will serve
the old API shape — the portal then shows missing fields or a version notice.
If the API is missing fields the code clearly returns, restart the runtime.

## Things that are NOT the cause

Rule these out fast so nobody goes looking:

- `platform/config/agents/manager.yaml` — it has no routing list, by design.
  Nothing needs adding to it, ever.
- The portal — it never creates workloads. It writes Git; Argo deploys.
- Keycloak — an unreconciled workload client breaks tool calls, not visibility
  or deployment.
