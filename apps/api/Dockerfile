FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages ./packages
RUN npm ci --omit=dev
COPY apps ./apps
COPY agents ./agents
COPY prompts ./prompts
COPY policies ./policies
USER node
EXPOSE 3000
CMD ["node", "apps/api/src/server.ts"]
