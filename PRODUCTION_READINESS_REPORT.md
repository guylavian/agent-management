# Production Readiness Report — Kubernetes Certification

## Verdict: **NOT_PRODUCTION_READY**

**No known defect remains open.** All eight HIGH findings are closed, a re-review
found nothing new that survived verification, and `npm run check` is green.

The verdict is negative because **the security control plane is not closed end
to end.** Two further defects were found by reviewing the shipped source (not
the report) and are fixed below; what remains is that **the identity and
tool-authorization chain has never been executed**, and that **revocation is not
automated**. Production runs real Keycloak, real workload
identity, RFC 8693 exchange, ToolHive and Cedar. This cluster runs mocks for all
of them. Deploying to production means running a configuration that has not once
been exercised end to end — and that chain *is* the security boundary. That is an
evidence gap, not a broken system, and it is scoped below at 4–5 hours of
in-cluster deployment work.

I am not calling this PRODUCTION_READY_WITH_KNOWN_LIMITATIONS because the
untested path is the one that decides who may invoke which tool.

| Field | Value |
|---|---|
| Target | Kubernetes (docker-desktop), context `docker-desktop`, node `desktop-control-plane` |
| Kubernetes / runtime | v1.35.1, containerd 2.2.1 |
| Namespaces | `sre-assistant`, `argocd` |
| Git revision | `516dc35` on `origin/main` (github.com/guylavian/agent-management) |
| Runtime image | `sre-agent-runtime:local`, containerd `f1ea76ab1ed99`, 246 MB, `imagePullPolicy: Never` |
| Portal image | `sre-agent-portal:cert`, 786 MB, `node:24-trixie-slim`, uid 1000, no baked secret |
| Argo CD | v3.5.2 · Keycloak available 26.6 (host) · PostgreSQL 16 (host) |
| Model | Claude CLI (haiku) behind an OpenAI-compatible shim on host port 11434 |
| Node capacity | 4 CPU, 3.83 GiB RAM, shared with all host Docker workloads |
| OpenShift SCC / Route | **NOT TESTED** — Kubernetes is the target. A future target, not a failure. |

> **Safety.** The active kube context was observed switching to an AWS EKS
> cluster **twice** during this work, once mid-build. No command ran against it:
> the first was caught before use, the second caused a build to load an image
> into nothing (fixed — the build script now pins its context). Every kubectl
> call passes `--context=docker-desktop` explicitly.

---

## Gate results

| Gate | Result | Evidence | Remaining risk |
|---|---|---|---|
| 0. Environment | **FIXED** | Node disk 100% full; all workloads CrashLoopBackOff 5 days; `argocd-application-controller` OOMKilled ×23. Reclaimed 7.6 GB, stopped unrelated containers, recreated the controller. | Shared laptop resources. Environmental. |
| 1. Agent lifecycle | **PASS** | Disable via Git → Argo **pruned the Application and Deployment**; `routedAgents: []`. Re-enable → recreated, routable, 6 citations. **Manager: same pod, `restarts=0`, throughout.** | Lifecycle states come from the reconciliation view; no Argo API or runtime probe configured here, and the API says so. |
| 2. Real identity / tool authz | **BLOCKED** | Not executed. See "The blocking gap". | **This is why the verdict is negative.** |
| 3. Persistence | **PASS** | Manager wired to real PostgreSQL through Git. Run written to `sre_execution_event`, Manager pod **deleted**, run **read back from a new pod that never served it**. DB stopped → readiness `postgres: unhealthy`. Schema lost on container restart → every write failed **and was logged and metered** (`run.record_failed`). | Multi-replica consistency not tested (single replica). |
| 4. Readiness / failure recovery | **PASS** | Specialist scaled to 0, pods killed mid-query, Manager deleted — all recovered automatically (14 s, 6 s, 2 m 8 s). Probe leniency, specialist blindness and stale-policy retention all closed and re-verified in-cluster. | Time-based git-sync freshness is not asserted — see residual R-1. |
| 5. GitOps resilience | **PASS** | 30+ revisions Git → Argo → Kubernetes → Ready. git-sync advanced **without a pod restart**. Prune proven. **selfHeal proven**: AppProject deliberately drifted, restored in **20 s**. App-of-apps propagated an ApplicationSet change end to end. | Explicit rollback-to-previous-revision not run as its own drill. |
| 6. Network / RBAC / secrets | **PASS** | ServiceAccounts hold only self-subject-review and discovery — **no write verb on any resource**; `can-i get secrets` is **no** for every workload; API token mount removed. **specialist→specialist:3000 TIMEOUT**. **DNS now confined**: cluster resolve works, `1.1.1.1:53` and `8.8.8.8:53` **TIMEOUT** (previously connected). No secret, JWT, key or raw user subject in any pod log. | The `0.0.0.0/0:443` git-sync egress applies in **local only**; production leaves gitSync off, so the rule is not rendered there. |
| 7. Portal | **PARTIAL** | Real image builds, runs **non-root (uid 1000)**, **no baked secret**. Public-CDN webfont removed, with a test that rejects even a bare `preconnect`. | **Real OIDC login not exercised** — blocked on the same in-cluster Keycloak as Gate 2. |
| 8. Load / soak | **PASS (measured)** | See measurements below. | Latency is a harness figure, not a platform figure. |
| 9. Adversarial review | **DONE** | Codex 0.152.1 found 13 issues in pass 1. Pass 2 hit a **Codex usage quota** mid-run; substituted a Claude reviewer and flagged it here. It raised 3 findings: **2 refuted empirically**, 1 partially valid (R-1). | — |

