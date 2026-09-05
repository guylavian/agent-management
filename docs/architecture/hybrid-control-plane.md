# Hybrid control plane: the approved envelope

Git is the **approval boundary**. PostgreSQL is the **operational control
plane**. The split is not "policy vs operations" — that framing is what let a
first draft of this document put `lifecycle` and `capabilities` on the wrong
side. The split is by **effect**.

## The governing rule

> A DB-only change may **reduce** availability or privilege. It must never be
> able to **increase** routability, tool/MCP access, identity privilege,
> user-data exposure to a specialist, or model/prompt authority, beyond what the
> reviewed approval boundary has already granted.

**"Beyond the envelope", not "beyond the current state."** An earlier draft of
this document said the DB may only move authority *down*, which is not what is
built and not what is wanted: every reversible narrowing is, on its reverse
edge, an increase relative to the moment before. Resuming a suspended Agent
raises its effective routability. So does restoring a withheld environment.

That reversal is deliberate, and it is the whole reason suspension can be
instant: an operator will only reduce privilege in an incident if they know they
can restore it without a review cycle. What must be impossible is exceeding the
envelope, and — separately — turning a **never-approved** Agent into a running
one. Those are two different guarantees and §4.1 handles the second.

Authority is a partial order. Git moves it in either direction, under review.
The DB moves it only **within the bounds Git has already approved**.

    effective = approvedEnvelope  ⊓  operationalState  ⊓  observedReadiness
                (Git, reviewed)      (DB, narrowing)      (measured, not authored)

`⊓` is a meet: every term can only narrow the one before it.

## The invariant that makes this safe

**Expansion is unrepresentable, not merely forbidden.**

The DB schema has no column for `access`, `capabilities`, `exclusions`,
`description`, `displayName`, `prompt`, `identity`, `model`, `environments`,
`requiredRoles` or `discovery`. Not "validated on write" — *absent*. A DB
compromise, a rogue migration, a mistaken `UPDATE` or a confused service cannot
express a privilege increase, because there is nowhere to write one.

This follows the repository's standing rule that security invariants are code,
not prompts. A check can be bypassed or forgotten. A missing column cannot.

Two corollaries:

- **The DB never stores a copy of the approved spec.** It references an Agent by
  name and nothing more. There is therefore no such thing as a stale approved
  version pinned in the DB: the envelope is always read live from Git, so a
  narrowing that merges while an Agent is suspended applies the moment it
  resumes.
- **The narrower result wins.** Saying "Git always wins" would be wrong: the DB
  wins precisely when it narrows, which is its entire purpose. For everything
  Git expresses that the DB does not, there is no conflict to resolve.

---

## 1. Field classification, by effect

### Reviewed in Git — can increase authority

| Field | What an increase would grant |
|---|---|
| Agent creation, `metadata.name` | The identity itself. `clientId` and the ToolHive audience derive from the name, so a rename is a new principal. Immutable after creation. |
| `spec.access[]` | The tool grant. The entire authorization surface. |
| `spec.identity` | The workload identity tokens are minted for. |
| `spec.authorization.requiredRoles` | **Removing** a role widens who may invoke the Agent. |
| `spec.prompt` (body and path) | Directs every tool the Agent already holds: which calls, which arguments, how much is retrieved, what is revealed. Read-only prevents mutation, not disclosure. |
| `spec.routing.capabilities` | **Routing metadata is security-sensitive.** See §2. |
| `spec.routing.exclusions` | Removing an exclusion widens what the Agent is offered. |
| `metadata.description`, `metadata.displayName` | Both reach the Manager. `description` falls back to `displayName`, so `displayName` is routing metadata too. |
| `spec.environments` | **Adding** one makes the Agent routable for an estate it could not previously see. |
| `spec.model` (`tier`, `profile`) | Moves the question, the retrieved evidence and the prompt to a different served model — different provider, residency and retention. |
| `spec.discovery.allowedNeedsDomains` | **Adding** an edge creates a new evidence path between domains. |
| `spec.execution.*` | **Raising** a budget increases bulk-extraction capacity and cost/DoS surface. |
| `spec.security.readOnly` | Pinned to `true` by the schema. A write Agent is a red line, not a setting. |
| Deployment eligibility (`enabledEligible`) | The reviewed statement that this Agent *may* run in this environment. First activation only — see §4.1. |

### DB-owned — cannot increase anything

