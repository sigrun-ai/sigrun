# Sigrun image workflow + GitHub publishing — design

Date: 2026-10-23
Status: approved (all open questions resolved)
Predecessors: publish-prep (2026-10-13, `79a4fd2`), extension-packages
(2026-10-14), provider plugins (2026-10-18). This design assumes all of it.

## Intent

Deploy sigrun to the homelab Kubernetes cluster by publishing, from GitHub,
everything a deployment consumes: a container image on GHCR and the Helm
chart on GHCR's OCI registry. The image is the agent *environment* — a
minimal, non-root, glibc Node runtime with the userland tools agents
reach for — while heavy DevOps tooling (kubectl et al.) installs at deploy
time onto persistent storage, not into the image. The chart manages
sigrun core *and* its extension fleet declaratively from values.

Secondary: make the sigrun-ai org public (one repo excepted), which also
unlocks free Actions minutes and later npm provenance.

## Goals

1. CI on GitHub: test + image build + chart lint on PRs and main pushes.
2. Release on `v<semver>` tags: multi-arch image → `ghcr.io/sigrun-ai/sigrun`,
   chart → `ghcr.io/sigrun-ai/charts/sigrun` (OCI).
3. Image best practices: bookworm-slim, numeric non-root default (1000)
   *without requiring* it, prod-only node_modules, no dev toolchain in the
   runtime layer.
4. Agent-grade userland baked in: ripgrep, fd, jq, git, curl, sqlite3, …
5. Deploy-time tool install: chart values declare tools (name@version);
   an initContainer installs them hash-cached onto persistent storage and
   the PATH picks them up. Nothing beyond the fixed catalog needs an
   image change.
6. Chart owns the extension fleet: `extensions` list + per-slug freeform
   settings in values, seeded into the config volume with explicit
   ownership semantics.
7. Compose file modernized to the same posture.
8. Eight repos public; `sigrun-memory-markdown` stays private.

## Non-goals

- **npm publishing from CI** — fast follow. The release workflow gets a
  seam (job boundaries, `NPM_TOKEN` absent) but no npm jobs. Until then
  npm publishes keep happening from the dev machine, as today.
- Flux-side resources (ImageRepository / HelmRepository / HelmRelease
  updates in the hub and flux-app-llm): hub-only per GitOps convention;
  this design documents what Flux will consume, and the user wires it.
- Renovate for the family (sigrun pins its own family versions; no
  external ARG bumps to automate).
- Making `sigrun-memory-markdown` public.

## Anti-goals

- **No extensions baked into the image.** The image is sigrun core + the
  three built-ins (its npm dependencies); everything else installs at
  boot from `settings.json` — the existing contract (docker/README,
  stores.ts). An "everything image" would reintroduce image-rebuild
  friction the packages dir exists to eliminate.
- **No kubectl/helm/talosctl/flux in the image.** Version churn is a
  deploy concern; they are static binaries installed at deploy time.
- **No multi-process supervision** (hermes-pantheon's supervisord exists
  because hermes is three processes; sigrun is one process with a
  cronjob side-along for backup — the chart already models this).
- **No musl.** Alpine loses the glibc-prebuild lottery for runtime-
  installed native npm modules (better-sqlite3, onnxruntime, tree-sitter
  — the exact class of packages pi-ecosystem extensions depend on).

## Approaches considered

**Chart hosting: GHCR OCI vs GitHub Pages + chart-releaser.** Picked OCI:
one registry and one credential story for image + chart; Flux consumes
`oci://` HelmRepositories natively; no `gh-pages` branch or index.yaml to
maintain. Pages buys nothing here. (User ruling.)

**Image base: bookworm-slim vs alpine.** Picked bookworm-slim (glibc):
the runtime tree is pure JS today, but boot-time `npm install` of
arbitrary extensions makes native-module compat a *runtime* property,
and glibc prebuilds are the safe side of that lottery. ~60 MB premium
accepted. (User ruling.)

**Built-in resolution in CI: sibling checkout + `publish-deps.mjs` vs
npm-packument extraction vs tarball-install image.** Picked sibling
checkout: the workflow checks out the three ext repos as *siblings*
(`../sigrun-ext-*`), so the dev-tree `file:` shape works for tests
verbatim, and the existing `publish-deps.mjs registry` (unmodified)
rewrites to registry mode for the Docker build. Assumption documented:
family releases together (siblings' default branches carry the released
versions at a sigrun tag), which has held every release so far. The
alternatives couple image builds to npm-publish ordering or change the
image's /app contract; rejected.

