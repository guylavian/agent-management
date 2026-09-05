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

# Canonical logical configuration + every environment's deployment state.
#
# These are the DEFAULTS and the immutable half, not the live desired state:
#
#   config/mcp-servers, config/model-profiles, config/policies
#       the approved tool catalog and the platform tool policy. They belong to
#       the reviewed artifact: changing what an Agent MAY be granted should
#       require a new image, not a ConfigMap edit.
#
#   config/agents, config/prompts, deploy/environments/<env>/agents
#       MUTABLE Agent desired state. In production these are SHADOWED by
#       ConfigMap volumes that Argo renders from Git (deploy/runtime/helm),
#       because a merged Agent has to reach a running pod without a rebuild.
#       The copies here keep a working tree and a container resolving the same
#       relative paths, and let a laptop run with no cluster at all.
#
# A production runtime that finds these NOT mounted refuses to start rather
# than quietly serving the estate as it stood on build day — see
# `assertDesiredStateIsMounted` in runtime-host/src/bootstrap/dependencies.ts.
COPY platform/config ./platform/config
COPY deploy/environments ./deploy/environments

WORKDIR /app/platform
# Marks this as the shipped artifact rather than a working tree. loadAppConfig
# refuses to start without SRE_ENV when it is set: the environment default is
# `local`, whose clients are all mocks, and an image that guesses that on its
# own would serve production traffic with a mock IdP and a mock ToolHive.
ENV SRE_PACKAGED_IMAGE=1
USER node
EXPOSE 3000
CMD ["node", "runtime-host/src/main.ts"]
