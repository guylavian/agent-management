# Independent review remediation — 2026-09-02

## Run state

- Overall status: **BLOCKED BEFORE WP-0**.
- Repository branch at intake: `main` at `4af0541`, 4 commits ahead of and 12 commits behind `origin/main`.
- The intake worktree contains extensive pre-existing tracked and untracked user-owned changes. They have not been stashed, staged, committed, reset, or reformatted by this run.
- Git metadata is read-only in the current execution environment. Creating `review/2026-09-02-baseline` failed with `cannot lock ref` under `.git/refs/heads`.
- No work-package branch, worktree, implementation change, remediation commit, or Codex review has been created yet.

## Mandatory human actions and STOP items

1. **C1 secret rotation:** rotate the Groq key and Keycloak client secrets found in `platform/.env.real-poc`; the archive shared for review contained them. This run has not opened, printed, moved, or modified that file.
2. **Branching prerequisite:** provide `.git` write access and establish a reviewed, committed baseline for the current user-owned dirty worktree. A clean worktree created from `4af0541` would omit files and changes referenced by the review, including the operational-plane and execution-event work, so it is not an equivalent remediation base.
3. **WP-7 operational plane:** after the fail-closed option (b) is implemented, select whether to authorize option (a), a separately deployed `ROLE=reconciler` process with the three database roles.
4. **WP-10 decisions:** review ADR-017 and ADR-018 after drafting; no identity or environment-authorization strategy will be implemented in this run without that decision.

## Baseline evidence

The required intake command was run twice:

```text
cd platform && npm run check
PASS  typecheck
PASS  lint
PASS  validate:boundaries — 5 contract, 6 shared, 3 code components
FAIL  validate:tracked — 7 reported violations across 4 tracked paths
NOT RUN by the chained command: tests, engine check, YAML validation, generated check, deployment validation
```

The tracked-file violations are the three `dist/on-prem/*.tgz` build archives (each reported as both build output and archive content) and `deploy/on-prem/secrets.example.yaml` (reported as PEM private-key material). The example file was not printed or inspected during baseline diagnosis.

Read-only follow-up gates were run after the human instructed the run to continue:

```text
platform tests: 56 files passed, 2 skipped; 625 tests passed, 20 skipped
engine check: 7 files passed; 148 tests passed (lint emitted 3 existing unused-import warnings)
YAML validation: 1 file passed; 12 tests passed
deployment validation: FAIL — portal Helm template requires oidc.metadataUrl and the validation command supplies none
```

`check:generated` was not run because it writes generated files and the intake worktree is already dirty.

## Codex invocation

Installed CLI capability was confirmed with `codex exec --help`:

- non-interactive command: `codex exec`
- working directory: `-C, --cd <DIR>`
- read-only sandbox: `-s, --sandbox read-only`

Final review command form:

```sh
codex exec --sandbox read-only --cd "$(git rev-parse --show-toplevel)" "$(< /tmp/codex-review-wp-N.md)" \
  | tee docs/reviews/codex/wp-N-round-R.md
```

Codex is evidence-only: it remains read-only, does not edit or commit, and receives a written brief for every test-first and review round.

## Branch and worktree strategy

### Preconditions

1. The owner commits or otherwise establishes the current reviewed worktree as one immutable baseline commit without the tracked archives or credential material. This preserves the user-owned work while avoiding an invented clean base that differs from the reviewed code.
2. `cd platform && npm run check` passes from that commit. The portal Helm validation fixture must supply a non-secret test OIDC metadata URL; production fail-closed validation must remain unchanged.
3. Git metadata is writable. Worktrees are created under a task-specific temporary directory, never inside the repository and never from an unresolved path.

### Topology

Use an integration branch `fix/2026-09-02-remediation` at the reviewed baseline. Each WP branch starts from the integration branch state that contains all required predecessor WPs. A dedicated worktree isolates each implementation agent from the intake worktree and from other agents.

```text
reviewed baseline
└── fix/2026-09-02-remediation
    ├── fix/wp-0-governance
    │   └── integrate WP-0
    ├── fix/wp-1-secrets-identity
    │   └── integrate WP-1
    ├── fix/wp-2-credential-lifetime  ─┐
    ├── fix/wp-3-http-correctness      ├─ disjoint worktrees; serial integration
    ├── fix/wp-4-engine-arguments      ┘
    ├── fix/wp-5-grounding
    ├── fix/wp-6-mcp-lifecycle
    ├── fix/wp-7-durable-runs
    ├── fix/wp-8-orchestrator-correctness
    ├── fix/wp-9-doc-truth
    └── fix/wp-10-identity-adrs (may be drafted in parallel; integrated last)
```

