# The VDeploy control plane: the API and the worker, one image, two commands.
#   docker build -f deploy/control-plane.Dockerfile -t vdeploy/control-plane .
#   api:    node apps/api/dist/main.js      worker: node apps/worker/dist/main.js

FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@11.8.0 --activate
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm turbo run build --filter=@vdeploy/api --filter=@vdeploy/worker \
 && pnpm deploy --legacy --filter=@vdeploy/api --prod /out/api \
 && pnpm deploy --legacy --filter=@vdeploy/worker --prod /out/worker

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out/api /app/api
COPY --from=build --chown=node:node /out/worker /app/worker
USER node
EXPOSE 8080
CMD ["node", "/app/api/dist/main.js"]
