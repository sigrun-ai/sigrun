# syntax=docker/dockerfile:1
# sigrun — the pi-durable assistant harness.
#
# Five stages (image workflow spec §1): deps (full install, feeds the
# build) → build (sources + the built tree) → prod (manifests-only
# re-copy + `npm ci --omit=dev`) → runtime (base + agent userland + the
# prod tree). The runtime layer never carries the dev toolchain
# (typescript, vitest, the bundler natives), and a source-only edit
# re-runs only the build stage — the prod install layer is keyed on the
# manifests alone.
#
# BUILD PRECONDITION (registry mode): the dev tree's `file:../sigrun-ext-*`
# built-in deps dangle inside a build context — the build goes green but
# every built-in quarantines at boot (they resolve through core's own
# node_modules; there is no fallback install). Build with:
#
#   node scripts/publish-deps.mjs registry \
#     && npm install @sigrun/ext-codemode@<ver> @sigrun/ext-mcp@<ver> \
#          @sigrun/ext-tool-search@<ver> --package-lock-only \
#     && docker build . \
#     && node scripts/publish-deps.mjs file
#
# The <ver>s are the registry pins publish-deps.mjs just wrote into
# package.json (each read from the sibling checkout's own manifest —
# `git diff package.json` after `registry` shows them; e.g. 0.1.0/
# 0.2.0/0.1.0 today). The lock regen MUST name them explicitly: a bare
# `npm install --package-lock-only` keeps the lock's existing `link:`
# entries, npm ci then materializes dangling ../sigrun-ext-* symlinks,
# and the built-ins quarantine at boot — the exact failure this dance
# exists to prevent. Nothing is committed — the registry-shaped
# manifest and lock are build-time-only state.
#
# The runtime entry is plain node — tsx is a devDependency (from-source
# runs: `npm start`), never needed by the built image.

# bookworm-slim, NOT alpine: boot-time extension installs make native-
# module compatibility a RUNTIME property (arbitrary `npm install` into
# the packages dir on persistent storage), and glibc is the safe side of
# the prebuild lottery — better-sqlite3, onnxruntime, tree-sitter are
# the exact class pi-ecosystem extensions depend on.
FROM node:22-bookworm-slim AS base
WORKDIR /app

# OCI metadata: where the image comes from, and what is inside it. The
# version comes from APP_VERSION — CI passes the release tag, so the
# label can't rot the way the old hardcoded one did; the default marks
# local builds, and docker/metadata-action supplements at push time.
# The chart's appVersion and the image tag carry the same value, so a
# `docker inspect` and a `helm get values` agree.
ARG APP_VERSION=dev
LABEL org.opencontainers.image.source="https://github.com/sigrun-ai/sigrun" \
      org.opencontainers.image.title="sigrun" \
      org.opencontainers.image.description="Durable personal assistant harness on pi-durable" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.url="https://github.com/sigrun-ai/sigrun"

# Deps stage: package manifests — root + EVERY workspace the lockfile
# links (shared/tui/webui): npm ci resolves the workspace members from
# their package.json files, so a missing manifest silently drops that
# workspace's node_modules link (the runtime import then fails).
FROM base AS deps
COPY package.json package-lock.json ./
COPY shared/package.json shared/package.json
COPY webui/package.json webui/package.json
COPY tui/package.json tui/package.json
# Full install (dev included): the build needs the toolchain. The
# cache-mounted npm store survives across CI builds.
RUN --mount=type=cache,target=/root/.npm npm ci

# Build stage: sources + the built tree — the core tsc build (which
# chains the shared workspace build), the webui bundle, and the optional
# TUI package the CLI spawns at runtime.
FROM deps AS build
COPY . .
RUN npm run build && npm run build:webui && npm --workspace @sigrun/tui run build

# Prod stage: the runtime's node_modules — the SAME manifest set as deps
# (the workspace links again), but --omit=dev. Manifests are re-copied
# rather than inherited so this layer's cache key is the manifests
# alone: a source-only change never re-installs.
FROM base AS prod
COPY package.json package-lock.json ./
COPY shared/package.json shared/package.json
COPY webui/package.json webui/package.json
COPY tui/package.json tui/package.json
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

# Runtime: base + the agent userland + the prod tree.
FROM base AS runtime
# SG_UID/SG_GID feed the entrypoint's privilege drop (defaults matching
# USER below; env-overridable). The npm cache lives under /cache — the
# regenerable mount point — so an arbitrary-uid boot can npm-install
# extensions without touching root-owned state.
ENV NODE_ENV=production \
    SG_UID=1000 \
    SG_GID=1000 \
    NPM_CONFIG_CACHE=/cache/npm
# The agent userland (spec §1): the everyday set agents reach for —
# ripgrep/fd/jq (search + shaping), git (required by git: extension
# sources), sqlite3 (path-target backups + the online-safe
# `sqlite3 .backup` snapshot), curl, unzip/zip, procps, ca-certificates
# (TLS to model gateways). tar ships in the base. Deliberately NO
# kubectl/helm/talosctl: their version churn is a deploy concern,
# installed at deploy time onto persistent storage (chart values), never
# baked here. Debian names the fd-find binary `fdfind`; the symlink
# makes the name agents type work. docker-clean is dropped so the
# cache-mounted archives actually persist between CI builds (it deletes
# every downloaded .deb after each install otherwise).
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl fd-find git jq procps ripgrep sqlite3 unzip zip \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd
COPY --from=prod /app/node_modules ./node_modules
# The built tree + the workspace packages the prod node_modules SYMLINK
# into (node_modules/@sigrun/shared → /app/shared, @sigrun/tui →
# /app/tui): the link targets must ship too, or every import of them
# fails at runtime.
COPY --from=build /app/dist ./dist
COPY --from=build /app/webui/dist ./webui/dist
COPY --from=build /app/shared ./shared
COPY --from=build /app/tui ./tui
COPY --from=build /app/package.json ./package.json
# The container scripts (spec §2): docker/'s script set ships at
# /usr/local/share/sigrun/ — the GLOB picks up the scripts later tasks
# add, never a hand-enumerated list. The image-layout smoke lives here
# too for operators; CI runs its source copy. The entrypoint is additionally
# exposed at its stable exec path (symlink — one source of truth, the
# image dir). COPY lands mode 0644, hence the chmod.
COPY docker/*.sh scripts/smoke-image.sh /usr/local/share/sigrun/
RUN chmod +x /usr/local/share/sigrun/*.sh \
    && ln -s /usr/local/share/sigrun/entrypoint.sh /usr/local/bin/sigrun-entrypoint.sh
# The volume mount points (chart PVC at /data, cache emptyDir at
# /cache), owned by the default uid so a fresh named volume or tmpfs
# inherits the image dir's ownership — the non-root server can write
# them with no manual chown; the entrypoint re-chowns on a root start
# carrying a different SG_UID.
RUN mkdir -p /data /cache/npm && chown 1000:1000 /data /cache /cache/npm
# Numeric, not the `node` name: the uid is what a rootless runtime
# verifies (runAsNonRoot checks, compose uid maps); the name would only
# resolve inside this image.
USER 1000:1000
EXPOSE 3000
# Plain node (no npm in the signal path): SIGTERM reaches the entry's
# graceful shutdown — server close, event-bus drain, harness close,
# exit 0. The entrypoint drops privileges first when started as root.
ENTRYPOINT ["/usr/local/bin/sigrun-entrypoint.sh"]
CMD ["node", "dist/index.js"]
