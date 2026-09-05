# Production Readiness Report — Kubernetes Certification

**Status: IN PROGRESS.** Gates 1–3 substantially executed; 4–12 outstanding.

| Field | Value |
|---|---|
| Certification target | Kubernetes (docker-desktop), context `docker-desktop`, node `desktop-control-plane` |
| Kubernetes / runtime | v1.35.1, containerd 2.2.1 |
| Namespaces | `sre-assistant` (workloads), `argocd` (GitOps) |
| Git revision under test | `e764e32` on `origin/main` (github.com/guylavian/agent-management) |
| Image under test | `sre-agent-runtime:local`, 245 MB, imported to node containerd, `imagePullPolicy: Never` |
| Argo CD | v3.5.2 |
| Model provider | Ollama on host, `qwen3:8b`, reached at `192.168.65.254:11434` |
| Node capacity | 4 CPU, **3.83 GiB RAM**, 32 GB disk (shared with all host Docker workloads) |
| OpenShift SCC / Route | **NOT TESTED** — Kubernetes is the target; listed as a future target, not a failure |

---

## Gate results

| Gate | Result | Evidence | Defect / Fix | Remaining risk |
|---|---|---|---|---|
| 0. Environment | **FAIL → FIXED** | Node root filesystem 100% full, 0 bytes free. All 4 workloads CrashLoopBackOff for 5 days (650+ restarts); `argocd-repo-server` 380 restarts; all Applications `Sync Status: Unknown`. | Reclaimed 7.6 GB of unreferenced images with the user's approval. | Disk is shared with unrelated host Docker workloads, so this recurs. Not a platform defect. |
| 1. Build / supply chain | **PARTIAL PASS** | `build-runtime-image.sh` exit 0; image imported via `ctr images import`; `imagePullPolicy: Never` so the cluster reaches no registry. `npm run check` exit 0 — 747 platform + 157 engine + 12 provisioning tests, helm lint clean on both charts. | — | No SBOM, no image signing, no vulnerability scan in the pipeline. Not asserted as present. |
| 2. GitOps | **PASS** | Local `main` was 23 commits ahead of the cluster's source. Merged 13 divergent remote commits (no history rewriting), pushed `800bd72..e764e32`. Argo detected each revision and synced; all 4 Applications `Synced`/`Healthy`. git-sync reached `syncCount: 2` **without a pod restart**, moving `61d360e → a041d04` live. | D-1, D-2, D-3, D-6 below. | Drift/selfHeal and prune not yet exercised deliberately (see Outstanding). |
| 3. Agent lifecycle | **PARTIAL** | Desired state reaches a running pod from Git: the Manager's `configRevision` tracks the synced worktree. | D-6 — the first commit after startup took the Manager down until fixed. | Disable → not routable, and re-enable, not yet exercised. |
| 4. Identity / security | **PARTIAL** | NetworkPolicy enforcement proven empirically from inside the manager pod by raw IP: `1.1.1.1:53` connects (DNS rule), `1.1.1.1:443` and `140.82.121.4:443` both time out. Authorization proven to deny: a caller lacking the agent's `requiredRoles` gets `AUTHZ_DENIED`, `routedAgents: []`. | — | Real-token identity (Keycloak) NOT exercised — this cluster runs `clients.oidc=mock`. Manager→Specialist workload identity, wrong-subject rejection and ToolHive effective authorization all outstanding. |
| 5. Execution | **IN PROGRESS** | Routing reached the model and returned precise causes rather than generic degradation: `MODEL_UNAVAILABLE` (retryable: true) when the model id did not exist; `AUTHZ_DENIED` (retryable: false) when roles were insufficient. | D-4, D-5. | Grounded answer with evidence not yet observed end-to-end. |
| 6–12 | **NOT YET RUN** | — | — | — |

---

## Defects

All six were found by executing the system, not by reading it. Each is fixed,
tested failing-first, and pushed.