WP-2, WP-3, and WP-4 may be implemented concurrently only in separate worktrees. Their declared scopes are not fully disjoint at integration boundaries: WP-3 consumes WP-4 reload state, while `dependencies.ts` has WP-1/WP-4/WP-7 changes. Therefore they are rebased and integrated serially in the order WP-2, WP-4, WP-3, resolving only named integration seams. WP-5 follows those integrations. WP-6 follows WP-5 because both name `agent-engine/src/runner/loop.ts`. WP-7 follows WP-6 because `dependencies.ts` is serialized. WP-10 is documents-only and may run concurrently from the reviewed baseline, but its final rebase occurs after WP-9 to avoid documentation conflicts.

### Worktree lifecycle

For each work package, the integrator resolves and validates the exact target path before running commands equivalent to:

```sh
git branch fix/wp-N-slug fix/2026-09-02-remediation
git worktree add <validated-task-temp-dir>/wp-N fix/wp-N-slug
```

The subagent receives the absolute worktree path and the Appendix B.1 brief. It does not switch branches or commit. The integrator reviews the diff, runs required repository agents and Codex rounds, runs `.claude/skills/verify-change`, commits on the WP branch, then integrates with a non-amended commit. Worktrees are removed only after their branches are integrated and all material changes are committed.

### Test-first and review discipline

- WP-1, WP-2, WP-4, and WP-5 receive Codex-authored `*.adversarial.test.ts` tests before implementation. The tests must fail against that WP's pre-fix branch state for the intended reason.
- Every finding is linked below to an owning test. An empty test cell means implementation has not started, not that testing is waived.
- Every WP writes `/tmp/wp-N.diff` and `/tmp/codex-review-wp-N.md`, then saves the complete read-only review under `docs/reviews/codex/`.
- `BLOCK` findings are fixed or rebutted in this document. A third unresolved CRITICAL/HIGH block triggers the required human STOP.
- No reviewed commit is amended. Follow-up changes are new commits.

## Finding tracker