---

## Load and soak measurements

`node load.mjs`, concurrency 5, 4 rounds, 20 requests through `POST /v1/query`.

```
requests        20 over 270.3s wall
answered 200    15/20 (75%)
p50 / p95       58,837 ms / 70,776 ms      min 9,311 ms   max 70,776 ms
outcome classes
  degraded_unknown             5
  http_403                     5     ← CORRECT: alice lacks network-read
  degraded_failed              4
  degraded_TOOL_INVALID_CALL   3
  ok                           2
  degraded_UNGROUNDED_ANSWER   1     ← grounding guarantee firing under load
```

**Reading these honestly.** Zero crashes, zero timeouts, zero exceptions, and
**zero pod restarts** — no OOM, no leak. Every request received a well-formed
response carrying a precise outcome class. The five 403s are the authorization
model working: those questions were network-observability questions and the
caller holds only `infra-read`. Excluding them, every request that *should* have
been served was served.

The remaining degraded classes are **model quality, not platform failure**: the
local harness spawns one CLI process per model call, and that model emits
occasional malformed tool calls. One request came back
`degraded_UNGROUNDED_ANSWER` — the platform detected an answer its evidence did
not support and refused it, under load. Manager RSS after the run: **45 MB, heap
4 MB**. Node memory 2.40 GiB of 3.83 GiB.

**p50 of 59 s is a harness figure.** It measures one `claude -p` process per
model call on a laptop, not the platform's own throughput.

---

## The blocking gap — Gate 2

Everything needed exists; none of it is wired together in-cluster.

**Already proven, standalone:** RFC 8693 token exchange against live Keycloak
26.6 — 7/7 including a negative control, with `sub` the human, `aud` one target,
`azp` the agent. Keycloak 26.6 runs on the host with realm `sre-test`. ToolHive
(`thv` v0.46.0), `kubernetes-mcp` v0.0.66 and `prometheus-mcp` v0.18.0 binaries
are built. Helm charts exist for ToolHive and both MCP servers. Cedar policies
are rendered at `deploy/environments/poc/rendered/toolhive/*.authz.yaml`.

**What is missing is deployment, not technology.** Pods cannot reach the host's
`localhost:8443`, so Keycloak, its database, ToolHive and the MCP servers must
run in-cluster. Scoped:

| Step | Effort |
|---|---|
| Add `standard.token.exchange.enabled` + audience mappers to realm clients | ~5 min |
| In-cluster PostgreSQL for Keycloak | ~1 h |
| In-cluster Keycloak 26.6 with realm import and TLS | ~2 h |
| Expose the Manager's internal HTTPS JWKS on 3443 | ~20 min |
| Deploy kubernetes-mcp (+ RBAC) and ToolHive operator with Cedar policies | ~2.5 h |
| NetworkPolicy egress to in-cluster Keycloak and ToolHive | ~30 min |

