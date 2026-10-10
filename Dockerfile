# syntax=docker/dockerfile:1
# sigrun — the pi-durable assistant harness.
#
# Node >= 22.19 (node:sqlite), the repo at /app with node_modules, tsx for
# the .js→.ts import resolution, and the webui bundle built in-image.
#
# Extension deps are git+ssh URLs. The build expects the extensions vendored
# into .docker-ext/ (see scripts/docker-vendor-exts.sh) OR runs on a network
# that can reach the forgejo host over SSH. For local/dev builds:
#   bash scripts/docker-vendor-exts.sh && docker build -t sigrun .
# For CI on a tailscale-connected runner, npm ci can resolve them directly.

FROM node:22-slim AS base
WORKDIR /app

# Deps stage: package manifests + the extension deps.
FROM base AS deps
COPY package.json package-lock.json ./
COPY webui/package.json webui/package.json
# If the extensions are vendored locally, rewrite the git+ssh URLs to file:
# paths before npm ci. Otherwise npm ci needs SSH access to forgejo.
COPY .docker-ext/ .docker-ext/
RUN if [ -d .docker-ext/sigrun-ext-memory-markdown ] && [ -d .docker-ext/sigrun-ext-approvals ]; then \
      node -e "\
const fs = require('fs'); const p = JSON.parse(fs.readFileSync('package.json')); \
p.devDependencies['sigrun-ext-memory-markdown'] = 'file:.docker-ext/sigrun-ext-memory-markdown'; \
p.devDependencies['sigrun-ext-approvals'] = 'file:.docker-ext/sigrun-ext-approvals'; \
fs.writeFileSync('package.json', JSON.stringify(p, null, '\t') + '\n')" \
      && npm install --package-lock-only \
      && npm ci; \
    else \
      npm ci; \
    fi

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
