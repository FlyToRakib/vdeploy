# The VDeploy dashboard (Next.js, standalone output).
#   docker build -f deploy/web.Dockerfile -t vdeploy/web .
# It serves pages; /api belongs to the API, behind the same origin (a proxy
# routes /api/* there). API_URL is where server-rendered pages reach the API.

FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@11.8.0 --activate
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile --filter @vdeploy/web... \
 && pnpm turbo run build --filter=@vdeploy/web

FROM node:22-alpine
ENV NODE_ENV=production PORT=3100 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /src/apps/web/.next/standalone /app
COPY --from=build --chown=node:node /src/apps/web/.next/static /app/apps/web/.next/static
USER node
EXPOSE 3100
CMD ["node", "/app/apps/web/server.js"]