| Field | Direction |
|---|---|
| `suspended` (+ `suspendedBy`, `suspendedAt`, `reason`) | Narrows. Removes from the catalog immediately. |
| `replicaCeiling` | Narrows, bounded above by the approved overlay. `0` is equivalent to suspended. |
| `environmentsWithheld` | Narrows: a subset of the approved `environments`, subtracted. Cannot add one. |
| Observed runtime health, readiness, last-seen | Measured, never authored. |
| Argo reconciliation state and sync/health | Measured. |
| Request/lifecycle progress events | Records what happened. Grants nothing. |
| Failure and degraded state | Measured. |
| Operational telemetry and timestamps | Measured. |

Every DB field above is either a **subtraction from** the approved envelope or an
**observation of** the world. Neither can construct authority.

### Analysed individually, because "operational" is not a safety argument

The rule says not to assume. So:

- **`metadata.owner` — REVIEWED.** Ownership is a candidate input to who may
  operate an Agent in the portal. If it ever gates that, a DB write would be a
  transfer of control. Cheap to review, and the alternative is a latent RBAC
  bypass that appears the day ownership becomes load-bearing.
- **`replicas` — DB, bounded.** More replicas is more concurrency, not more
  authority; each tool call is authorized identically. But it is bounded by the
  approved overlay, because `0 → N` is otherwise an un-reviewed resurrection.
- **`spec.model` — REVIEWED.** Not because a profile is a credential (it is not;
  endpoints and keys live in a Secret), but because it decides *where the data
  goes*. A profile swap is a residency and retention change.
- **`spec.environments` — REVIEWED to add, DB to withhold.** Asymmetric, like
  everything else here.
- **`spec.lifecycle` — REVIEWED to activate.** See §6. This is the field the
  first draft got wrong.

---

## 2. Threat rationale

**Routing metadata is a disclosure channel that precedes authorization.**

`ManagerRouter.selectAgents` (`orchestrator/src/routing/manager.ts:59-75`) sends
the model one message containing the user's question, the extracted entities,
and every offered specialist's `id`, `description`, `capabilities` and
`exclusions`. The Manager then dispatches the question — and the conversation
context — to whichever specialist it picks.

That happens **before** any MCP call, so before Cedar, before ToolHive, before
any tool authorization runs at all. An Agent that advertises "payroll" or
"security incidents" receives questions about them. It cannot exceed its own
tools, but it has already been handed the question and the context, and that is
the disclosure. Cedar cannot protect a channel it never sees.

Capability text is also **model input**, so it is an injection surface against
the Manager itself — an instruction dressed as a capability description.

That is why `capabilities`, `exclusions`, `description` and `displayName` are
all on the reviewed side, despite looking like documentation.

**Latent grants are real grants.** "The permission was already merged" is not a
safety argument. A `draft` Agent with `access[]` to a sensitive MCP is an
approved *envelope*, not an approved *deployment*. Activation is the moment the
grant becomes effective, so activation is the moment that needs review.

---

## 3. The approved envelope

Git declares the maximum:

```yaml
# config/agents/kafka.yaml  (reviewed)
spec:
  lifecycle: active            # eligible to run
  environments: [prod, dr]     # may be routable in these
  routing:
    capabilities: ["Kafka broker and consumer-group health"]
  access:
    - mcp: kafka
      tools: [describe_topic, list_consumer_groups]
  execution: { maxToolCalls: 6 }
```

The DB operates strictly inside it:

```sql
-- one row per ACTIVATED agent; note what is ABSENT, and that existence matters
agent_operational_state (
  agent_name            text primary key,          -- reference only, never a copy
  activated_at          timestamptz not null,      -- written by the reconciler
  suspended             boolean not null default false,
  suspended_reason      text,                      -- convenience, NOT the audit trail
  suspended_by          text,                      -- convenience, NOT the audit trail
  suspended_at          timestamptz,
  replica_ceiling       integer not null default 0
                          check (replica_ceiling >= 0),  -- clamped to the overlay on READ
  environments_withheld text[] not null default '{}'
)
```

`NOT NULL` on `replica_ceiling` matters: a nullable column makes the first
`NULL → 1` update indistinguishable from an activation. There is no null to
promote.

There is no `access`, no `capabilities`, no `prompt`, no `model`, no
`identity`, no `required_roles`. That absence is the control.

Resolution is a narrowing fold, and it reads the envelope live:

