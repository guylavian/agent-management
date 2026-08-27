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
