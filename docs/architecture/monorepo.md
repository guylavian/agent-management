# Monorepo layout

One repository, three top-level zones that mirror the architecture's planes.

```
/
├── contracts/
│   └── agent-schema/          THE canonical Agent definition — depends on nothing
│
├── runtime/                   EXECUTION PLANE (authoritative)
│   ├── app/                   Manager + Specialist runtime (Express)
│   ├── packages/              auth, mcp, runtime, routing, evidence, config,
│   │                          llm, session, telemetry, agent-client,
│   │                          agent-protocol, agent-registry
│   └── deploy/                Helm chart + one values file per logical agent
│
├── management/                MANAGEMENT PLANE (a console, never authoritative)
│   ├── portal/                Backstage app (own yarn workspace)
│   ├── packages/              management-api, keycloak-provisioning
│   └── deploy/portal/         Helm chart for the portal
│
├── agents/  prompts/  policies/   configuration — the source of truth
├── infra/  scripts/  eval/  docs/
```

## Why one repository

The Agent schema is canonical (TDD §5). Splitting the planes into separate
repositories would turn `contracts/agent-schema` into a versioned cross-repo
dependency, and the moment the two versions differ the portal can preview a
configuration the runtime would reject — exactly the drift the architecture
forbids. It would also break the single `npm run check` and complicate the
real-PoC scripts, which orchestrate both planes together.

So the planes are separated by **directory and enforced dependency direction**,
not by repository.

## The enforced boundary

```
management/*  ──►  contracts/*  ◄──  runtime/*
```

`npm run validate:boundaries` (part of `npm run check`) fails the build on:

- management **source** importing any `runtime/packages/*` package — the console
  must never become a second place where authorization is decided.
  Management **tests** may import the runtime config loader, so projections are
  asserted against the same documents the runtime enforces rather than fixtures.
- the runtime importing `keycloak-provisioning` — request handling must not be
  coupled to the Keycloak Admin API (TDD §31). Provisioning is a
  configuration-path concern; runtime token acquisition is a separate one.
- `contracts/*` importing either plane — that is what keeps it a contract.

The runtime **does** depend on `management-api`, and that is intended: the
read-only management API is a projection of runtime state, so it is served by
the process that holds that state. `management-api` itself depends only on the
contract.

## Two toolchains

`management/portal` is a self-contained Backstage yarn workspace: yarn 4,
Node 22/24, React, its own build pipeline. The runtime is npm workspaces, ESM
TypeScript executed directly with `.ts` specifiers and `noEmit`. Merging them
would force one side onto the other's toolchain, so the portal is:

- excluded from the root `workspaces` globs
- excluded from the root `tsconfig.json` and from root lint
- checked by its own `yarn tsc` via `npm run check:portal`

Backstage plugins live at `management/portal/plugins/*` because yarn workspaces
cannot reference paths outside their project root.

## How the two planes share one Agent model

The portal does **not** import `contracts/agent-schema`. It consumes the
runtime's read-only `/management` API, which returns projections computed from
the canonical schema. Draft validation and YAML rendering also run server-side,
so "Preview YAML" is produced by the same schema the runtime loads at startup.

## Commands

```bash
npm install            # contracts + runtime + management packages
npm run install:portal # Backstage (yarn, requires Node 22/24 + corepack)

npm run dev:runtime    # manager + in-process specialists
npm run dev:portal     # Backstage app :3010, backend :7007

npm run check          # typecheck, lint, boundaries, tests, YAML, both Helm charts
npm run check:portal   # Backstage typecheck
npm run build          # runtime typecheck + portal bundles
```

`npm run check` is the one command that validates the monorepo.