```
routable(agent, env) =
      approved.lifecycle == active
  AND approved.enabledEligible(env)
  AND env ∈ approved.environments
  AND env ∉ db.environmentsWithheld
  AND NOT db.suspended
  AND db.replicaCeiling > 0
  AND db.rowExists                                    // a reviewed activation, §4.1
  AND observed.runtimeReady        @ envelopeDigest    // positive evidence, never assumed
  AND observed.identityReconciled  @ envelopeDigest    // stale digest reads `unknown`
  AND observed.toolAccessReconciled@ envelopeDigest
```

Every DB term appears **negated or as a lower bound**. There is no arrangement
of DB values that adds a term.

---

## 4.1 First activation is not resume

Suspension and resume are reversible *within* an envelope. Turning an Agent that
has **never** run into one that runs is not a resume, and the schema must be
able to tell them apart. Otherwise an Agent that becomes Git-`active` while a
row already says `suspended` would be activated for the first time by a DB
write — the latent-grant path, arriving through the back door.

**The row's existence IS the reviewed activation.**

- A missing row means **never activated → not routable**. Fail closed, on every
  resolver and cache path without exception.
- `agent_name` and `activated_at` are **immutable**. Without that, an `UPDATE`
  could repurpose an existing row onto a never-activated Agent — first
  activation through the side door. Enforced by column-level `GRANT` (the API's
  role holds `UPDATE` on the operational columns only) plus a trigger that
  rejects any change to either.
- Only the reconciler creates a row, and only on observing that Git says
  `lifecycle: active` and `enabledEligible` for this environment. It is a
  projection of a reviewed fact, not an operator action.
- The management API can `UPDATE` a row. It cannot `INSERT` one. That is a
  database GRANT, not a code path — the API's role holds no `INSERT` on this
  table.
- Deleting a row therefore removes routability. Deletion is denial of service,
  never a bypass.

So an operator may suspend and resume freely, and can never perform a first
activation.

To be precise about where the safety comes from: it is the **conjunction** with
live Git `active + enabledEligible`, not the row by itself. A row for an Agent
Git does not approve resolves to not-routable. The row is a necessary condition,
never a sufficient one.

## 4.2 Observations are bound to the envelope they were made against

`runtimeReady`, `identityReconciled` and `toolAccessReconciled` are the terms
that let an Agent route. As plain booleans they are a resurrection path: narrow
`access[]` in Git while an Agent is suspended, resume it, and a stale
`toolAccessReconciled = true` blesses a pod, a Keycloak client and a Cedar
policy that all still reflect the OLD envelope.

Every observation therefore carries the **envelope digest it was made against**:

```
observed_readiness (
  agent_name       text not null,
  envelope_digest  text not null,   -- sha256 of the resolved Git envelope
  ready            boolean not null,
  observed_at      timestamptz not null
)
```

Resolution compares that digest to the digest of the envelope being resolved
*now*. A mismatch is **`unknown`, not `ready`** — which fails closed, because
routability requires positive evidence. Stale evidence is no evidence.

**What the stamp must cover**, or it is theatre:

- the fully RESOLVED spec — canonical document plus overlay plus defaults
- **prompt contents, not the prompt path**
- identity, access, requiredRoles, routing text (capabilities, exclusions,
  description, displayName), environments, eligibility, model destination,
  discovery edges, execution and resource ceilings, `readOnly`
- the environment/cluster the observation was made against
- the generation of the rendered runtime, Keycloak and Cedar artifacts the
  observation actually looked at

**A content digest alone is not enough.** `A → B → A` returns the original
digest, so an observation from the first `A` silently becomes valid again for
the second. The stamp is therefore `(envelopeGeneration, contentDigest)`, where
the generation is the monotonic commit identity that produced the envelope.
Equal content at an older generation is stale.

Observations also **expire**. One older than its freshness window reads
`unknown`, so a reconciler that stops running degrades the estate to
not-routable rather than leaving it permanently blessed.

This also closes the "stale approved version" question from the other side: the
DB stores no copy of the envelope, only a stamp, which cannot reconstruct one.

## 4.3 Two trust domains, two roles

An observation that any operational writer can set is not an observation.

| Table | Written by | Grants |
|---|---|---|
| `agent_operational_state` | management API (`UPDATE` only) | narrowing within the envelope |
| `observed_readiness` | reconciler only | nothing; read as evidence |
| `agent_request_events` | management API (`INSERT` only, append-only) | nothing; the audit record |