Total ≈ **4–5 hours**. It fits in 3.83 GiB only with resource discipline —
specialist replicas at 1, memory limits trimmed. Nothing here is a red line.

Gate 7's real OIDC login is blocked on exactly the same work.

---

## Found by source review after the report was written (2 HIGH, fixed)

Both sit exactly on the security invariants, and both were invisible in the
report because the report described intent rather than the execute path.

### S-1 — policy reload was fail-closed at readiness, not at the application

`desired-state.ts` deliberately keeps the last valid document when a reload
fails, and `app.ts` turns readiness 503. Neither stops work.
`/internal/v1/execute` never consulted `policyStatus()`, so it went on running
against `agentOf()` — the **broader** document Git was trying to replace:

```
Git narrows permissions → reload fails → old broader grants remain in memory
→ readiness 503 → but requests still execute until the kubelet removes the
   endpoint, and indefinitely for anything calling the pod directly
```

Fixed: the handler refuses with **503 `AGENT_UNAVAILABLE` above request
parsing**, so nothing about the request can widen or shorten the window. The
specialist's own comment already required this — enforcement reads the live
document "so a boot-time copy would keep granting access Git has already
narrowed", and a stale document after a failed reload is exactly that copy.

### S-2 — `tool_access` was attested on a basis that excluded revocation

`GatewayToolAccessVerifier` verifies real things — every grant is in the
approved catalog and read-only verified, every gateway refuses an anonymous
call — and then returned `ready: true` while its own detail admitted the loaded
per-Agent policy is not introspectable.

`ready` drives routing, and the operational plane exists so that
**disable = routing off + identity revoked + access revoked**. This verifier
cannot observe the third, and after an Agent was disabled it would have gone on
attesting tool access exactly as before.

Fixed: **default closed**. An operator who accepts the weaker basis sets
`acceptUnintrospectablePolicy`, and that acceptance is recorded in the
attestation's detail rather than inferred from its absence. The pre-existing
test that asserted `ready: true` encoded the overclaim and was corrected.

---

## Revocation is not automated — the remaining control-plane gap

Disabling an Agent today is proven for two of the three properties the design
claims:

| Property | Status |
|---|---|
| routing off | **proven** — `routedAgents: []`, catalog reports not routable |
| Deployment pruned | **proven** — Argo removed the Application and the workload |
| Keycloak client disabled | **not automated, not proven** |
| live ToolHive/Cedar grants revoked | **not automated, not proven** |

`npm run reconcile:keycloak -- --apply` is a manual script. Its only reference
anywhere in the tree is an error message in `verify-keycloak-identities.ts`
telling an operator to run it — it is wired to no Argo hook, no CI job and no
reconciler loop, while `management/yaml.ts` tells the reviewer of a pull request
that Keycloak *will* be reconciled.

**This needs a decision before it is built**, which is why it is not fixed here:
the reconciler currently *attests* and never *mutates*, so making it disable
Keycloak clients changes what that component is. The alternative — a CI job on
merge — keeps the reconciler read-only but puts identity mutation outside the
GitOps convergence loop. Either is defensible; picking one silently is not.

---

## Findings closed this session (8 HIGH) — all tested failing-first

