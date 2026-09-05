---
description: Run the full verification pipeline (platform + portal) and report what passed, what failed, and what was left dirty
---

Run the verification gates for this repository and report honestly.

Platform, cheapest first — stop and report at the first failure rather than
running everything blind:

```bash
npm --prefix platform run typecheck
npm --prefix platform run lint
npm --prefix platform run validate:boundaries
npm --prefix platform run validate:tracked
npm --prefix platform run test
```

Portal — a separate Yarn workspace, not covered above:

```bash
cd platform/management/portal && yarn tsc
cd platform/management/portal/plugins/agent-management && yarn test --watch=false
cd platform/management/portal/plugins/agent-management-backend && yarn test --watch=false
```

Then, only if the above are green — this one WRITES files:

```bash
git status --short          # record the tree BEFORE
npm --prefix platform run check:generated
git status --short          # anything new was stale
```

Report:

- each gate: pass / fail, with the failing output for any that failed
- any file left modified in the working tree, and which generator owns it
- whether `$ARGUMENTS` (if given) was covered by these gates or needs something else

Do not summarise a gate you did not run. If a run was flaky, say that it was
flaky and that you could not reproduce it — do not round it up to a pass.
