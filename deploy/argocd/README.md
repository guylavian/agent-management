# GitOps on Docker Desktop Kubernetes

Argo CD reconciles this repository onto a local cluster. The Manager and every
enabled Specialist come from **one runtime image** and **one Helm chart**; they
differ only by the rendered agent values Argo feeds the chart.

```
config/agents/<agent>.yaml            canonical agent document
   │  npm run render:deploy
   ▼
deploy/environments/local/rendered/agents/<agent>.yaml
   │  git push
   ▼
ApplicationSet (git file generator)   one Application per rendered file
   │
   ▼
deploy/runtime/helm  +  rendered values
   │
   ▼
Deployment sre-agent-<agent>          Pod Ready
```

Adding an agent is a commit under `rendered/agents/`. Removing one deletes its
Application and its Deployment. Nothing here is applied by hand.

## Commands

```sh
# 1. build the shared runtime image and load it into the cluster node
./deploy/argocd/build-runtime-image.sh

# 2. install Argo CD, connect this repo, apply the project + ApplicationSet
./deploy/argocd/bootstrap-local.sh

# 3. prove it end to end
./deploy/argocd/verify.sh

# 4. open the UI (prints the admin password)
./deploy/argocd/ui.sh
```

`bootstrap-local.sh` is the only script that applies anything by hand, and it
applies **only** Argo CD, its credentials and the two desired-state objects.
Every agent workload is owned by Argo: to change one, change Git.

## Credentials

The repository token is read from `SRE_GIT_TOKEN` or the `gh` CLI and written
straight into a Secret. No token, key or endpoint is ever written to a file in
this repository — `platform/tools/check-tracked-files.ts` enforces that.

The chart mounts `sre-agent-integrations` via `envFrom`; a pod does not start
without it. Locally it carries only the shared mock-delegation secret. In a real
cluster the same Secret carries the actual endpoints and keys.

## Local vs production

`applicationsets/runtime.yaml` is production and points at the internal Git
host. `applicationsets/runtime-local.yaml` is its local twin: same generator,
same chart, same one-image rule. It differs only in

- which environment's rendered agents it discovers (`local`, not `production`),
- an image override (`sre-agent-runtime:local`, `pullPolicy: Never`), so the
  cluster needs no registry at all, and
- client wiring a laptop can satisfy (`mock` IdP/ToolHive/PostgreSQL).

Those client values are the same knobs production sets to `real`. `SRE_ENV=local`
is what permits mocks; `loadAppConfig` independently rejects every one of them
under `production`/`real-poc`, so an overlay cannot widen what the runtime
accepts — only narrow what a local cluster wires up.

## Moving off GitHub / on-prem

The Git provider appears in exactly two places: `sourceRepos` in
`projects/sre-agent-platform.yaml` and `repoURL` in the ApplicationSets and
`applications/portal.yaml`. No manifest, chart or rendered value calls a
provider API. For a Bitbucket Data Center + OpenShift GitOps target do not edit
those files: `deploy/on-prem/argocd` is a kustomize overlay over
`deploy/argocd/kustomization.yaml` that re-points repo URL, branch, Argo CD
namespace and destination namespace from `params.env`. Full procedure:
`deploy/on-prem/INSTALL.md`.

`applicationsets/runtime.yaml` also feeds the chart an optional
`deploy/environments/production/runtime-values.yaml` (cluster-wide image,
registry, CA, Route, uid values) ahead of each agent's rendered file, and
`applications/portal.yaml` deploys the management console from
`deploy/environments/production/portal-values.yaml`.

## Known local-only gaps

- `NetworkPolicy` objects are created but not enforced: Docker Desktop's CNI has
  no policy controller. The manager's ToolHive block is therefore **not** proved
  locally, only in a cluster with a real CNI.
- Ollama is reached at `host.docker.internal`. Config validation requires the
  URL to be set, not reachable, so a stopped Ollama degrades queries rather than
  the deployment.
- `replicaCount: 1` locally; production runs 2.