| ID | status | branch | commit | test(s) | codex verdict | notes |
|---|---|---|---|---|---|---|
| C1 | BLOCKED ON HUMAN | `fix/wp-0-governance` | — | human rotation evidence | N/A | Rotate the exposed Groq key and Keycloak client secrets; prohibited file not inspected. |
| C2 | PLANNED — WP-1 | `fix/wp-1-secrets-identity` | — | — | — | Per-mode secrets and subject-bound workload identity. |
| C3 | PLANNED — WP-0 | `fix/wp-0-governance` | — | — | — | Purge placeholder agents and add the deterministic production gate. |
| H1 | ADR DRAFT — WP-10 | `fix/wp-10-identity-adrs` | — | ADR test plan | N/A | Human identity absent from workload-client strategy; implementation requires a decision. |
| H2 | ADR DRAFT — WP-10 | `fix/wp-10-identity-adrs` | — | ADR test plan | N/A | RFC 8693 subject-token and issuer strategy requires a decision. |
| H3 | ADR DRAFT — WP-10 | `fix/wp-10-identity-adrs` | — | ADR test plan | N/A | Shared signer versus per-agent binding requires a decision. |
| H4 | PLANNED — WP-3 | `fix/wp-3-http-correctness` | — | — | — | Readiness and real desired-state revision. |
| H5 | PLANNED — WP-7 | `fix/wp-7-durable-runs` | — | — | — | Choose the existing event model if it supports run records; otherwise bound and disclose in-memory history. |
| H6 | PLANNED — WP-3 | `fix/wp-3-http-correctness` | — | — | — | Session failures become degraded evidence gaps rather than query failure. |
| H7 | PLANNED — WP-2 | `fix/wp-2-credential-lifetime` | — | — | — | Expiring tool credentials refresh before use. |
| H8 | PLANNED — WP-6 | `fix/wp-6-mcp-lifecycle` | — | — | — | Bounded MCP client pool and discovery TTL. |
| H9 | PLANNED — WP-2 | `fix/wp-2-credential-lifetime` | — | — | — | Workload-token cache and authorization-failure refresh. |
| H10 | PLANNED — WP-7 / HUMAN STOP | `fix/wp-7-durable-runs` | — | — | — | Implement fail-closed option (b); option (a) requires approval. |
| H11 | PLANNED — WP-5 | `fix/wp-5-grounding` | — | — | — | Consume grounding in engine and synthesis. |
| H12 | PLANNED — WP-3 | `fix/wp-3-http-correctness` | — | — | — | Implement disconnect cancellation. Rate limiting remains a tracked proposal, not an implementation. |
| H13 | PLANNED — WP-4 | `fix/wp-4-engine-arguments` | — | — | — | Coerced arguments, formats, bounded validator LRU, reload signal. |
| M1 | ADR DRAFT — WP-10 | `fix/wp-10-identity-adrs` | — | ADR test plan | N/A | Environment-scoped authorization requires a decision. |
| M2 | PLANNED — WP-8 | `fix/wp-8-orchestrator-correctness` | — | — | — | Enforce Manager routing timeout. Configurable loops remain prohibited; no general loop is added. |
| M3 | PLANNED — WP-8 | `fix/wp-8-orchestrator-correctness` | — | — | — | Deterministic multi-specialist non-escalated response. |
| M4 | PLANNED — WP-8 | `fix/wp-8-orchestrator-correctness` | — | — | — | Round-2 rejection evidence becomes synthetic result evidence. |
| M5 | PLANNED — WP-8 | `fix/wp-8-orchestrator-correctness` | — | — | — | Redacted, bounded scalar handoff facts. |
| M6 | PLANNED — WP-4 | `fix/wp-4-engine-arguments` | — | — | — | Reload error hook, readiness state, structured log, and counter. |
| M7 | PLANNED — WP-1 | `fix/wp-1-secrets-identity` | — | — | — | Namespace-label-based Manager data-plane exclusion. |
| M8 | PLANNED — WP-3 | `fix/wp-3-http-correctness` | — | — | — | Correct runtime error taxonomy and status mappings. |
| M9 | PLANNED — WP-8 | `fix/wp-8-orchestrator-correctness` | — | — | — | Conflict extraction boundaries and false-positive exclusions. |
| M10 | ACCEPTED / LATER | — | — | — | N/A | Outside this remediation run per Appendix A. |
| M11 | ACCEPTED / LATER | — | — | — | N/A | Outside this remediation run per Appendix A. |
| M12 | ACCEPTED / LATER | — | — | — | N/A | Outside this remediation run per Appendix A. |
| M13 | PLANNED — WP-3 | `fix/wp-3-http-correctness` | — | — | — | Drain listener, stop monitors/views, and close pools. |
| M14 | PLANNED — WP-7 | `fix/wp-7-durable-runs` | — | — | — | Verify session expiry handling against `001_sessions.sql`; add retention if absent. |
| M15 | PLANNED — WP-9 | `fix/wp-9-doc-truth` | — | — | — | Rewrite false claims and dead paths to post-fix truth. |
| M16 | ACCEPTED / LATER | — | — | — | N/A | Outside this remediation run per Appendix A. |
| M17 | ACCEPTED / LATER | — | — | — | N/A | Outside this remediation run per Appendix A. |
| M18 | PLANNED — WP-1 | `fix/wp-1-secrets-identity` | — | — | — | Production delegation key becomes file-only. |
| L1 | ACCEPTED / LATER | — | — | — | N/A | Outside this remediation run per Appendix A. |
| L2 | ACCEPTED / LATER | — | — | — | N/A | Outside this remediation run per Appendix A. |
| L3 | ACCEPTED / LATER | — | — | — | N/A | Outside this remediation run per Appendix A. |
| L4 | PLANNED — WP-4 | `fix/wp-4-engine-arguments` | — | — | — | `ajv-formats` version and mirror documentation. |
| L5 | ACCEPTED / LATER | — | — | — | N/A | Outside this remediation run per Appendix A. |

## Recorded proposals

### Production deployment approval

Alternative for later schema review: add an `approvedBy` field to the deployment overlay schema, require it for production enablement, and validate it against reviewed approval identities. It is not implemented in WP-0 because doing so would make approval metadata a runtime-consumed schema concern and could create a second authority alongside the committed owner allowlist. The deterministic quality-and-owner gate remains WP-0's implementation target.

### API rate limiting

H12's disconnect cancellation belongs in WP-3. Rate limiting should be designed separately at the authenticated API boundary with an explicit identity-safe key, bounded storage, proxy/header trust rules, deployment topology, and stable taxonomy response. Adding an ad hoc per-process counter in WP-3 would create replica-dependent behavior and is therefore only recorded here.

## Codex disagreements and rebuttals

None. No Codex review round has run.

## Summary

The remediation implementation has not started. Findings closed: 0. Findings open: all WP-scoped findings. Findings blocked on a human: C1, the WP-7 reconciler deployment decision, and the WP-10 ADR decisions. Current test-count delta and evaluation metric delta are not yet available. The intake baseline is red as recorded above, and Git metadata permissions currently prevent the required branch, worktree, and commit workflow.