Audit evidence comes from the event log, **not** from `suspended_by` /
`suspended_at` / `reason`. Those are mutable convenience columns on a mutable
row; treating them as the audit trail would mean trusting a writer to record its
own actions truthfully.

Stated honestly: `INSERT`-only application privilege makes that log append-only
**against the application**, not against the table owner, the migration role or
a DBA. Tamper-evidence against those requires shipping events off-box — to the
OpenTelemetry pipeline this platform already emits to — which is where the
durable audit actually lives. The table is a queryable convenience, not the
system of record.

### The reconciler is in the trusted computing base

An earlier revision of this document claimed observations "grant nothing".
**That was wrong.** Row existence and positive observations are authorization
gates: together with the envelope, they are what makes an Agent routable. The
reconciler writes both.

Compromising it grants first activation of any Agent Git already marks active
and eligible, forged readiness/identity/tool-access evidence, and therefore
routing of user context to a workload that is absent, stale or wrongly
privileged. It cannot invent an envelope — no new tool, capability, role or
model — but within the set of Git-approved Agents it is decisive.

That is inherent: anything able to activate a workload must be trusted to
activate workloads. So it is named here rather than hidden, and bounded by
splitting the role in two — one identity that creates rows (activation), a
separate identity that writes attestations — so one stolen credential cannot
both activate an Agent and vouch for its readiness.

## 4.4 Fail-closed defaults

Every ambiguous case resolves to *not routable*:

| Case | Resolution |
|---|---|
| Operational row missing | Not routable (never activated) |
| `replica_ceiling` null or negative | Rejected by `NOT NULL` + `CHECK (replica_ceiling >= 0)`; a row that somehow violates it is treated as `0` |
| `environments_withheld` contains an unknown name | Ignored — it can only ever subtract |
| Observation digest ≠ current envelope digest | `unknown` → not routable |
| No observation row at all | `unknown` → not routable |
| Git envelope unreadable | **Fail closed for anything that widens.** Already-routable Agents keep serving from the last validated envelope for a bounded staleness window; no activation, no resume and no un-withhold resolves from it. Serving a pre-revocation envelope to a resume request is stale-authority resurrection — the exact case §4.2 exists to stop. Past the window, resolution reports `unknown` and the estate empties. |
| DB unreachable | Not routable. The Manager loses the estate rather than routing on an unverified envelope |

The DB being unreachable meaning "route nowhere" is a deliberate availability
cost. The alternative — falling back to Git alone — would silently discard every
suspension, which is exactly the state an operator reached for in an incident.

## 5. Allowed DB transitions

| Transition | Why it is safe |
|---|---|
| `suspended: false → true` | Strictly reduces. Removes from the catalog on the next read. |
| `suspended: true → false` | Resumes **within the current envelope**, re-evaluated live, and only for a row that a reviewed activation created (§4.1). If Git narrowed or revoked eligibility meanwhile, resume grants nothing — the envelope decides. Readiness must be re-observed against the *current* digest before it routes (§4.2). |
| `replicaCeiling: N → 0` | Equivalent to suspend. |
| `replicaCeiling: 0 → N`, `N ≤ approved` | Capacity within an already-approved envelope. Clamped on read, not merely on write. |
| `environmentsWithheld += env` | Narrows reachability. |
| `environmentsWithheld -= env` | Restores only an environment Git still approves; the intersection with `approved.environments` is taken on every read. |
| Any observed-state write (reconciler role only) | Records the world, stamped with the envelope digest. Grants nothing on its own. |
| Any request/progress event | Records what happened. Grants nothing. |

**Asymmetry is deliberate.** Suspending is instant because reducing privilege in
an incident must never wait for a review cycle. Resuming is instant *only*
because it cannot exceed an envelope that was already approved — and if that
envelope has since shrunk, resume silently resumes less.

## 6. Reviewed transitions (Git, pull request)

| Transition | Why review |
|---|---|
| Create an Agent | Establishes the envelope and the identity. |
| `lifecycle: draft → active` | **Activates latent access.** The grant existed; this makes it effective. |
| First `enabledEligible` in an environment | Makes a never-routable Agent routable there. |
| Add or widen `access[]` | The grant. |
| Change `identity` | The principal. |
| Remove a `requiredRoles` entry | Widens who may invoke. |
| Add a capability, remove an exclusion | Widens what the Manager offers it, and therefore what it is told. |
| Change `description` / `displayName` | Same channel, same reason. |
| Change the prompt | Redirects existing tools. |
| Add an `environments` entry | New reachable estate. |
| Change `model.profile` / `tier` | New destination for the data. |
| Add a `discovery.allowedNeedsDomains` edge | New cross-domain evidence path. |
| Raise any `execution` budget | More extraction capacity per request. |
| Raise the approved replica or resource ceiling | Raises the bound the DB is clamped to. |