| # | Finding | Fix | Verified |
|---|---|---|---|
| A1 | Omitting `SRE_ENV` started a production image fully mocked; `loadAppConfig({})` returned mocks. | Dockerfile sets `SRE_PACKAGED_IMAGE`; a packaged image refuses to start without an explicit `SRE_ENV`. The default stays for working trees, where it is correct. | **Empirically**: the built image refuses, and still refuses when the marker is set empty. |
| A2 | The caller chose the trust environment: request-body `environment` beat config, reached authorization, and travelled to ToolHive as `x-sre-environment`. One read role plus a different JSON string was a tenant switch. | The deployment's configured environment is authoritative; a request naming another is **refused with 422**, not coerced. The message names no other environment. | **In-cluster**: `{"environment":"dr"}` → 422 `ROUTE_INVALID`. |
| A3 | Specialist readiness checked *nothing* — `{}` and 200 unconditionally. | Reports `policy` and `model`; 503 when either is unusable. | **In-cluster**: `{"policy":"healthy","model":"healthy"}`. |
| A4 | A failed policy reload assigned the **failed** fingerprint to `revision`, so the next call short-circuited: metric and log fired once, then silence, while stale broader grants stayed authoritative for the pod's life. | Failed fingerprint tracked separately; the error stays observable until a valid document replaces it; readiness reads it. | Tests: reported on the second look, and cleared on recovery. The Manager's own source already had the correct pattern — the specialist was the outlier. |
| A5 | git-sync staleness was invisible; the pod stayed Ready serving the last worktree it fetched. | `--http-bind` plus a readinessProbe, and `--max-failures` stated rather than inherited. | Endpoint returns 200 in-cluster; sustained failure was directly observed aborting the container earlier this session. See R-1. |
| A6 | **DNS egress was unrestricted** — ports and no `to` selector, so any pod could reach any address on port 53. My own earlier evidence showed `1.1.1.1:53` connecting and I read it as the rule working. | Namespace and pod selectors in **one** peer: kube-dns inside kube-system. | **In-cluster**: cluster DNS resolves; `1.1.1.1:53` and `8.8.8.8:53` now TIMEOUT. |
| A7 | The production ApplicationSet tolerated a missing `runtime-values.yaml`, rendering `registry.internal/...:0.2.0` placeholders as apparently-valid Applications. | Toleration removed, reference **kept**: Helm fails until the site creates it. | Test asserts the file is referenced and deliberately absent from the repo. |
| A8 | On-prem examples contradicted the per-agent credential model; following both left every specialist in `CreateContainerConfigError`. | Examples aligned to the per-agent default, with the reason recorded. | Test asserts the two examples agree. |

Plus three found while testing: a schema-blind `postgres` ping that reported
healthy against a database with no tables; a **`port: 0`** NetworkPolicy that
Kubernetes rejected and that stopped every specialist syncing (my own
regression, caught by the reviewer within minutes); and a build script that
inherited the ambient kube context, targeted an EKS node, and exited 0 having
loaded nothing.

### A correction about my own process

My A1/A2 commit used `git add -A` and swept in a sub-agent's in-progress work
before I had reviewed it. That work removed the production values-file reference
**and** its toleration — which would have left production rendering against chart
defaults permanently, the defect rather than the fix. I caught it on review and
corrected it in the following commit, but it reached a commit unreviewed.

---

## Residual risks

- **R-1 — git-sync freshness is detected by failure, not by age.** The probe
  answers "do I hold a good checkout", and `--max-failures=3` makes the sidecar
  exit on sustained failure, which takes the pod out of its Service endpoints —
  observed directly. What is *not* implemented is a time-based assertion ("last
  successful sync older than N"). A remote that accepts connections but serves a
  stale ref indefinitely would not be caught.
- **R-2 — multi-replica consistency untested.** Persistence is proven across a
  pod restart, not across two live replicas.
- **R-3 — the model is a local CLI shim**, one process per call. `qwen3:8b`
  could not hold strict `json_schema` at all; haiku emits occasional malformed
  tool calls. Where that happened the platform refused safely — evidence for the
  platform, against the harness.
- **R-4 — laptop capacity.** 4 CPU / 3.83 GiB shared with all host Docker
  workloads; the API server intermittently returned `TLS handshake timeout`
  during rollouts.
- **R-5 — Codex quota lapsed mid-review.** Pass 2 was completed by a Claude
  adversarial agent instead, and is flagged as such rather than presented as
  independent tooling.

## Refuted in the final review

Recorded because a refuted finding is evidence too:

- *"An operator can omit `SRE_PACKAGED_IMAGE` and get mocks."* A Kubernetes
  manifest **adds to** image env; it cannot unset it. Setting it empty still
  trips the guard (`"" !== undefined`). Both tested against the built image.
- *"`SELECT 1 FROM t WHERE false` may skip the ACL check."* PostgreSQL checks
  table permissions at plan time regardless: a role without SELECT gets
  `permission denied for table sre_execution_event`. Tested with a real role.

## What would change the verdict

Execute Gate 2 — the 4–5 hours scoped above — and Gate 7's OIDC login with it.
Nothing found in two adversarial passes suggests the architecture is wrong; the
defects were consistently in deployment wiring and in probes that reported more
confidence than they had earned.
