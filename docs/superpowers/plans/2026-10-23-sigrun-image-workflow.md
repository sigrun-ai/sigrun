# Sigrun image workflow + GitHub publishing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish sigrun's container image and Helm chart from GitHub (GHCR + OCI), with an agent-grade non-root image, chart-managed extension fleet, and deploy-time tooling.

**Architecture:** Multi-stage bookworm-slim Dockerfile (prod-only node_modules, ENTRYPOINT privilege trampoline); three container scripts shipped in the image (entrypoint, settings seeder, tools installer); a `sigrun:` values block driving seed + tools initContainers through the bjw-s common wrapper; two GitHub workflows (CI validate; release publish on `v<semver>` tags via GITHUB_TOKEN, no PATs).

**Tech Stack:** Docker buildx (multi-arch), GitHub Actions, helm (OCI push), bash scripts, jq, vitest (script + chart-render tests), docker compose.

**Spec:** `docs/superpowers/specs/2026-10-23-sigrun-image-workflow-design.md`

## Global Constraints

- No secrets in values.yaml/chart/workflows — Secret *references* only (`sigrun.secretsEnv` names operator Secrets; GITHUB_TOKEN, never a PAT).
- Image uid posture: `USER 1000:1000` default, NOT required — rootless passthrough must work (k8s `runAsUser`).
- No musl/alpine; base is `node:22-bookworm-slim`.
- No extensions or DevOps binaries baked into the image beyond the npm-declared built-ins and the apt userland set.
- Built-in resolution: any image build MUST go through `publish-deps.mjs registry` + lock regen (dev `file:` shape dangles in a build context).
- `workflow_dispatch` re-releases an EXISTING tag only (required `tag` input, fail loud when absent).
- Chart ownership: `sigrun.extensions.enabled` + `sigrun.settings` re-asserted every boot; `sigrun.extensions.settings.<slug>` seed-once; env (`SIGRUN_EXTENSIONS`, `SIGRUN_EXT_*`) always wins over files — documented, not validated.
- Comments explain why (constraints/invariants), never narrate the what.
- Verification before completion: `npm test` + `npm run typecheck` clean; docker-dependent checks run where docker exists (local/CI image job), helm-dependent checks need `helm` on PATH (existing manifests.test.ts convention).

## Review Focus

1. **Registry-mode built-ins** — an image built from the dev `file:` shape boots with all three built-ins quarantined (silent). Pin: the built-image verification resolves `@sigrun/ext-mcp` etc. inside the container (Task 1, Step 6).
2. **Seeder preserves foreign keys** — re-assert must not clobber settings.json keys the chart doesn't own (admin-API writes). Pinned in Task 2 tests.
3. **Seed-once** — an extension's own `settings/<slug>.json` edits survive pod restarts. Pinned in Task 2 tests.
4. **Rootless passthrough** — under a non-root uid the entrypoint execs WITHOUT attempting chown (EPERM would kill the boot). Pinned in Task 1 verification (`docker run --user 1001`).
5. **Tools fail loud** — a failed download exits nonzero so the initContainer CrashLoops visibly. Pinned in Task 3 tests.

---

### Task 1: Dockerfile rework + entrypoint

**Files:**
- Modify: `Dockerfile` (full rewrite of stages)
- Create: `docker/entrypoint.sh`
- Modify: `.dockerignore`

**Interfaces:**
- Produces: image with `ENTRYPOINT ["/usr/local/bin/sigrun-entrypoint.sh"]`, `CMD ["node", "dist/index.js"]`; env `SG_UID`/`SG_GID` (defaults 1000), `NPM_CONFIG_CACHE=/cache/npm`; build-arg `APP_VERSION`; userland incl. `rg`, `fd` (symlink from `fdfind`), `jq`, `curl`, `git`, `sqlite3`, `unzip`, `zip`, `procps`; `/usr/local/share/sigrun/` scripts dir (later tasks COPY there).

- [ ] **Step 1: Write `docker/entrypoint.sh`**

