---
name: verify-change
description: The verification pipeline for this repository — which gate to run, in what order, what each one actually proves, and how to read a failure. Use before committing, when a gate fails, or when asked whether a change is ready.
---

# Verifying a change

`npm --prefix platform run check` runs everything. Use it before committing.
When iterating, run the cheap gates first — the order below is by cost.

```bash
npm --prefix platform run typecheck            # ~5s
npm --prefix platform run lint                 # ~2s   oxlint
npm --prefix platform run validate:boundaries  # ~2s
npm --prefix platform run test                 # ~5s   vitest, ~480 tests
npm --prefix platform run check:generated      # slow, WRITES files
npm --prefix platform run validate:deploy      # slow, helm lint + template
```

The portal is a separate Yarn workspace and is NOT covered by the above:

```bash
cd platform/management/portal && yarn tsc
cd platform/management/portal/plugins/agent-management && yarn test --watch=false
cd platform/management/portal/plugins/agent-management-backend && yarn test --watch=false
```

## What each gate actually proves

- **typecheck** — includes `runtime-host/src/management/contract.ts`, which
  makes the compiler prove the runtime's projections satisfy the OpenAPI
  contract. A failure there means a view model and the contract disagree; fix
  the contract deliberately, then regenerate.
- **validate:boundaries** — external protocols have not leaked into
  `agent-engine` or `orchestrator`.
- **validate:tracked** — no credentials, dependencies or local state committed.
- **check:generated** — `gen:all` then `git diff --exit-code`. It **writes
  files**. If it fails, something generated was stale; commit the regenerated
  output rather than reverting it.
- **validate:deploy** — every rendered values file still produces a valid Helm
  release.

## Reading a failure

**`check:generated` left the tree dirty.** That is the point — it regenerated
something stale. Look at *what* changed:
- a rendered file deleted → its overlay is `enabled: false`; correct, commit it
- a `generated-types.ts` changed → the OpenAPI contract moved; commit it
- a rendered file added → an overlay was enabled without re-rendering

**A test writes to `deploy/`.** `tests/render-pipeline.test.ts` shells out to
the real renderer against the real repository, by design. If it leaves the tree
dirty, the repository was already out of sync — that is a finding, not test
pollution.

**Portal typecheck fails but platform passes.** The portal consumes generated
types from the contract. Run `npm --prefix platform run gen:management-api`.

## Before you say it is done

- Every new limit has a test. Non-negotiable — every tool-call, model-turn,
  deadline, context-byte, evidence-item, follow-up, agent and round limit.
- No `TODO` outside `docs/INTEGRATION-POINTS.md`.
- Conventional commit, one coherent step.
- If tests fail, say so with the output. Do not report completion on a partial
  pass, and do not describe a gate you did not run.