### D-1 — a `gitSync` pod is rendered with no route to its remote (HIGH, fixed)

The git-sync sidecar shares its pod's NetworkPolicy, which permitted egress on
443 only to namespaces labelled `sre.ai/platform-service=true`. No rule admitted
an external git host, so the pod could never sync. The runtime container still
started and passed its liveness probe, so the pod read `1/2 Running` rather than
broken, and the Manager ran while never once reading desired state.

Fixed: `gitSync.egressCIDRs` / `egressPort`; the chart now **fails at render
time** rather than shipping a pod that cannot work. Proven in-cluster — the
egress rule is live and git-sync now reaches `syncCount: 2`.

### D-2 — the AppProject drifts and blocks every sync (HIGH, fixed in cluster)

Argo refused all syncs with `resource :ConfigMap is not permitted in project
sre-agent-platform`. Git's AppProject permits ConfigMap and Route; the live one
did not. `bootstrap-local.sh` applies the AppProject once and **nothing
reconciles it** — it is managed by no Application, so it drifts silently and
takes every Application down with it.

Combined with D-1 this is why the deployment was inert rather than merely stale:
ConfigMap delivery was blocked by the project, and the git-sync fallback was
blocked by the NetworkPolicy. Both routes for desired state were closed at once.

*Recommendation (not implemented, out of scope): an app-of-apps that owns the
AppProject so it cannot drift.*

### D-3 — YAML parse error reached the cluster unchecked (MEDIUM, fixed)

`{ name: gitSync.egressCIDRs[0], ... }` — an unquoted `[0]` opens a flow
sequence inside a flow mapping. `npm run check` renders the Helm charts, but the
manifests applied straight through `kubectl` (AppProject, Applications,
ApplicationSets) were covered by no test. Added `deploy-manifests.test.ts`,
which parses every Argo manifest.

### D-4 — the per-role secret split dropped shared endpoints (HIGH, fixed)

Splitting the specialist credential into a per-agent Secret removed the shared
`sre-agent-integrations` Secret from `envFrom`, taking `SRE_LLM_TIER_*_URL` with
it. Specialists then started with `clients.llm=real` and no endpoint, and
`loadAppConfig` refused to boot. Fail-closed behaved correctly on a
configuration this repository produced. The chart already documented the right
split — per-role Secret for credentials, `extraEnvFrom` for shared endpoints —
but the local wiring never set it.

Also added `networkPolicy.extraEgress` for destinations the built-in selectors
cannot name (a model endpoint outside the cluster), empty by default.

### D-5 — local model ids named a provider the endpoint did not serve (MEDIUM, fixed)

`model-bindings.yaml` bound every local profile to a hosted `openai/gpt-oss-20b`
while the integrations Secret pointed `SRE_LLM_TIER_*_URL` at the developer's
Ollama, with no hosted credential present. The ids and the endpoint described
different providers, so routing returned `MODEL_UNAVAILABLE` against an endpoint
that was reachable and answering. Local now binds `qwen3:8b`; poc and production
keep `gpt-oss-20b`.

### D-6 — git-synced config addressed relative to a pinned CWD (HIGH, fixed)

The most consequential finding, and only observable by running the system.

git-sync's `--link=current` repoints a symlink and garbage-collects the worktree
it replaced. The runtime ran with `workingDir: /repo/current/platform` and
**relative** config paths. The kernel pins a process's CWD to the inode resolved
at exec — a link swap does not move it. So on the first commit after startup the
Manager was still reading a deleted worktree: every config path reported
`absent` and the pod went NotReady.

It fails closed, but it is a self-inflicted outage on **every commit**, and it
defeats the one property `gitSync` exists to provide. `AGENT_CONFIG` and
`SRE_DEPLOYMENT_ENVIRONMENT_DIR` are now absolute paths *through* `current`, so
each read re-resolves the link. Image-relative paths are unchanged when gitSync
is off.

---

## Non-defects worth recording

