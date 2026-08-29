FROM node:24-alpine
WORKDIR /app
# Build context is `platform/` — the npm workspace root. Nothing above it is
# needed, so the image never sees .claude, CI config or the git shell:
#   docker build -f deploy/runtime/Dockerfile platform/
COPY package.json package-lock.json ./
# One image for every role. agent-engine and orchestrator are separate source
# components but a single release unit: the Manager and every Specialist run the
# same build, differing only by ROLE and agent configuration, so the two can
# never drift into version skew.
COPY libs ./libs
COPY core ./core
RUN npm ci --omit=dev --workspace @sre/runtime-host --include-workspace-root
# canonical logical configuration + every environment's deployment desired state
COPY config ./config
COPY deploy/environments ./deploy/environments
USER node
EXPOSE 3000
CMD ["node", "core/runtime-host/src/main.ts"]
