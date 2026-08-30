# On-prem installation

Target: Bitbucket Data Center → Argo CD (OpenShift GitOps) → OpenShift, with
Keycloak (RHBK), ToolHive, an internal registry and internal model endpoints
already managed by the platform team. Nothing here deploys a replacement for
any of them. After step 5 Argo CD owns every workload; no `oc apply` is
repeated.

## 0. Prerequisites (platform team)

- OpenShift namespace (default `sre-assistant`); the installing user needs
  `edit` there and permission to create AppProject/ApplicationSet/Application
  objects in the Argo CD namespace. No cluster-admin.
- Argo CD able to reach Bitbucket; Bitbucket HTTP access tokens (read for Argo,
  write for the console's pull requests).
- RHBK realms and clients as listed in `ON_PREM_REQUIRED_VALUES.md`.
- ToolHive proxies for each MCP server named in `config/agents/*.yaml`, loaded
  with the Cedar files from `deploy/environments/production/rendered/toolhive/`.
- vLLM (or another OpenAI-compatible) endpoints serving the model ids in
  `deploy/environments/production/model-bindings.yaml`.
- PostgreSQL: one database for the Manager (apply
  `deploy/runtime/postgres/001_sessions.sql`), one for the portal.
- Namespace labels the NetworkPolicies key on:
  - every namespace hosting RHBK, ToolHive, vLLM, PostgreSQL, the OTel
    collector (and the Argo CD namespace if `SRE_ARGOCD_BASE_URL` is set):
    `oc label ns <ns> sre.ai/platform-service=true`
  - the target namespace itself, so the portal may call the Manager:
    `oc label ns sre-assistant sre.ai/api-client=true`
  - the router namespace already carries `network.openshift.io/policy-group=ingress`.

## 1. Mirror and build (connected build host)

```sh
# base images and npm packages come from your mirrors
docker build -f deploy/runtime/Dockerfile \
  --build-arg BASE_IMAGE=registry.example.internal/mirror/node:24-alpine \
  --build-arg NPM_REGISTRY=https://nexus.example.internal/repository/npm/ \
  -t registry.example.internal/sre/sre-agent-runtime:<tag> .

cd platform/management/portal && yarn install --immutable && yarn tsc && yarn build:backend
docker build -f ../../../deploy/portal/Dockerfile \
  --build-arg BASE_IMAGE=registry.example.internal/mirror/node:24-trixie-slim \
  --build-arg NPM_REGISTRY=https://nexus.example.internal/repository/npm/ \
  -t registry.example.internal/sre/sre-agent-portal:<tag> .

docker push registry.example.internal/sre/sre-agent-runtime:<tag>
docker push registry.example.internal/sre/sre-agent-portal:<tag>
```

Build-time mirroring requirements (documented, not automated): Debian apt for
the portal image (`libsqlite3-dev`), the npm registry, the two Node base
images. See `DEPLOYMENT_VALIDATION.md` for the runtime dependencies checked.

## 2. Push the repository to Bitbucket

Push this repository as-is to `https://<bitbucket>/scm/<PROJECT>/<repo>.git`.
Then commit, on the tracked branch:

```
deploy/environments/production/runtime-values.yaml   <- from runtime-values.example.yaml
deploy/environments/production/portal-values.yaml    <- from portal-values.example.yaml
deploy/on-prem/argocd/params.env                     <- your repo URL, branch, namespace
```

Fill every placeholder. These files hold **no secrets** — only names of Secrets.
If the namespace is not `sre-assistant`, set `environmentOverride` in
`runtime-values.yaml` to match `TARGET_NAMESPACE`.

Agent enablement and replicas per environment live in
`deploy/environments/production/agents/*.yaml`; after editing, run
`cd platform && npm run render:deploy && npm run render:toolhive` on the build
host and commit the `rendered/` output (CI fails on a stale render).

## 3. Create Secrets and the endpoints ConfigMap (out of band)

Use `secrets.example.yaml` as the list of objects. Create them with your
secret-management tooling (External Secrets, Sealed Secrets, a vault pipeline)
in the target namespace, and the repository Secret in the Argo CD namespace.
Never commit a filled-in copy.

```sh
oc -n sre-assistant apply -f <your filled copy, from a vault, not from Git>
```

## 4. Bootstrap Argo CD (once)

```sh
kubectl kustomize deploy/on-prem/argocd | oc apply -f -
```

This creates the AppProject (namespace-scoped whitelist only: Deployment,
Service, ServiceAccount, ConfigMap, HPA, PDB, NetworkPolicy, Route), the
runtime ApplicationSet and the portal Application, all pointed at your
Bitbucket repository.

## 5. Verify

```sh
oc -n openshift-gitops get applications                     # one per rendered agent + sre-agent-portal, Synced/Healthy
oc -n sre-assistant get deploy,route
oc -n sre-assistant get pod -l app.kubernetes.io/name=sre-agent-runtime
curl -sk https://<manager route>/health/ready               # {"status":"ready",...,"environmentMode":"production"}
```

A pod that crash-loops with `ConfigValidationError: unsafe configuration`
names the missing variable; it is fail-closed by design. Fix the ConfigMap or
Secret, not the chart.

## Day 2

- New image: change `image.tag` in the two values files and push. Argo rolls it.
- New/changed Agent: edit `platform/config/agents`, re-render, push; the
  ApplicationSet creates or prunes its Application.
- Rotate a secret: update the Secret; restart the affected Deployment
  (`oc rollout restart`) — the runtime reads env at startup only.
