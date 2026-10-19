# syntax=docker/dockerfile:1
# sigrun — the pi-durable assistant harness.
#
# Node >= 22.19 (node:sqlite), the repo at /app with node_modules, and the
# BUILT tree: dist/ (the core tsc build) + webui/dist (the vite bundle)
# + shared/dist (the @sigrun/shared workspace build the root build
# chains). The runtime entry is plain node — tsx is a devDependency
# (from-source runs: `npm start`), never needed by the built image.
#

FROM node:22-slim AS base
WORKDIR /app

# Deps stage: package manifests — root + EVERY workspace the lockfile
# links (shared/tui/webui): npm ci resolves the workspace members from
# their package.json files, so a missing manifest silently drops that
# workspace's node_modules link (the runtime import then fails).
FROM base AS deps
COPY package.json package-lock.json ./
COPY shared/package.json shared/package.json
COPY webui/package.json webui/package.json
COPY tui/package.json tui/package.json
RUN npm ci

# Build stage: sources + the full build (core dist via the root
# `npm run build` — which chains the shared workspace build — plus the
# webui bundle).
FROM deps AS build
COPY . .
RUN npm run build && npm run build:webui

# Runtime: the app + the built tree.
FROM base
ENV NODE_ENV=production
COPY --from=build /app /app
EXPOSE 3000
# Plain node (no npm in the signal path): SIGTERM reaches the entry's
# graceful shutdown — server close, event-bus drain, harness close,
# exit 0.
CMD ["node", "dist/index.js"]
