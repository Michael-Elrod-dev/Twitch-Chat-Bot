# syntax=docker/dockerfile:1

# ---- build ----------------------------------------------------------------
# Full toolchain here; none of it survives into the runtime image.
FROM node:24-slim AS build
WORKDIR /app

# Manifests first so the dependency layer caches independently of source churn.
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/

RUN npm ci --workspaces --include-workspace-root

COPY tsconfig.base.json tsconfig.json ./
COPY shared ./shared
COPY server ./server

RUN npm run build

# ---- production dependencies ----------------------------------------------
# A second install with dev dependencies omitted, so the runtime image carries
# only what the compiled output actually requires.
FROM node:24-slim AS deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/

# npm only creates a workspace-level node_modules when a dependency cannot be
# hoisted. The mkdir makes the layout predictable so the runtime COPY does not
# depend on how npm happened to resolve the tree.
RUN npm ci --omit=dev --workspaces --include-workspace-root     && mkdir -p shared/node_modules server/node_modules

# ---- runtime ---------------------------------------------------------------
FROM node:24-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production

# node:24-slim ships a non-root `node` user; use it rather than minting one.
COPY --from=deps  --chown=node:node /app/node_modules        ./node_modules
COPY --from=deps  --chown=node:node /app/shared/node_modules ./shared/node_modules
COPY --from=deps  --chown=node:node /app/server/node_modules ./server/node_modules
COPY --from=build --chown=node:node /app/shared/dist         ./shared/dist
COPY --from=build --chown=node:node /app/shared/package.json ./shared/package.json
COPY --from=build --chown=node:node /app/server/dist         ./server/dist
# Migrations are data the runtime reads, not code it compiles.
COPY --from=build --chown=node:node /app/server/drizzle      ./server/drizzle
COPY --from=build --chown=node:node /app/server/package.json ./server/package.json
COPY --from=build --chown=node:node /app/package.json        ./package.json

USER node

EXPOSE 3000

# Liveness only - readiness is the orchestrator's business, and a failing
# dependency must not cause a container restart.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/dist/index.js"]
