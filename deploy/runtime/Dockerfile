# Air-gap: point both at the internal mirror, e.g.
#   docker build -f deploy/runtime/Dockerfile \
#     --build-arg BASE_IMAGE=registry.internal/mirror/node:24-alpine \
#     --build-arg NPM_REGISTRY=https://nexus.internal/repository/npm/ .
# package-lock.json integrity hashes still apply; npm rewrites the locked
# registry.npmjs.org URLs to NPM_REGISTRY (replace-registry-host, default).
ARG BASE_IMAGE=node:24-alpine
FROM ${BASE_IMAGE}
ARG NPM_REGISTRY=https://registry.npmjs.org/
ENV npm_config_registry=${NPM_REGISTRY}
WORKDIR /app

# Build context is the REPOSITORY ROOT, because the runtime spans three
# first-class concerns that are siblings there:
#
#   agent-engine/  the generic Specialist engine
#   platform/      orchestrator, runtime-host, contracts, shared, config
#   deploy/        this Dockerfile and the environment state it copies
#
#   docker build -f deploy/runtime/Dockerfile .
#
# The image mirrors that layout exactly, so every relative path the code uses
# ("config/agents/...", "../deploy/environments/...") resolves identically here
# and in a working tree. Context exclusions live in Dockerfile.dockerignore
# beside this file rather than at the repository root, which holds directories only.

# manifests first, so a source-only change does not reinstall
COPY platform/package.json platform/package-lock.json ./platform/
COPY agent-engine/package.json agent-engine/package-lock.json ./agent-engine/

# the engine links the platform packages it depends on by path, so those must
# exist before either install runs
#
# ONE image for every role. agent-engine, orchestrator and runtime-host are
# separate source projects but a single release unit: the Manager and every
# Specialist run this same build, differing only by ROLE and agent
# configuration, so the two can never drift into version skew.
COPY platform/contracts ./platform/contracts
COPY platform/shared ./platform/shared
COPY platform/orchestrator ./platform/orchestrator
COPY platform/runtime-host ./platform/runtime-host
COPY agent-engine/src ./agent-engine/src

RUN cd /app/agent-engine && npm ci --omit=dev
RUN cd /app/platform && npm ci --omit=dev --workspace @sre/runtime-host --include-workspace-root

# canonical logical configuration + every environment's deployment desired state
COPY platform/config ./platform/config
COPY deploy/environments ./deploy/environments

WORKDIR /app/platform
USER node
EXPOSE 3000
CMD ["node", "runtime-host/src/main.ts"]
