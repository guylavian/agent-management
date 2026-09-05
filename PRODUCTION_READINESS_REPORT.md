# Production Readiness Report — Kubernetes Certification

## Verdict: **NOT_PRODUCTION_READY**

Not because the platform is broken — most of it works, and the parts that were
exercised held up well. It is not production-ready because **eight HIGH findings
raised by an independent adversarial review remain unfixed**, the **real
identity and tool-authorization path was never certified** (this deployment runs
mocks), and **no load or soak test was run at all**. A verdict of
PRODUCTION_READY_WITH_KNOWN_LIMITATIONS would require the known limitations to
be bounded, and several of the open findings are authorization and readiness
defects whose blast radius is not.

| Field | Value |
|---|---|
| Target | Kubernetes (docker-desktop), context `docker-desktop`, node `desktop-control-plane` |
| Kubernetes / runtime | v1.35.1, containerd 2.2.1 |
| Namespaces | `sre-assistant`, `argocd` |
| Git revision | `2debd57` on `origin/main` (github.com/guylavian/agent-management) |
| Runtime image | `sre-agent-runtime:local`, containerd `05dfeea96d6d3`, 245 MB, `imagePullPolicy: Never` |
| Portal image | `sre-agent-portal:cert`, 786 MB, `node:24-trixie-slim`, uid 1000 |
| Argo CD | v3.5.2 |
| Model | Claude CLI (haiku) behind an OpenAI-compatible shim on host port 11434 |
| Node capacity | 4 CPU, 3.83 GiB RAM, 32 GB disk, shared with all host Docker workloads |
| OpenShift SCC / Route | **NOT TESTED** — Kubernetes is the target; a future target, not a failure |

> **Safety.** The active kube context had silently switched to an AWS EKS
> cluster partway through. It was caught before any command ran against it and
> every kubectl call since passes `--context=docker-desktop` explicitly. No
> command was executed against EKS.

---

## Gate results

| Gate | Result | Evidence | Remaining risk |
|---|---|---|---|
| 0. Environment | **FIXED** | Node disk 100% full; all workloads CrashLoopBackOff 5 days (650+ restarts); `argocd-application-controller` **OOMKilled ×23**. Reclaimed 7.6 GB, stopped unrelated containers, recreated the controller. | Shared laptop resources; recurs. Not a platform defect. |
| 1. Agent lifecycle | **PASS** | Disable via Git → Argo **pruned the Application and Deployment**; catalog reported `not routable: disabled: the local deployment overlay sets enabled: false`; query returned `routedAgents: []`. Re-enable → Deployment recreated, `routedAgents: ["openshift"]`, 6 citations. **Manager was the same pod, `restarts=0`, throughout.** | Lifecycle states come from the reconciliation view; no Argo API or runtime probe is configured here, and the API says so rather than inventing a colour. |
| 2. Real identity / tool authz | **BLOCKED** | `clients.oidc/toolhive/delegation` are all `mock` here. | **Uncertified.** RFC 8693 exchange was separately proven against live Keycloak 26.6 (7/7 with a negative control), but never through this cluster's Manager→Specialist→ToolHive path. |
| 3. Persistence | **PARTIAL PASS** | Wired the manager onto real PostgreSQL through Git. A run was written to `sre_execution_event`, the Manager pod was **deleted**, and the run was **read back from a new pod that never served it** — `traceRetained: false` honestly flags what is not persisted. DB stopped → readiness flipped to `postgres: unhealthy`. | Multi-replica consistency **not tested** (single replica). |
| 4. Readiness / failure recovery | **PARTIAL** | Specialist scaled to 0, pods killed mid-query, Manager deleted — all recovered automatically (14 s, 6 s, 2 m 8 s). Postgres stopped → readiness correctly unhealthy. Probe leniency fixed (D-13). | **Specialist readiness still checks nothing** and a **failed policy reload retains stale authority** — both open, below. |
| 5. GitOps resilience | **PASS** | 20+ revisions flowed Git → Argo → Kubernetes → Ready. git-sync reached `syncCount: 3` **without a pod restart**. **Prune proven** by the lifecycle drill. **selfHeal proven**: the AppProject was deliberately drifted and Argo restored it **within 20 s**. | Explicit rollback-to-previous-revision not run as its own drill. |
| 6. Network / RBAC / secrets | **PARTIAL** (was overstated) | ServiceAccounts hold only self-subject-review and discovery — **no write verb on any resource**; no custom RBAC exists. `can-i get secrets` is **no** for every workload. **specialist→specialist:3000 TIMEOUT**. Projected token: audience `sre-agent-runtime`, TTL 600 s. No secret, JWT, key or raw user subject in any pod log. API token mount removed (D-10). | **DNS egress is unrestricted** — open, below. The earlier PASS label did not carry this and has been corrected. |
| 7. Portal | **PARTIAL** | Real image builds, runs **non-root (uid 1000)**, bakes **no secret**. Public-CDN webfont found and removed (D-11). | OIDC login, Runs/Requests and refresh **not exercised against the built image**. |
| 8. Load / soak | **NOT RUN** | — | No throughput, latency, or leak evidence exists. |
| 9. Adversarial review | **DONE** | Codex CLI 0.152.1, `codex exec`. Found 13 issues; **4 fixed**, 8 open, 1 refuted. It also correctly refuted three defects it looked for and did not find. | — |

