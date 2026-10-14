# syntax=docker/dockerfile:1
# sigrun — the pi-durable assistant harness.
#
# Node >= 22.19 (node:sqlite), the repo at /app with node_modules, tsx for
# the .js→.ts import resolution, and the webui bundle built in-image.
#

FROM node:22-slim AS base
WORKDIR /app

# Deps stage: package manifests.
FROM base AS deps
COPY package.json package-lock.json ./
COPY webui/package.json webui/package.json
RUN npm ci

# Build stage: sources + the webui bundle.
FROM deps AS build
COPY . .
RUN npm run build:webui

# Runtime: the app + the built bundle.
FROM base
ENV NODE_ENV=production
COPY --from=build /app /app
EXPOSE 3000
CMD ["npm", "start"]