**npm from GitHub: now vs fast follow.** Fast follow (user ruling):
`publish-deps.mjs` requires sibling manifests, per-repo release
workflows, an org `NPM_TOKEN`, and tag discipline across the family —
roughly doubling the workflow work. Image + chart first.

## Design

### 1. Image (Dockerfile rework)

Stages:

```
base    node:22-bookworm-slim, WORKDIR /app
deps    package*.json + workspace manifests → npm ci (dev; for the build)
build   COPY . → npm run build && npm run build:webui
prod    package*.json + manifests → npm ci --omit=dev (registry mode!)
runtime base + userland apt install; copy prod node_modules, dist/,
        webui/dist, shared/, tui/, package.json from build/prod stages
```

Key points:

- **Registry mode is a build precondition.** The dev tree's
  `file:../sigrun-ext-*` deps dangle inside a build context — the
  current Dockerfile builds green but boots with all three built-ins
  quarantined (they resolve via `coreRequire.resolve`; there is no
  fallback install). CI therefore runs
  `node scripts/publish-deps.mjs registry && npm install --package-lock-only`
  in the workspace *before* `docker build` (with ext siblings checked
  out). Nothing is committed; the rewrite lives in CI's ephemeral tree.
  `publish-deps.mjs file` restores after build so cache-diff jobs stay
  clean (or the workspace is simply discarded).
- **Two install passes:** `deps` (full, feeds the build) and `prod`
  (`--omit=dev`) — the runtime layer never carries typescript/vitest/
  rolldown natives. `npm ci --mount=type=cache,target=/root/.npm` in
  both; apt gets `--mount=type=cache` for the userland layer too.
- **Userland (goal 4):** `git sqlite3 ca-certificates ripgrep fd-find
  jq curl unzip zip procps` — the agent everyday set, ~40 MB. Note:
  Debian's `fd-find` binary is `fdfind`; ship an `fd` symlink so the
  name agents type works.
- **UID posture (goal 3, user ruling 2):** `USER 1000:1000` numeric in
  the Dockerfile — the *default*, not an assumption. ENTRYPOINT
  `sigrun-entrypoint.sh`: when started as root (plain `docker run`
  without `--user`), fix ownership of `/data` and `/cache` then
  `exec setpriv --reuid=$SG_UID --regid=$SG_GID --init-groups "$@"`
  (`setpriv` ships in util-linux; no gosu/su-exec package). When
  already non-root, `exec "$@"` — zero overhead on the k8s path where
  the pod securityContext sets the uid. `NPM_CONFIG_CACHE=/cache/npm`
  is baked so arbitrary-uid boots can still npm-install extensions.
- **OCI labels:** keep the static set, but the version label comes from
  `ARG APP_VERSION` (the current hardcoded `0.1.0` is stale and would
  stay stale); CI passes the release tag. `docker/metadata-action`
  supplements at push time.
- **`.dockerignore` tightened:** docs/, test/, spikes/, charts/,
  test-results/, .playwright/ — none belong in a build context
  (they currently ride along into the build stage copy). `docker/`
  stays IN the context: the container scripts live there (§2) and a
  `COPY docker/…` against an ignored path fails the build.
- Multi-arch: release builds `linux/amd64,linux/arm64` (buildx + QEMU;
  PR builds validate amd64 only). Runtime tree is pure JS so emulation
  cost is build-time-only.

### 2. Container scripts (docker/)

Three small scripts, all shipped *in the image* (the chart mounts
nothing; initContainers are just ways to run image commands):

- `entrypoint.sh` — the privilege-drop trampoline above.
- `seed-settings.sh` — chart/compose seeding (see §4).
- `tools-install.sh` — deploy-time tooling (see §5).

### 3. GHCR publishing (workflows)

**`.github/workflows/ci.yml`** — `pull_request` + `push: branches:
[main]`:

- *test*: checkout sigrun + the three ext repos **as siblings** under
  `$GITHUB_WORKSPACE/` (sigrun at `./sigrun`, exts at `./sigrun-ext-*` —
  the relative `file:` specifiers resolve); `npm ci && npm test && npm
  run typecheck`. Public repos make these minutes free.
