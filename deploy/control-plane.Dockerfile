# The VDeploy control plane: the API and the worker, one image, two commands.
#   docker build -f deploy/control-plane.Dockerfile -t vdeploy/control-plane .
#   api:    node apps/api/dist/main.js      worker: node apps/worker/dist/main.js
# It also carries the agent for x86-64 and ARM64, which the one-command
# installer (/api/v1/agent/install.sh) downloads onto new servers.

FROM golang:1.27 AS agent
WORKDIR /src
COPY agent/go.mod agent/go.sum ./
RUN go mod download
COPY agent/ ./
ARG AGENT_VERSION=dev
RUN for arch in amd64 arm64; do \
      CGO_ENABLED=0 GOOS=linux GOARCH=$arch go build -trimpath \
        -ldflags "-s -w -X main.version=${AGENT_VERSION}" \
        -o /out/vd-agent-linux-$arch ./cmd/vd-agent; \
    done

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
COPY --from=agent /out /app/agent
USER node
EXPOSE 8080
CMD ["node", "/app/api/dist/main.js"]