---

## Defects found and fixed (13)

Every one was found by executing the system or by adversarial review — none by
reading code alone. Each was fixed, tested failing-first, and pushed.

| ID | Sev | Defect | Fix |
|---|---|---|---|
| D-1 | HIGH | `gitSync` pod rendered with no egress to its git remote; runtime container still passed liveness, so the pod read `1/2 Running` while the Manager never read desired state. | Chart **fails at render time** rather than shipping it. |
| D-2 | HIGH | AppProject applied once by bootstrap, reconciled by nothing; it drifted and every Application failed to sync — an outage invisible in the Applications' own health. | Root app-of-apps owns the AppProject, the ApplicationSet and itself; selfHeal verified in-cluster. |
| D-3 | MED | Unquoted `[0]` in a Helm parameter is a YAML error; reached the cluster because nothing tested manifests applied outside Helm. | Test parses every Argo manifest. |
| D-4 | HIGH | Per-role Secret split dropped the shared endpoints Secret; specialists refused to boot. | `extraEnvFrom`; `extraEgress` for unnameable destinations. |
| D-5 | MED | Local model ids named a provider the endpoint did not serve. | Bindings name what answers. |
| D-6 | HIGH | git-sync swaps a symlink and deletes the old worktree; the kernel pins CWD to the inode from exec, so the first commit after startup left the Manager reading a deleted directory. | `SRE_CONFIG_BASE_DIR` addresses config *through* the link. |
| D-7 | HIGH | D-6's first fix made the path absolute while the loader **joined** it onto the base — specialists crashlooped on ENOENT. | `resolve` not `join`; one base governs config, prompts and env dir. |
| D-8 | MED | **Five real secret files shipped in a source zip** (`.env.real-poc`, two delegation keys, a TLS key, a mock OIDC key). All correctly gitignored — which is why a "what's big" exclusion list missed them. | `tools/make-source-zip.sh` builds from `git archive`, runs `validate:tracked`, audits its own output. |
| D-9 | LOW | Root Application could not sync: kustomize refuses to load files above its root. | Directory source with an exhaustive include list. |
| D-10 | MED | Every workload mounted a Kubernetes API token it never reads. | `automountServiceAccountToken: false`. |
| D-11 | MED | Portal bundle fetched a webfont from a public CDN — in an air-gapped cluster that hangs until the browser gives up rather than failing loudly. | Removed; test rejects even a bare `preconnect`. |
| D-12 | HIGH | **`port: 0`** rendered for specialists — Kubernetes rejects it and **no specialist could sync**. My own regression, caught by Codex within minutes. | Egress gated on the postgres *client*, where the fact already lives; test asserts port 0 is never emitted. |
| D-13 | HIGH | Readiness probes accepted **any** HTTP response: a JWKS answering 404 and a model answering 500 both reported `healthy`, so Kubernetes kept routing to a pod that could not authenticate a single request. | JWKS requires 2xx **with a non-empty key set**; model requires 2xx. |

### Two lessons recorded rather than buried

**D-7**: its predecessor passed tests and `helm template` and still broke the
cluster, because no test exercised the loader against an absolute path.
Compounding it — **the image supplies the code, git-sync supplies only desired
state** — so a config-loader fix sat in Git and in the pod's environment while
the running image predated it. Watching Git land is not watching the binary
change.

**D-12**: I introduced it and pushed it, and the adversarial reviewer found it
before I did. A fix aimed at one gate broke three workloads in another.

---

## OPEN — findings raised and not fixed

These are why the verdict is NOT_PRODUCTION_READY. All were raised by the
independent review; each is stated with its trigger, not merely its category.

1. **HIGH — production fails open to mocks when `SRE_ENV` is omitted.**
   `env` defaults to `local` and every client defaults to `mock`, and the
   "production forbids mocks" check runs *after* that default. `loadAppConfig({})`
   returns a fully mocked configuration. Any Job, alternate chart or emergency
   manifest that omits `SRE_ENV` starts a production image in mock mode.
