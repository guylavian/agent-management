# Monorepo layout

Two toolchains, deliberately kept apart.

```
/
├── apps/
│   ├── api/          execution plane — Manager and Specialist runtime (npm workspace)
│   └── portal/       management plane — Backstage 1.54 (its own yarn workspace)
├── packages/         shared TypeScript, npm workspaces
│   ├── agent-schema/          THE canonical Agent definition (zod)
│   ├── config/                loading + semantic validation; re-exports agent-schema
│   ├── auth/                  OIDC, delegation, workload credentials, authorization
│   ├── mcp/                   ToolHive client, tool filter, argument validation
│   ├── runtime/               request execution, specialist loop, round 2
│   ├── routing/               manager routing
│   ├── evidence/              typed evidence, redaction, budgets
│   ├── keycloak-provisioning/ desired state + idempotent reconciler
│   ├── management-api/        read-only projections, run graph, GitOps
│   ├── llm/  session/  telemetry/  agent-client/  agent-protocol/  agent-registry/  rag/
├── agents/           Agent documents + service registry (source of truth)
├── prompts/          system prompts
├── policies/         approved tool catalog
├── infra/  deploy/  scripts/  eval/  docs/
```

## Why the portal is a separate workspace

Backstage requires yarn 4, Node 22/24, React and its own build pipeline. The
runtime is npm workspaces, ESM TypeScript executed directly with `.ts` import
specifiers and `noEmit`. Merging them would force one side onto the other's
toolchain.

So `apps/portal` is a self-contained yarn workspace:

- excluded from the root `workspaces` glob (which lists `apps/api`, not `apps/*`)
- excluded from the root `tsconfig.json` and from root lint
- checked by its own `yarn tsc` via `npm run check:portal`

Backstage plugins live at `apps/portal/plugins/*` because yarn workspaces cannot
reference paths outside their project root.

## How the two planes share one Agent model

The portal does **not** import `@sre/agent-schema`. It consumes the runtime's
read-only `/management` API, which returns projections computed from the
canonical schema. That keeps exactly one Agent definition in the repository and
means the portal cannot show a permission the runtime would not enforce.

Draft validation and YAML rendering also run server-side for the same reason: the
portal's "Preview YAML" is produced by the same schema the runtime loads at
startup, so a previewed file cannot fail on deploy.

## Dependency boundaries

- `agent-schema` depends only on `zod`
- `keycloak-provisioning` and `management-api` depend on `agent-schema`, never on React or Backstage
- the runtime never depends on Backstage
- the portal depends on neither the runtime nor shared packages — only on its HTTP API

## Commands

```bash
npm install            # runtime workspaces
npm run install:portal # Backstage (yarn, requires Node 22/24 + corepack)

npm run dev:runtime    # manager + in-process specialists
npm run dev:portal     # Backstage on :3000, backend on :7007

npm run check          # typecheck + lint + tests + YAML + helm  (runtime)
npm run check:portal   # Backstage typecheck
npm run build          # runtime typecheck + portal bundles
```

`npm run check` is the one command that validates the runtime monorepo.
