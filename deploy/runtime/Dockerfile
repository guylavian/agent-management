FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
# One image for every role. agent-engine and orchestrator are separate source
# components but a single release unit: the Manager and every Specialist run the
# same build, differing only by ROLE and agent configuration, so the two can
# never drift into version skew.
COPY contracts ./contracts
COPY shared ./shared
COPY agent-engine ./agent-engine
COPY orchestrator ./orchestrator
COPY runtime-host ./runtime-host
RUN npm ci --omit=dev --workspace @sre/runtime-host --include-workspace-root
# canonical logical configuration + every environment's deployment desired state
COPY config ./config
COPY deploy/environments ./deploy/environments
USER node
EXPOSE 3000
CMD ["node", "runtime-host/src/main.ts"]
