# Real-model benchmark — status: PENDING (requires real Tier-S/Tier-L)

Two distinct evaluation tracks exist. Do not conflate their numbers.

## Track 1 — mock regression (implemented, runs offline)

`npm run eval` runs `eval/questions/cases.yaml` (60 cases × 8 runs) through the
distributed runtime with the deterministic `MockModelClient`. It validates
**harness and runtime behaviour**: routing plumbing, tool-selection wiring,
citation construction, evidence-gap disclosure, security controls, budgets.

Current mock result: `pass@1 = pass^8 = 0.983`, 0 tool-policy violations, all
SDD §22 targets pass. **This measures the runtime, not real model reliability.**
A deterministic mock cannot demonstrate that a 3–8B model selects tools or
routes correctly.

## Track 2 — real-model benchmark (PENDING external integration)

`eval/questions/real-benchmark.yaml` holds SRE questions with genuine
vocabulary collisions ("The cluster is down.", "Replication is broken.",
"Check the policy on the gateway.", "The certificate expired.", "Why is the
node not ready?"). It is meaningful only against the pinned Tier-S/Tier-L
models with guided JSON.

To run once the mirrored models are available:

```sh
SRE_CLIENT_LLM=real \
SRE_LLM_TIER_S_URL=http://vllm-tier-s.sre-models.svc:8000 \
SRE_LLM_TIER_L_URL=http://vllm-tier-l.sre-models.svc:8000 \
SRE_EVAL_CORPUS=eval/questions/real-benchmark.yaml \
SRE_EVAL_GRADER=tier-l \
npm run eval
```

Report, per question over ≥8 runs, keeping these SEPARATE from Track 1:

- pass@1, pass^8;
- semantically equivalent routing;
- missed domains, unnecessary domains;
- tool-selection accuracy;
- malformed tool-argument rate (from `sre_invalid_tool_arguments_total`);
- p50/p95 latency, GPU-seconds/request.

Until this runs, real small-model reliability is **UNVALIDATED**. See
`docs/INTEGRATION-POINTS.md`.

> Note: `eval/run.ts` currently pins the 60-case mock corpus. Wiring the
> `SRE_EVAL_CORPUS` switch above is a small harness change deferred until a real
> model endpoint exists to run it against — running it against the mock would
> just reproduce Track 1 under a different filename and imply coverage that is
> not there.
