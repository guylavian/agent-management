---
description: Diagnose why an Agent merged but is not visible, not in Argo, or not routable
argument-hint: <agent-name>
---

Diagnose the Agent named `$ARGUMENTS`.

Use the `diagnose-undeployed-agent` skill for the runbook, or delegate to the
`gitops-tracer` subagent if the chain needs walking end to end.

Stay read-only. Do not run `render:deploy` or `gen:all`, do not edit desired
state, and do not touch a cluster — the answer is a diagnosis, and the fix is
the user's call because it is almost always a pull request.

Report the first broken link with the file path or command that proves it, what
an operator would have seen instead of an error, and the smallest change that
unblocks it — saying clearly whether it belongs in a pull request (desired
state) or in local process configuration.