Contract: when euid 0 → `chown -R` is NOT used; `chown` only the two mount points `/data` `/cache` (and `/home/node` if root-writable) to `$SG_UID:$SG_GID`, then `exec setpriv --reuid="$SG_UID" --regid="$SG_GID" --init-groups "$@"`. When non-root → `exec "$@"` immediately (no chown attempts — Review Focus 4). `set -eu`; shebang `#!/bin/sh` (bookworm-slim has dash; no bash requirement at entry).

- [ ] **Step 2: Rework the Dockerfile**

Stages `base`/`deps`/`build`/`prod`/`runtime` per spec §1: deps = full `npm ci` (mount-cached); build = `npm run build && npm run build:webui`; prod = manifests-only re-copy + `npm ci --omit=dev`; runtime = base + apt userland + `COPY --from=prod /app/node_modules` + `COPY --from=build /app/dist /app/webui/dist /app/shared /app/tui /app/package.json` + scripts. `ARG APP_VERSION` feeds the OCI version label (drop the hardcoded 0.1.0). `RUN ln -s /usr/bin/fdfind /usr/local/bin/fd` (Debian's fd-find name). `chmod +x` the entrypoint; `USER 1000:1000` numeric.

- [ ] **Step 3: Tighten `.dockerignore`**

Add: `docs/`, `test/`, `spikes/`, `charts/`, `test-results/`, `.playwright/`. KEEP `docker/` in context (scripts COPY from it — the spec's resolved contradiction).

- [ ] **Step 4: Registry-mode dance + local build**

Run: `node scripts/publish-deps.mjs registry && npm install --package-lock-only && docker build -t sigrun:workflow . && node scripts/publish-deps.mjs file`
Expected: build succeeds. (Local full build ≈ 10 min; CI mounts caches.)

- [ ] **Step 5: Entrypoint behavior verification**

Run: `docker run --rm --user 1001 sigrun:workflow node -e "console.log(process.getuid())"` → `1001`; `docker run --rm sigrun:workflow id -u` → `1000`; root-started run chowns /data (tmp volume) and still drops.
Expected: both uid paths exec cleanly.

- [ ] **Step 6: Built-in resolution + userland probe (Review Focus 1)**

Run: `docker run --rm sigrun:workflow node -e "for (const n of ['@sigrun/ext-mcp','@sigrun/ext-codemode','@sigrun/ext-tool-search']) require('node:module').createRequire(process.cwd()+'/package.json').resolve(n)"` — or the ESM `import.meta.resolve` equivalent consistent with `src/harness/builtins.ts` (createRequire on `/app/package.json`).
Expected: all three resolve; plus `rg --version && fd --version && jq --version && sqlite3 --version` succeed in the same image.

- [ ] **Step 7: Boot smoke**

`docker run --rm -e SIGRUN_STORAGE_PATH=/tmp/s.db -e SIGRUN_DEFAULT_MODEL=openai/gpt-4o-mini sigrun:workflow node dist/index.js` with a temp config dir → process starts and logs the HTTP listen (kill after). Expected: no quarantine errors in boot log.

- [ ] **Step 8: Commit**

`git add Dockerfile docker/entrypoint.sh .dockerignore && git commit -m "image: bookworm-slim multi-stage, non-root entrypoint, agent userland"`

### Task 2: settings seeder script

**Files:**
- Create: `docker/seed-settings.sh`
- Test: `test/seed-settings.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 except shipping location (`COPY docker/*.sh /usr/local/share/sigrun/` — add to Task 1's runtime stage here if not already; amend the COPY line).
- Produces: `seed-settings.sh CONFIG_DIR FLEET_JSON SETTINGS_JSON EXT_SETTINGS_JSON` — argv are JSON strings rendered by the chart via `toJson`. Behavior: (a) merge SETTINGS_JSON into `CONFIG_DIR/settings.json` (foreign keys preserved, chart keys overwritten, `extensions` set to FLEET_JSON array); (b) for each slug in EXT_SETTINGS_JSON, write `CONFIG_DIR/settings/<slug>.json` ONLY if absent (seed-once); (c) atomic-ish writes (tmp + mv); (d) exit nonzero on unparseable argv JSON (fail loud).

- [ ] **Step 1: Write failing tests**

`test/seed-settings.test.ts`, execFile the script with a temp dir: (1) empty config → settings.json created with fleet + settings merged; (2) pre-existing settings.json with foreign key `"server": {...}` + fleet → foreign key survives, `extensions` replaced; (3) pre-existing `settings/memory-markdown.json` with modified content + EXT_SETTINGS_JSON entry → content UNCHANGED (seed-once); absent slug → seeded; (4) malformed JSON argv → nonzero exit. jq is the implementation's parser (already a runtime dep).

- [ ] **Step 2: Run to verify failure** — `npx vitest run test/seed-settings.test.ts` → FAIL (script absent).

- [ ] **Step 3: Implement `docker/seed-settings.sh`** — jq-based; `set -eu`; no chown (initContainers run under the pod security context).

- [ ] **Step 4: Tests pass** — rerun vitest → PASS.

- [ ] **Step 5: Commit** — `git commit -m "deploy: settings seeder (re-assert fleet + seed-once extension settings)"`

### Task 3: tools-install script

**Files:**
- Create: `docker/tools-install.sh`
- Test: `test/tools-install.test.ts`

**Interfaces:**
- Produces: `tools-install.sh DIR SPEC...` where SPEC = `name@version`; fixed URL catalog for `kubectl helm talosctl flux k9s` (URL templates per spec §5); per-spec download into `DIR/bin`; `DIR/.catalog-sha` (sha256 of the sorted spec list) short-circuits unchanged lists; unknown tool name OR failed fetch → exit nonzero naming the spec (Review Focus 5).

- [ ] **Step 1: Write failing tests** — offline: (1) unknown tool `foo@v1` → nonzero, message names it; (2) catalog hit with a `file://` URL overridden via a test-only env hook? NO — keep the catalog real; test the hash short-circuit instead: run once against a stub DIR with specs, assert `.catalog-sha` written and a second run is a no-op (no network: first run short-circuits too when the hash file is pre-written with the correct sha — compute expected sha in the test); (3) failed fetch: point the catalog at an unreachable URL via the script's `TOOL_URL_OVERRIDE_<NAME>` test seam (documented in the script as the seam, not config surface) → nonzero exit.
- [ ] **Step 2: Verify failure** → FAIL.
- [ ] **Step 3: Implement** — `curl -fsSL`, `tar -xz` for archives vs raw binaries (catalog carries the shape); `set -eu`.
- [ ] **Step 4: Tests pass** → PASS.
- [ ] **Step 5: One real fetch check (docker-equipped environments)** — `docker run --rm sigrun:workflow /usr/local/share/sigrun/tools-install.sh /tmp/t kubectl@v1.32.0 && ls` — best-effort, skip-if-no-network.
- [ ] **Step 6: Commit** — `git commit -m "deploy: deploy-time tools installer with hash-cached catalog"`

### Task 4: chart — sigrun values block, initContainers, args migration, schema

**Files:**
- Modify: `charts/sigrun/values.yaml`, `charts/sigrun/templates/common.yaml`
- Create: `charts/sigrun/values.schema.json`
- Test: `test/manifests.test.ts` (extend)

**Interfaces:**
- Consumes: Task 2/3 scripts at `/usr/local/share/sigrun/` (image path); Task 1 image ENTRYPOINT.
- Produces values shape (documented in values.yaml comments):
  ```yaml
  sigrun:
    settings: {}                    # re-asserted into settings.json
    extensions: { enabled: [], settings: {} }   # fleet list; seed-once per-slug
    secretsEnv: []                  # existing-Secret names → envFrom on main container
    tools: { enabled: true, dir: /data/tools, packages: ["kubectl@v1.32.0"] }
  ```
  Renders: seed initContainer + tools initContainer (app image, config/data volumes, pod security context) via bjw-s `controllers.main.initContainers`; main + backup containers switch `command:` → `args:` (ENTRYPOINT contract); `PATH` env prepends `tools.dir` when tools enabled; `envFrom` gains each `secretsEnv` secretRef. values.schema.json validates the `sigrun:` block (fleet array of strings; per-slug objects freeform — `additionalProperties: true`; secretsEnv string array; tools packages `^[a-z0-9-]+@v?[0-9][^@]*$`-ish pattern) and passes everything else through.

- [ ] **Step 1: Extend manifests.test.ts — failing**

New describes: (1) render with `sigrun.extensions.enabled=['npm:@sigrun/memory-markdown@^0.1.0']`, `sigrun.extensions.settings.memory-markdown={...}`, `sigrun.tools.packages=['kubectl@v1.32.0']`, `sigrun.secretsEnv=['my-sec']` → exactly one seed + one tools initContainer; seed args contain the rendered JSON argv; main container has NO `command` and `args: [node, dist/index.js]`; backup cronjob args carry the backup entry; PATH env contains the tools dir; envFrom carries `my-sec`. (2) Default render → NO initContainers, no tools PATH. (3) Schema negative: `helm template` with `--set sigrun.extensions.enabled=notanarray` fails with a values-validation error. (4) Existing portable-invariant tests still pass unmodified.

- [ ] **Step 2: Verify failure** → FAIL (no sigrun block).
- [ ] **Step 3: Implement values + template + schema.** Seed argv JSON via `toJson`; keep the existing env wiring intact; comments per the env-wins ruling (mutually exclusive with `SIGRUN_EXTENSIONS`, precedence note for `SIGRUN_EXT_*`: stored wins over env).
- [ ] **Step 4: `npx vitest run test/manifests.test.ts` → PASS** (helm required, existing convention).
- [ ] **Step 5: `npm test` full suite + `npm run typecheck` → clean.**
- [ ] **Step 6: Commit** — `git commit -m "chart: sigrun values block — extension fleet, secrets refs, tools, args migration"`

### Task 5: compose modernization

**Files:**
- Modify: `docker/docker-compose.yaml`, `docker/README.md`
- Test: `test/manifests.test.ts` (compose assertions)

- [ ] **Step 1: Extend compose assertions — failing**: `init: true`; `read_only: true` + tmpfs `/tmp` and `/cache`; `cap_drop: [ALL]`; `security_opt: [no-new-privileges:true]`; `user: ${SIGRUN_UID:-1000}:${SIGRUN_GID:-1000}`; image tag parametrized `${SIGRUN_IMAGE_TAG:-0.1.4}`; `SIGRUN_EXTENSIONS` passthrough env.
- [ ] **Step 2: Verify failure** → FAIL.
- [ ] **Step 3: Implement compose + README updates** (new env knobs documented; note read_only relies on writes confined to /data,/cache,/tmp and NPM_CONFIG_CACHE).
- [ ] **Step 4: Local live check (docker-equipped)**: `docker compose -f docker/docker-compose.yaml config` parses; best-effort `up` against the Task 1 image with a dummy model → healthy.
- [ ] **Step 5: Commit** — `git commit -m "compose: hardened defaults (read-only rootfs, caps, init)"`

### Task 6: CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`
- Test: `test/workflows.test.ts`

**Interfaces:**
- Produces: jobs `test` (sigrun at `./sigrun` + the three ext repos at `./sigrun-ext-*` sibling checkout paths — the `file:` specifiers resolve against the runner workspace; `npm ci && npm test && npm run typecheck`; node 22 + npm cache; helm via azure/setup-helm for manifests tests), `image-build` (registry-mode dance → `docker/build-push-action` push:false, linux/amd64), `chart-lint` (helm dependency update + lint + template; the vendored tgz is gitignored). `permissions: contents: read`.

- [ ] **Step 1: Write failing workflow-structure test** — `test/workflows.test.ts` parses `.github/workflows/ci.yml` (YAML) and asserts: trigger on pull_request + push main; the four checkout `path:`s (`sigrun`, the three ext repos); the registry-mode step string (`publish-deps.mjs registry` followed by `--package-lock-only`); push:false; permissions read.
- [ ] **Step 2: Verify failure** → FAIL.
- [ ] **Step 3: Author ci.yml** per Interfaces; comments only where non-obvious (sibling layout rationale).
- [ ] **Step 4: Test passes** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "ci: tests, image build check, chart lint"` (live validation happens post-push, Task 8).

### Task 7: release workflow + smoke runbook

**Files:**
- Create: `.github/workflows/release.yml`
- Modify: `docs/superpowers/specs/…design.md` — no; runbook goes in `docker/README.md`? Better: `charts/sigrun/RELEASE.md` (release runbook home).
- Test: `test/workflows.test.ts` (extend)

**Interfaces:**
- Produces: trigger `push: tags: ['v*']` + `workflow_dispatch` with REQUIRED `tag` input (checkout `refs/tags/<tag>`, `git describe --exact-match` guard → fail loud if absent); jobs: `image` (registry-mode dance, buildx `linux/amd64,linux/arm64`, push `<semver>` + `latest`, `APP_VERSION` build-arg, docker/login-action with GITHUB_TOKEN) and `chart` (rewrite Chart.yaml version/appVersion from the tag via `sed` on the two pinned-format lines, `helm package`, `helm push oci://ghcr.io/sigrun-ai/charts/sigrun` after `helm registry login` with GITHUB_TOKEN); `permissions: { contents: read, packages: write }`. RELEASE.md documents: tag flow, dispatch re-release semantics (image tag overwrites; chart re-push of same version FAILS — half-idempotent by design), GHCR visibility flip step, and the throwaway smoke procedure (`v0.0.0-ci.<sha>` → verify → delete tag → delete ci package versions; deletion needs `admin:packages` — user-side if the CLI token lacks it).

- [ ] **Step 1: Extend workflow test — failing**: parse release.yml; assert tag trigger + required dispatch input; exact-match guard step present; both OCI destinations (`ghcr.io/sigrun-ai/sigrun`, `oci://ghcr.io/sigrun-ai/charts/sigrun`); `packages: write`; no PAT secret referenced (only `secrets.GITHUB_TOKEN`).
- [ ] **Step 2: Verify failure** → FAIL.
- [ ] **Step 3: Author release.yml + RELEASE.md.**
- [ ] **Step 4: Test passes** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "release: GHCR image + chart OCI publishing on v-tags"`

### Task 8: rollout (operational, user-in-loop)

**Files:** none (operations) — tracked as checklist steps.

- [ ] **Step 1: Needle-scan the 8 public-flip candidates** — `git grep -lE 'tayra-beaufort|macfort|nullpointer'` per repo tip (+ `token`-shaped hits eyeballed); expect zero (2026-10-13/15 scrubs; belt check).
- [ ] **Step 2: Push sigrun main** (user confirms; local is ahead by spec work + this branch).
- [ ] **Step 3: Flip repos public** — `gh repo edit sigrun-ai/<repo> --visibility public` for sigrun, ext-{codemode,mcp,tool-search}, provider-{ollama,opencode,pareto,bifrost}; NOT sigrun-memory-markdown.
- [ ] **Step 4: Confirm CI green on main** (first Actions run: free minutes post-flip).
- [ ] **Step 5: Smoke release** — push `v0.0.0-ci.<shortsha>`; verify image (multi-arch manifest inspect, `docker run` probes from Task 1) + `helm pull oci://ghcr.io/sigrun-ai/charts/sigrun --version 0.0.0-ci.<sha>`; flip both GHCR packages public.
- [ ] **Step 6: Cleanup** — delete the ci tag; delete ci package versions (`gh api -X DELETE …/versions/<id>`; user-side if token lacks admin:packages).
- [ ] **Step 7: First real release** — user bumps versions/publishes npm family (unchanged flow), tags `v0.1.5` (or 0.2.0), workflow ships; Flux-side wiring (hub ImageRepository/OCI HelmRepository + satellite HelmRelease) is the user's GitOps move, documented in RELEASE.md.