## 7. Forbidden escalation paths, and what blocks each

| Attempt (DB write only) | Blocked by |
|---|---|
| Activate a `draft` Agent holding a sensitive merged grant | No `lifecycle` column. Activation is a Git transition. |
| Advertise `capabilities: ["payroll"]` to attract sensitive questions | No `capabilities` column. |
| Change `displayName` to smuggle routing text via the `description` fallback | No `displayName` or `description` column. |
| Add `prod` to `environments` to reach production systems | `environmentsWithheld` can only subtract; the resolver intersects with the approved list. |
| Grant an extra MCP tool | No `access` column. |
| Drop `requiredRoles` so any user may invoke | No `required_roles` column. |
| Swap `model.profile` to exfiltrate to another provider | No `model` column. |
| Rewrite the prompt to widen retrieval | No `prompt` column. |
| Scale `replicas` 0 → 50 to resurrect a revoked Agent | Clamped to the approved overlay **on read**; revoked eligibility makes the ceiling irrelevant. |
| Un-suspend an Agent whose Git envelope was revoked while it was suspended | The envelope is read live, never pinned. Resume yields nothing. |
| Pin an older approved spec version in the DB to keep a since-removed grant | The DB stores no spec. There is no version to pin. |
| A DBA sets every row to `suspended = false` | Each Agent resumes only to its own current envelope, and only if a reviewed activation created the row. Worst case is availability the envelope already permits — never new authority. |
| A DBA `INSERT`s a row for a never-approved Agent | The envelope still gates it: `lifecycle` and `enabledEligible` come from Git, and a row for an Agent Git does not approve resolves to not-routable. |
| A DBA forges `suspended_by` / `reason` to hide an action | Audit is the append-only event log, not these columns (§4.3). |
| `DELETE` the operational row to shed a suspension | A missing row is *not routable*, not permissive (§4.1). |
| Resume with stale reconciliation after Git narrowed the grant | Observations are digest-bound; a mismatch reads `unknown` and fails closed (§4.2). |
| Write conflicting Git and DB state | The DB expresses only narrowing terms, so "conflict" is not representable; the narrower value wins by construction. |

## 8. Residual risk, accepted and named

Calling the remainder "availability" would understate it. What the management DB
role genuinely holds:

- **Undoing incident containment.** Resuming a suspended Agent restores its
  exposure to user questions and context. When the suspension was a response to
  a live incident, un-suspending is a **confidentiality** decision, not merely
  an availability one. It stays inside the envelope, so it is bounded — but it
  is not harmless.
- **An accountability gap.** A direct `UPDATE` against the table bypasses both
  the event the API would have inserted and the span the API would have emitted.
  Audit that depends on the writer choosing to record itself is not audit.

The second is fixable and must be fixed in the implementation: the audit event is
written by the **database**, not by the application's good behaviour — a trigger
on `agent_operational_state` writing to a transactional outbox, drained to
OpenTelemetry. Then any path that changes the row produces a record, including
one that never went through the API.

The first is inherent to giving anyone an instant suspend, which is a trade this
platform makes deliberately: an operator who cannot restore service without a
review cycle will hesitate to contain an incident at all. It is bounded by the
envelope, recorded by the outbox above, and scoped by keeping the management
role's write surface to the narrowing columns only.

**Not in scope of this model:** a DBA, the table owner, or the migration role.
Anyone who can rewrite grants and triggers is outside any boundary the schema
can draw, and pretending otherwise would be the kind of claim this document
exists to avoid.

---

## Request flow

Reusing the existing Runs/Requests `ExecutionEvent` model rather than inventing
a second tracing system.

Reviewed change:

    Requested → Pending Approval → PR Opened → Approved/Merged
              → Access Reconciled → Runtime Ready → Active

Operational change, inside the envelope:

    Requested → Desired State Saved → Runtime Ready → Active

Suspend, which must not wait for anything:

    Requested → Suspended (immediate) → Removed from catalog

The portal presents one Agent experience. Git surfaces only when a change needs
approval — and then it surfaces honestly, with the pull request linked and the
reason it was required.
