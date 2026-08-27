# PoC decisions and document conflicts

Binding amendments supersede the source documents as follows:

| Topic | Conflict | Decision |
|---|---|---|
| HTTP framework | SDD/TDD select Express 5. | Fastify is pinned and kept at the API adapter boundary. |
| Runtime | SDD/TDD select Node 22 LTS. | Current LTS is pinned as Node 24.20.0. |
| Intent | SDD/TDD include procedural and ambiguous values. | Runtime intent contains only `factual` and `diagnostic`, derived deterministically. |
| Freshness | Architecture describes an optional reuse branch. | The PoC always refreshes live evidence and retains only session entities/request IDs. |
| 50-user load | SDD/TDD permit several non-production backends by default. | The harness refuses the storm profile whenever ToolHive mode is `real`; PoC storm runs use mock MCP only. |
| Answer field | Earlier drafts referenced answer drafts. | `summary` is the only specialist prose field. |

Deferred decisions: vector store, enterprise DLP integration depth, Tier-L production candidate, and observability backend.

## Distributed refactor (architecture Rev 2.0)

| Topic | Decision |
|---|---|
| Deployment model | One Deployment/Service per logical agent from one shared runtime image and one generic Helm chart (ADR-013). Base docs remain unmodified; Rev 2.0 deltas live in `architecture-rev2.md`, `poc-sdd-rev2.md`, `poc-tdd-rev2.md`. |
| Internal contract | Plain versioned HTTP (`internal/v1`), strict schemas, 64 KiB/512 KiB limits. No A2A, no bus, no orchestration engine (ADR-016). |
| Identity across the new hop | Dual credential: projected workload token + audience-bound delegated user JWT (≤60 s, request-ID and subject-hash bound). Mock authority is HS256 with an injected secret; production is RS256 + JWKS via enterprise token exchange (ADR-014). |
| Evidence contract | `Evidence.agentId` (required) added so contributor attribution survives the process boundary — a deliberate extension of TDD Rev 1 §4.4. |
| Manager production config | Fail-closed `loadAppConfig` still requires every client `real` in production, so manager pods set ToolHive/RAG env vars they never use; the manager process builds no such clients and NetworkPolicy denies the path. Chosen over weakening fail-closed validation. |
| Local/eval parity | `InProcessAgentClient` implements the exact internal-API admission semantics without a TCP listener; eval, adversarial, and dev flows run through it. |
| Environment authorization | An environment absent from the registry is now rejected before fan-out (explicit `AUTHZ_DENIED`, zero specialist executions) instead of routing and failing per-tool. |
