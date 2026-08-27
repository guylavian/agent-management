# Repository rules

- Security invariants are code, not prompts: startup configuration fails closed; visible tools equal YAML allowlist intersected with the approved catalog, user authorization, and environment policy; the Manager never receives tool schemas or payloads; `DomainHandoff.sanitizedFacts` accepts scalars only and is schema-enforced; deterministic secret redaction runs before untrusted content enters model context; fan-out uses `Promise.allSettled`, never `Promise.all`.
- If work appears to require workflow graphs, configurable loops, durable state, specialist-to-specialist calls, dynamic code execution, or write actions, stop and report the red line instead of implementing it.
- Runtime code enforces every tool-call, model-turn, deadline, context-byte, evidence-item, follow-up, agent, and round limit. Each limit requires a test.
- Committed code must compile, lint, and pass tests. `TODO` markers are allowed only in `docs/INTEGRATION-POINTS.md`.
- Errors use the TDD section 24 taxonomy. Security errors never disclose policy internals.
- Emit the TDD section 25 OpenTelemetry spans and attributes with a console/OTLP switch and the section 26 metrics. Metrics contain no user-identifying labels; traces use only `user.subject_hash`.
- Use conventional commits, one coherent step per commit, and tag completed phases `poc-t0` through `poc-t6`.
