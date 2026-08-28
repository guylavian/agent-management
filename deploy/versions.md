# Pinned PoC versions

| Component | Version | Decision |
|---|---:|---|
| Node.js | 24.20.0 | Current-LTS binding decision |
| npm | 11.7.0 | Workspace/package-lock tool |
| TypeScript | 7.0.2 | Compiler and type checker |
| Fastify | 5.12.1 | HTTP adapter |
| Zod | 4.4.3 | Runtime schemas and JSON Schema generation |
| MCP TypeScript SDK | 1.30.0 | Official MCP client |
| jose | 6.2.10 | OIDC JWT signing and validation |
| yaml | 2.9.0 | Agent/catalog YAML parser |
| pg | 8.22.0 | PostgreSQL session client |
| OpenTelemetry API | 1.9.1 | Instrumentation API |
| OpenTelemetry Node SDK/exporters | 0.221.0 | Trace/metric SDK and OTLP transport |
| OpenTelemetry trace SDK | 2.10.0 | Console span processor |
| Vitest | 4.1.11 | Unit/contract test runner |
| autocannon | 8.0.0 | Load harness |
| oxlint | 1.80.0 | Linter |
| tsx | 4.23.11 | TypeScript development launcher |
| @types/node | 24.13.3 | Node type declarations |
| @types/pg | 8.21.0 | PostgreSQL type declarations |
| Helm CLI | 3.18.3 | Offline chart lint/render tool |
| Container base | node:24.20.0-alpine3.22 | API build/runtime base |
| Keycloak | 26.6 | Local real identity backend and metrics source |
| Prometheus | 2.55.1 | Local real metrics backend |
| Prometheus MCP | v0.18.0 | Required upstream Prometheus MCP, built from its signed release tag |
| ToolHive | v0.28.3 | Required local MCP proxy/runtime, built from its release tag |

Vector store and RAG are not part of the active PoC. DLP integration depth, Tier-L deployment and the production observability backend remain deferred.