- *image-build*: the registry-mode dance, then `docker buildx build
  --platform linux/amd64` (no push) — proves the Dockerfile on every PR.
- *chart-lint*: `helm lint` + `helm template` over `charts/sigrun`
  (chart dependencies vendored via `helm dependency build` against the
  bjw-s repo, or committed Chart.lock/tarball as today).

**`.github/workflows/release.yml`** — `push: tags: ['v*']` +
`workflow_dispatch`:

- Same registry-mode dance; buildx multi-arch; push
  `ghcr.io/sigrun-ai/sigrun:{semver,latest}` with `APP_VERSION` build
  arg; login via `GITHUB_TOKEN` (`permissions: packages: write`) — no
  PAT, no stored secrets.
- Chart: rewrite `Chart.yaml` `version`/`appVersion` from the tag in the
  CI workspace, `helm package`, `helm push
  oci://ghcr.io/sigrun-ai/charts/sigrun` (same GITHUB_TOKEN login).
  The OCI tag equals the chart version, matching the forgejo
  `sigrun-v<semver>` habit minus the prefix (OCI tags *are* versions;
  no namespace collision because the chart lives under `charts/`).
- `workflow_dispatch` takes a **required `tag` input** and re-runs the
  release for an EXISTING tag: checkout `refs/tags/<tag>`, fail loud
  if absent. It exists for re-running a failed release after a fix —
  not for building arbitrary SHAs. Idempotency boundary: an image tag
  push overwrites; a `helm push` of an existing chart version FAILS
  (registry refuse) — re-running a completed release is therefore
  half-idempotent, documented, not worked around.
- Default `values.yaml` image tag tracks appVersion (already does via
  `tag: ""` + bjw-s defaulting — keep).

Post-first-push manual step (documented in the workflow README): flip
the two GHCR packages to public visibility (org Packages settings) so
anonymous pulls — including the homelab cluster's — work.

Release flow for the human: bump family versions → publish npm family
from the dev machine (unchanged, fast-follow replaces this) → push
sigrun main → `git tag v0.1.5 && git push origin v0.1.5` → workflow
ships image + chart.

### 4. Chart: extension fleet management (user ruling 4)

The chart gains a `sigrun:` values block (or extends the existing env
wiring — builder picks placement consistent with the current file):
```yaml
sigrun:
  settings:            # → settings.json keys the CHART owns
    builtinExtensions: { mcp: true, codemode: true, toolSearch: true }
  extensions:
    enabled:           # → settings.json `extensions` list
      - "@sigrun/memory-markdown@^0.1.0"
    settings:          # → config/settings/<slug>.json, freeform
      memory-markdown: { noteRoot: "/data/notes" }
  tools:
    dir: /data/tools
    packages:          # name@version, fixed catalog
      - kubectl@v1.32.0
      - helm@v3.17.0
  secretsEnv:        # k8s Secret NAMES whose KEYS are SIGRUN_EXT_* vars
    - sigrun-ext-secrets   # (or any operator Secret; envFrom-style)
```

**values.schema.json scope (user ruling):** the chart ships a schema
covering `sigrun:` core + built-in-extension structure — the fleet
list (array of strings/objects), `settings` per-slug objects,
`secrets` shape (§ below), tools entries. Third-party extension
SETTINGS stay freeform objects by design — the schema validates the
HANGING POINT ("an obvious place to hang an extension's settings"),
not the contents: `additionalProperties: true` per slug. Nothing
outside `sigrun:` is constrained (bjw-s common's inherited surface
passes through).

**Ownership semantics** (the deliberate part):

- **Env wins, documented.** Sigrun core's contract is `SIGRUN_EXTENSIONS`
  (env CSV) REPLACES the file's `extensions` list when set
  (src/config.ts). The chart does NOT fight this: values-driven fleet
  and the env var are mutually exclusive deployment styles, the values
  comments say so, and no template validation logic exists for the
  combination. Migration note for the homelab: the `sigrun-env` Secret
  must DROP `SIGRUN_EXTENSIONS` when adopting the values fleet, or the
  values-declared list is silently dead (the seeder would re-assert a
  file the env var overrides every boot).- `sigrun.extensions.enabled` and `sigrun.settings` are **re-asserted on
  every pod start** by a seed initContainer: merge into `settings.json`
  preserving all other keys (jq/node merge). GitOps semantics — the
  values file is the source of truth for the fleet list; manual edits
  to chart-owned keys revert on next boot. (Consistent with how Flux
  treats every other declared field.)