2. **HIGH — the caller chooses the environment.** `environment` is accepted from
   the request body, flows into routing, and is forwarded to ToolHive as
   `x-sre-environment`. `authorizeAgent` receives it and deliberately ignores it.
   An authenticated `infra-read` caller can post `{"environment":"dr"}` to a
   production Manager. Severity depends on whether ToolHive uses that header for
   tenant selection — which is exactly the kind of coupling that should not be
   left to chance.
3. **HIGH — specialist readiness checks nothing.** `dependencyStatus` is `{}` for
   a specialist; it returns 200 regardless of model, ToolHive or policy state.
4. **HIGH — a failed policy reload retains stale authority indefinitely.** The
   failed fingerprint is still assigned to `revision`, so later reads
   short-circuit and the old grants stay active until something else changes on
   disk. Readiness never sees it. A malformed *narrowing* of a policy therefore
   leaves the broader policy in force.
5. **HIGH — git-sync staleness is invisible to readiness.** The sidecar has no
   probe and follows mutable `main`. If credentials expire after the initial
   clone, the pod stays Ready serving an old worktree. `syncCount: 3` proves
   three syncs happened, not that convergence continues.
6. **HIGH — DNS egress is unrestricted.** The DNS rule has no `to` selector, so
   any pod may send UDP/TCP to any address on port 53. My own earlier evidence
   showed `1.1.1.1:53` connecting and I reported it as the rule working as
   intended, without recording it as an exfiltration path. That was an
   incomplete reading and the Gate 6 PASS has been downgraded accordingly.
7. **HIGH — the production ApplicationSet tolerates a missing values file.** It
   explicitly ignores the absence of `runtime-values.yaml`, which is not in the
   repository, so Argo renders apparently-valid Applications against chart
   defaults (`registry.internal/...:0.2.0`) instead of failing at render time.
8. **HIGH — the on-prem examples contradict each other.** The values example
   points every specialist at a shared `sre-agent-specialist-secrets` while the
   secrets example creates per-agent Secrets. Following both leaves every
   specialist in `CreateContainerConfigError`; "fixing" it by creating the shared
   Secret would collapse the per-specialist credential boundary the design rests
   on.

The reviewer also **refuted** three defects it went looking for: no orphan
gitSync egress rule, no path that invokes an agent or tool without re-checking
roles, and no policy disclosure in the 401 path.

---

## Gate 5/execution evidence

`HTTP 200` in 43 s against the cluster:

```
routedAgents: ["active-directory"]    degraded: false    evidenceGaps: []
4 tool calls → 4 citations, each with an evidence id and a tool:// label
```

Negative paths give precise causes rather than generic degradation:

| Case | Result |
|---|---|
| caller lacking `requiredRoles` | `AUTHZ_DENIED`, retryable false, HTTP 403 |
| invalid bearer token | `AUTHN_FAILED`, HTTP 401, no policy internals |
| question outside every domain | `ROUTE_AMBIGUOUS` — asks which domain, refuses to answer |
| disabled agent | `routedAgents: []` — not offered at all |
| model id absent | `MODEL_UNAVAILABLE`, retryable **true** |
| model cannot hold strict `json_schema` | `ROUTE_INVALID` |
| malformed tool call, budget exhausted | `TOOL_INVALID_CALL` + *"Insufficient evidence: Model-turn budget exhausted"* — refused, not fabricated |
| history unreadable (DB down) | **now** 503 `DEPENDENCY_UNAVAILABLE` with `Retry-After`; previously 404, which told an operator mid-incident that the run never happened |

**Honest limit:** `clients.toolhive=mock`, so tool *backends* are mocks. Routing,
the tool loop, evidence identity, citation binding, turn limits and grounding
are real; the data the tools return is not.

---

## Constraints

- **C-1 — laptop capacity.** 4 CPU / 3.83 GiB shared with all host Docker
  workloads. The API server intermittently returned `TLS handshake timeout`
  during rollouts. Any Gate 8 figure would be a laptop figure.
- **C-2 — identity is mocked.** Gate 2 cannot be certified without re-wiring
  this cluster onto the real Keycloak stack.
- **C-3 — the model is a local CLI shim**, one process per model call.
  `qwen3:8b` could not hold strict `json_schema` at all; haiku emits occasional
  malformed tool calls. Where that happened the platform refused safely — which
  is evidence for the platform and against the harness.

## What would change the verdict

Close the eight open findings (1 and 2 are the load-bearing ones), certify Gate 2
against real Keycloak and ToolHive, run Gate 8, and drive the built portal image
through a real OIDC login. Nothing found so far suggests the architecture is
wrong — the failures were consistently in deployment wiring and in probes that
reported more confidence than they had earned.
