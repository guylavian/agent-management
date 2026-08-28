FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY runtime/app/package.json runtime/app/package.json
# The canonical Agent contract plus the execution-plane packages. The
# management workspaces are present because npm must resolve every declared
# workspace, and because the runtime hosts the read-only management API. The
# Keycloak provisioner ships but is unreachable from the request path — that is
# enforced by scripts/check-boundaries.ts, not by omitting the files.
COPY contracts ./contracts
COPY runtime/packages ./runtime/packages
COPY management/packages ./management/packages
RUN npm ci --omit=dev
COPY runtime/app ./runtime/app
COPY agents ./agents
COPY prompts ./prompts
COPY policies ./policies
USER node
EXPOSE 3000
CMD ["node", "runtime/app/src/server.ts"]