- `sigrun.extensions.settings.<slug>` is **seed-once**: written only if
  absent. After first boot the *extension owns* its settings file — the
  server-mediated settings store writes there at runtime
  (`ExtensionSettingsStore`), and a values re-assert would clobber
  extension self-writes. Changing a seeded value = delete the file /
  bump via the extension's own surface. Documented in values comments.
- The seed initContainer (and the tools one) run with the app image and
  the config/data volumes mounted, under the pod security context.
- **Secrets (user ruling: "a good story for sensitive data").**
  Sigrun core already has the exact seam: extension secrets resolve
  STORED (`<configDir>/secrets.json`, server-mediated writes, 0600)
  over ENV (`SIGRUN_EXT_<SLUG>_<KEY>` — never written down) — and
  k8s Secrets are env-shaped. The chart therefore does NOT seed
  secret values from values.yaml (values files are the wrong place
  for secrets; no `sigrun.extensions.secrets` block exists). Instead:
  the `sigrun.secretsEnv` values key is a **list of k8s Secret key
  names** whose entries are injected as plain env vars (envFrom a
  user-provided Secret via the existing `envFrom` passthrough, or a
  chart-managed `secretRef` list). Operators write
  `SIGRUN_EXT_<SLUG>_<KEY>` keys INTO their own Secret; the chart
  merely documents + plumbs the var names. Provider credentials
  (auth.json / `OPENAI_API_KEY`-class degenerate env) follow the same
  pattern — env passthrough from the operator's Secret, never values.
  `sigrun.extensions.settings.<slug>` stays seed-once settings only;
  secret-ish knobs in there are the extension's problem, flagged in
  comments.
- **`command:` → `args:` migration:** the image gains an ENTRYPOINT
  (§1), and k8s `command:` overrides ENTRYPOINT — today's chart pins
  `command: [node, dist/index.js]` (main) and `command: [node, /app/
  dist/backup/run-backup.js]` (backup CronJob), which would bypass the
  trampoline entirely. Both switch to `args:` so the entrypoint stays
  in the exec path (it no-ops to `exec "$@"` when the pod security
  context already set a non-root uid — zero cost, keeps the privilege
  logic in one place).
- The chart itself bakes no extension knowledge beyond this mechanism —
  names are opaque strings to it.

`seed-settings.sh` implements exactly this contract (jq is in the image;
node as fallback). Compose does NOT run the seeder — compose users edit
`/data/config/settings.json` directly (existing README contract), and
the `SIGRUN_EXTENSIONS` env passthrough (added to compose) remains the
env-shaped override that wins over the file.

### 5. Deploy-time tools (user ruling: kubectl-class)

`tools-install.sh` ships in the image at
`/usr/local/share/sigrun/tools-install.sh`; the chart's initContainer
invokes it with the values list. Behavior:

- Fixed catalog of known download URL templates: `kubectl` (dl.k8s.io),
  `helm` (get.helm.sh), `talosctl` (siderolabs releases), `flux`
  (fluxcd releases), `k9s` (derailed releases) — the hermes-pantheon
  set, data-driven instead of hardcoded per-tool lines. Adding a tool
  to the catalog = script edit + image rebuild (rare); *using* one =
  values only.
- Installs into `tools.dir` on the data volume; hash file
  (`tools/.catalog-sha`) short-circuits when the list is unchanged —
  pod restarts don't re-download (hermes pattern, kept).
- Chart prepends `tools.dir` to the container PATH via env.
- Failure is loud (initContainer nonzero → CrashLoop with the failed
  URL in events), matching the fail-loud boot posture.

Static Go binaries + glibc userland means no musl/alpine compat issues.

### 6. Compose modernization (user ruling 3)

On top of the existing file: `init: true` (PID-1 reaping — node is the
entry but container-level init is the belt-and-braces posture),
`read_only: true` rootfs with tmpfs `/tmp` + `/cache`, `cap_drop:
[ALL]`, `security_opt: [no-new-privileges:true]`, `user:` parametrized
(defaults 1000:1000 via env), image tag parametrized,
`SIGRUN_EXTENSIONS` passthrough. Keeps: healthcheck, tmpfs cache,
stop_grace_period, single named volume. README updated for the new
env knobs.

