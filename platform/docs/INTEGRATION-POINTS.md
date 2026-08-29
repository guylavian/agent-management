# Enterprise integration points

Items are ordered by gate. Mock results do not replace real-environment verification.

## Real local PoC execution (2026-08-28)

- BLOCKED: this execution environment cannot resolve `github.com`, so the pinned Prometheus MCP and ToolHive repositories could not be cloned.
- BLOCKED: this execution environment is denied access to `/Users/guylavian/.docker/run/docker.sock`, so Keycloak and Prometheus could not be started.
- BLOCKED: `.env.real-poc` with disposable local secrets and the real model/Wiki endpoints has not been supplied.
- BLOCKED: the configured/default real LLM (`127.0.0.1:11434`) and LLM Wiki MCP (`127.0.0.1:8642`) were not listening during the smoke attempt.
- Re-run `engineering/tools/prepare-real-poc.sh`, `engineering/tools/start-real-poc.sh`, and `engineering/tools/verify-real-poc.sh` in a normal local shell. A-D remain unpassed until the verifier emits real MCP citations.

## Gate 1 — identity and authorization

- TODO: Verify enterprise OIDC issuer, audience, group/role claim mapping, key rotation, clock skew, and token revocation behavior.
- TODO: Prove the supported user-bound token-exchange pattern across Runtime to ToolHive to MCP; confirm audit records identify two effective human principals rather than a shared runtime identity.
- TODO: Re-run AG-01, AG-02, and AG-03 with ToolHive gateway policy and read-only backend credentials.
- TODO: Confirm ToolHive denies unauthorized tools before an MCP backend call and exports correlated events to Splunk/QRadar.

## Gate 2 — evidence services

- RAG is intentionally outside the current PoC execution path; Wiki evidence comes from the shared LLM Wiki MCP.
- TODO: Validate real AD, OpenShift, Prometheus, Splunk, and network MCP schemas, response bounds, deadlines, retry ownership, and read-only backend roles.
- TODO: Validate the selected enterprise DLP boundary after deterministic local redaction.

## Models and observability

- TODO: Verify pinned vLLM structured-output syntax and tool parser for the mirrored Tier-S model.
- TODO: Select and pin a Tier-L candidate and repeat judge calibration against human review.
- TODO: Select the self-hosted observability backend and verify OTLP attribute acceptance and retention policy.

## Air gap and deployment

- TODO: Mirror and scan every lockfile artifact and the Node base image, then build with network disabled.
- TODO: Pin and mirror ToolHive operator/chart/images, MCP server images, vLLM images/model files, and retrieval model artifacts after enterprise selection.
- TODO: Validate default-deny OpenShift NetworkPolicies and non-root/read-only filesystem settings in the target cluster.
- TODO: Run the autocannon normal, burst, and mock-only storm profiles in a CI/dev runner that permits TCP listeners; this sandbox returns `listen EPERM`.

## Distributed deployment (architecture Rev 2.0)

- TODO: Stand up the enterprise token-exchange/delegation issuer (RS256) and verify `JwksDelegatedIdentityVerifier` against it; confirm audience-per-agent tokens and 60-second expiry are accepted by policy.
- TODO: Verify projected ServiceAccount token audience (`sre-agent-runtime`) is issued and validated by the cluster/internal OIDC; confirm rotation is observed (token re-read per call).
- TODO: Re-run Gate #1 across the full distributed path: two users through API → manager → specialist → ToolHive with distinguishable audit identities at every hop.
- Endpoints now resolve by convention from `deploy/environments/<env>/environment.yaml`; verify Service DNS matches `sre-agent-<name>` releases per namespace in a real cluster.
- TODO: Two-process HTTP smoke (manager + one specialist from the same image) in a runner that permits TCP listeners; the dev sandbox denies `listen` (EPERM).
- TODO: Verify one distributed trace (W3C context) across manager and specialist pods in the selected observability backend.
- TODO: Apply and test the per-agent NetworkPolicies on the target cluster, including the manager's denied ToolHive egress.

## Rev 2.1 remediation blockers

- INTEGRATION BLOCKER: enterprise RFC 8693 token-exchange endpoint for the Specialist → ToolHive credential. `RealTokenExchangeCredentialExchanger` is implemented but cannot mint enterprise credentials until the STS endpoint, workload subject-token source, and accepted `sre-toolhive:<server>` audiences are provisioned. Production token-exchange mode fails closed without `SRE_TOOL_CREDENTIAL_TOKEN_ENDPOINT`; the local PoC instead uses a real asymmetric signed-context key verified by ToolHive.
- INTEGRATION BLOCKER: ToolHive-side verification of the delegated credential (issuer/JWKS, audience, subject binding) must be configured to match the token-exchange output; re-run the Gate #1 Alice/Bob cases against real ToolHive audit.
- PENDING: real Tier-S/Tier-L endpoints to run the Track-2 real-model benchmark (`engineering/eval/real-benchmark.md`); wire the `SRE_EVAL_CORPUS` switch in `engineering/eval/run.ts` at that time.
- PENDING: real MCP `callTool` cancellation — verify the pinned MCP SDK forwards the AbortSignal/timeout to the transport against a live server; the runtime already passes it.
- DEFERRED (P2): MCP connection reuse/pooling and tool-schema TTL cache; measure discovery vs invocation latency against a real ToolHive before optimizing.