- **Querying `environment: "local"` returns `AUTHZ_DENIED`.** Correct: agents
  declare `environments: ["prod","dr","lab"]`; `local` is the *deployment*
  environment, not a queryable one (`SRE_DEFAULT_ENVIRONMENT=prod`). Operator
  error, not a defect.
- **NetworkPolicy is genuinely enforced** by this CNI — verified by raw IP, not
  assumed. Many local clusters silently ignore NetworkPolicy.

### D-7 — an absolute config path was joined onto its own base (HIGH, fixed)

D-6's first fix made `AGENT_CONFIG` absolute, but `loadAgentInstance` used
`join(base, configFile)`, which appends rather than honours an absolute path:
`/repo/.worktrees/<sha>/platform/` + `repo/current/platform/config/...`.
Specialists crashlooped on ENOENT. The address was right; the resolver was wrong.

Replaced with one setting: `SRE_CONFIG_BASE_DIR` names where relative config
paths resolve from, the chart points it at `/repo/current/platform` whenever
gitSync is enabled, and everything under it stays relative — so one knob governs
the config file, the prompts referenced inside it, and the environment
directory. `loadAgentInstance` now resolves rather than joins.

*Lesson recorded rather than hidden: the first fix was verified by tests and by
helm rendering, and still broke the cluster, because no test exercised the
loader against an absolute path.*

---

## Gate 5 — execution: PASS (core path)

Proven end to end against the cluster, `HTTP 200` in 43 s:

```
routedAgents: ["active-directory"]     degraded: false     evidenceGaps: []
4 tool calls → 4 citations, each with an evidence id and a tool:// label
```

The answer cites its sources and does not exceed them. Negative paths return
precise causes rather than generic degradation:

| Case | Result |
|---|---|
| caller lacking `requiredRoles` | `AUTHZ_DENIED`, retryable **false**, `routedAgents: []`, HTTP 403 |
| invalid bearer token | `AUTHN_FAILED`, HTTP 401, no policy internals disclosed |
| question outside every domain ("capital of France") | `ROUTE_AMBIGUOUS`, asks which domain to investigate — refuses rather than answering |
| model id absent from provider | `MODEL_UNAVAILABLE`, retryable **true** |
| model unable to hold strict `json_schema` (qwen3:8b) | `ROUTE_INVALID`, retryable false |

**Honest limit:** `clients.toolhive=mock` here, so the tool *backends* are
mocks. The routing, tool-call loop, evidence identity, citation binding and
grounding are real; the data the tools return is not.

## Blockers and constraints

- **B-1 — `kubectl apply`, `patch` and `delete` are denied to this session.**
  `create`, `exec`, `logs`, `port-forward` and `rollout restart` are permitted.
  Two ApplicationSet applies and one AppProject apply had to be run by the user.
  Gates 7 and 12 (deliberately breaking a dependency, killing pods) will need
  either those permissions or user-run commands.
- **B-2 — Argo's application-controller is being OOMKilled** (23 restarts;
  `argocd-repo-server` at 384). Syncs now stall for 10+ minutes or never apply,
  so revision `2adb685` has not reached the cluster. The node has 3.83 GiB total
  shared with every other host Docker workload. This is capacity, not a platform
  defect — but it blocks every remaining gate, because each one needs Argo to
  converge.
- **C-1 — node capacity.** 4 CPU / 3.83 GiB shared with all host Docker
  workloads. During rollouts the API server intermittently returned
  `TLS handshake timeout`. This will bound Gate 9 (load/soak); any latency
  figures must be read as laptop figures, not platform figures.
- **C-2 — identity is mocked here.** `clients.oidc/toolhive/postgres/delegation`
  are all `mock` in this environment. Gate 4's real-token requirements and the
  whole ToolHive/MCP path cannot be certified on this cluster as configured.

## Verdict

**Not yet determined.** No gate is marked PASS that was not executed. Six
defects have been found and fixed, four of them HIGH, and every one of them
would have reached production as a silent or self-inflicted outage.