### 7. Public flips (user ruling 5)

`gh repo edit sigrun-ai/<repo> --visibility public` for: sigrun,
sigrun-ext-codemode, sigrun-ext-mcp, sigrun-ext-tool-search,
sigrun-provider-{ollama,opencode,pareto,bifrost}. Not
`sigrun-memory-markdown`.

Guardrails: a tip-tree needle scan per repo before the flip (the
2026-10-13/15 scrubs purged histories; this is a cheap belt check for
`tayra-beaufort|macfort|nullpointer|token`-shaped strings in *current*
trees); all eight are pushed and clean (verified 2026-10-23). Executed
as a distinct, user-visible step in the plan — not folded into a commit.

Side effects (both good): Actions minutes become free on public repos;
npm provenance becomes possible when the fast follow lands.

## Constraints & facts relied on

- Local main is 6 commits ahead of `origin/main` — push before any of
  this matters (user's push, per standing convention).
- GHCR package visibility defaults private on first push; anonymous
  pulls need the one-time manual flip (no clean workflow-side way
  without an admin PAT).
- `GITHUB_TOKEN` can push packages under the *org* namespace given
  `permissions: packages: write` — verified pattern, no PAT stored.
- The built-ins are `dependencies`, not `optionalDependencies`; only
  `@sigrun/tui` is optional (workspace pkg, client-side; its pi-tui
  prebuilds include linux x64/arm64 — irrelevant to the server runtime
  either way).
- Ext family repos all `ahead=0`, clean trees (checked 2026-10-23).
- Repo has no git tags yet — the `v<semver>` convention is established
  BY this design; 0.1.5 (or 0.2.0) is the first.

## Left to the builder

- Exact workflow YAML structure (job naming, action versions, caching
  of the docker layers) — nothing exotic; standard actions/setup-node,
  docker/build-push-action, azure/setup-helm.
- Whether `sigrun:` chart values live under a new top-level key or fold
  into existing structure — consistency with the current values file
  wins.
- Script implementation details (setpriv fallback ordering, jq merge
  shape) — contracts above are the spec; keep scripts small and
  commented per repo comment discipline.
- values.schema.json: the chart has NONE today (Chart.yaml, Chart.lock,
  vendored common tgz, templates, values.yaml, icon.svg — verified).
  Scope of authoring one is an open question (§ Open questions).
- Whether PR image builds also validate arm64 (default: no — QEMU cost
  on every PR; release builds cover it).
- Docs touch-ups: docker/README (new env knobs), chart comments, root
  README deploy pointer.

## Verification (what "done" proves)

1. CI green on a PR: tests + amd64 image build + chart lint/template.
2. A `v0.1.5` tag (or `v0.0.0-ci.<sha>` throwaway on a fork/branch of
   the workflow) produces: multi-arch image in GHCR (inspect: labels
   carry the version; image runs as uid 1000; `rg`/`fd`/`jq` present;
   `node dist/index.js` boots and serves /healthz with a dummy model),
   and `helm pull oci://ghcr.io/sigrun-ai/charts/sigrun --version …`
   round-trips.
3. Rendered chart with `extensions` + `tools` values: `helm template`
   shows seed + tools initContainers; a `helm install` against a local
   kind/k3d (or the homelab) boots sigrun with the declared extension
   installed and kubectl on PATH (live verification is the user's
   deployment step, as with provider plugins T12).
4. Compose `docker compose up` on the built image: healthy, non-root,
   read-only rootfs, extension via `SIGRUN_EXTENSIONS` installs on
   boot.

## Release smoke test (user ruling)

A fork's GITHUB_TOKEN cannot push to the org GHCR namespace, so the
push path can't be exercised off-repo. The smoke test is a
**throwaway `v0.0.0-ci.<sha>` tag on the REAL repo**: full release
workflow run against it, image + chart verified in GHCR, then the tag
deleted and any pushed packages cleaned up (`gh api -X DELETE` on the
ci-tagged versions). Packages stay private until the visibility flip,
so nothing transient is ever publicly visible. The first REAL tag
(`v0.1.5` or `v0.2.0`) then runs a known-good pipeline.
