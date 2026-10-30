# Releasing the sigrun family

Twelve repos ship together: `sigrun` (core), five built-in extensions, the
memory extension, and four providers. **Pushing a `v*` tag publishes.** Each
repo publishes itself, so a tag is the approval point and there is no separate
publish step to remember — and no stored npm token anywhere: the workflows
authenticate with OIDC trusted publishing.

That also means a tag cannot be "just a marker". Read the bump order below
before tagging anything.

| What a tag does | Job |
| --- | --- |
| Every extension/provider repo | `release.yml` → `guard` → `test` → `publish` (npm) |
| `sigrun` (core) `v*` | `release.yml` → `guard` → `sandbox` → `publish-npm` → `await-registry` → `smoke` → `image` |
| `sigrun` (core) `chart-v*` | `chart-release.yml` → `guard` → `chart` (Helm only) |

**The chart has its own tag namespace and its own version line.** A chart's
`version` is its packaging version; its `appVersion` is the CORE release it
deploys. They are deliberately independent, so a chart-only fix never needs a
core release (and never burns a core version number).

## Before you tag: bump order

Extensions and providers **first**, core last. Core's release waits for the
registry to serve its siblings' versions (`await-registry`), so a core tag
whose siblings are not published yet stops before it ships the image.
Gateway's published 0.1.3 has an exact `@sigrun/shared` 0.2.1 peer, so a fresh
registry-mode core 0.3.0 install can fail with `ERESOLVE`. Before core's
`smoke` release gate runs, gateway must complete its phase-2b republish with a
widened `@sigrun/shared` peer; extensions-first ordering alone does not avoid
this skew. With the published core shape, the stale-peer case instead degrades
to a warning because shared is bundled: npm nests core's 0.3.0 copy alongside
the top-level 0.2.1 copy, leaving two shared copies in the install tree.

1. **Extension and provider versions** — one `package.json` bump each, plus a
   CHANGELOG entry.
2. **Core-family versions** — these four move together, and tests enforce it:

   | Bump | Enforced by |
   | --- | --- |
   | `package.json` (core) | — |
   | `shared/package.json` | `test/package-manifest.test.ts` |
   | `tui/package.json` | `test/package-manifest.test.ts` |
   | **both** `sandbox/npm/linux-{x64,arm64}/package.json` | `test/package-manifest.test.ts` |
   | every built-in's `@sigrun/shared` peer | `test/builtins-wiring.test.ts` |

   A core bump that forgets the sandbox manifests or a built-in's
   `@sigrun/shared` peer fails core's own suite — that is deliberate.

   The chart's `appVersion` is bumped WITH the core family (the in-tree value
   tracks the current core version); `chart-release.yml` additionally re-reads
   it from package.json at the tagged commit. The
   chart's `version` comes from the `chart-v<semver>` tag. The Dockerfile's
   version label comes from the `APP_VERSION` build-arg, derived from the tag.

## Releasing the chart alongside a core release

The chart is published by `chart-release.yml`, which triggers on `chart-v*`
tags — separately from core's `v*`. To ship both, **put both tags on the same
commit**:

```sh
git tag v0.2.0          # npm + image
git tag chart-v0.2.0    # chart; appVersion auto-reads 0.2.0
git push origin v0.2.0 chart-v0.2.0
```

The two workflows run independently and neither blocks the other. The chart
job resolves `appVersion` from the tagged commit's `package.json` (not from a
registry query — that would race the core publish and could pin the chart to
the PREVIOUS version permanently), then **waits for that image to be live**
before pushing. A chart that names an image nobody built yet would deploy into
`ImagePullBackOff` and could not be replaced.

Chart-only fix (no core change): bump `charts/sigrun/Chart.yaml`'s `version`,
commit, then tag `chart-v<that version>` on that commit. `appVersion` keeps
pointing at the current core release automatically.

**Caveat:** `appVersion` reads `package.json` at the tagged commit, so a
chart-only tag must be cut while `main` still carries the released core
version. If `package.json` has already moved ahead (say to `0.3.0`) without
that release shipping, the chart job waits 10 minutes for an image that never
appears and fails — which is the honest outcome, not a silent bad chart.

## Tag order

1. Tag the extensions and providers.
2. **Wait for each release run to go green.** Their publish is what core's
   `await-registry` waits on; a red sibling means core stops before the image.
3. Tag core (`v*`). Its release ships npm, waits for the registry, smokes a
   real registry install, and only then pushes the image — so a `v*` tag on
   core means "npm + image, or nothing".
4. For a chart release, put `chart-v<semver>` on the SAME commit (see above).
   It runs independently and waits for the image itself.

**A tag push publishes, so it needs the operator's explicit go for that
specific tag.** Never create, push, move, or delete a `v*` or `chart-v*` tag
on your own initiative. Since the tag rulesets landed, BOTH namespaces are
immutable (creation stays allowed) — a mistyped tag is permanent and its
version number is burned, because npm and `helm push` both refuse to
republish a version.

## Dry runs (use these instead of a throwaway tag)

The old procedure pushed a `v0.0.0-ci.<sha>` tag and deleted it afterwards.
Both halves are now impossible or pointless: tags are immutable, and the guard
rejects a tag whose version does not match `package.json`. The dry-run dispatch
replaces it and touches nothing:

```sh
# Core: guard (dry-run-ref mode), sandbox build, npm publish --dry-run,
# image build without pushing. await-registry and smoke are skipped.
gh workflow run release.yml -R sigrun-ai/sigrun \
  -f dry-run=true -f ref="$(git rev-parse origin/main)"

# The chart: guard (dry-run-ref mode) then package without pushing.
gh workflow run chart-release.yml -R sigrun-ai/sigrun \
  -f dry-run=true -f ref="$(git rev-parse origin/main)"

# An extension or provider:
gh workflow run release.yml -R sigrun-ai/sigrun-ext-mcp \
  -f dry-run=true -f ref="$(git rev-parse origin/main)"
```

Run a dry run whenever the release machinery changed, and always before a
release whose pipeline you have not exercised since the last change.

`-f ref` is used only when `dry-run=true`. On a real dispatch, `-f tag=<tag>`
re-runs an **existing** tag; the guard refuses a tag that does not exist or
whose version does not match the manifest.

## Re-run semantics

After a partial failure, re-run the same tag. What happens per artifact:

| Artifact | Re-run behaviour |
| --- | --- |
| **npm** | **Idempotent.** Every publish step checks the tarball URL first and skips a version that is already live. |
| **Image** | **Converges.** Re-pushing the same image tags overwrites them in GHCR. |
| **Chart** | **Skips if live.** `chart-release.yml` probes the OCI manifest first and skips a published version (`helm push` itself cannot overwrite one). To REPLACE a published chart, cut a new `chart-v` tag. |

A core release re-run is therefore safe up to the image. Because core's
`image` job needs `smoke`, a re-run does not reach it at all unless npm and
the registry smoke pass first. The chart re-run is separately safe — it skips
when its version is already on the OCI registry.

## What a red step means

- **`guard` red** — the tag is not shaped like `v<semver>` (or `chart-v<semver>
  for the chart workflow), its version does not match `package.json` /
  `Chart.yaml`, or it is not on `main`. Nothing published; no cleanup needed.
- **`test` red in an extension** — a real clean-clone breakage in that repo.
  Fix it there and cut a new tag (the version number of a failed tag is not
  burned unless the publish step ran).
- **Core `publish-npm` "pre-check" red** — a pinned family version is not on
  the registry yet. That means an extension or provider tag has not published;
  publish it, then re-run core.
- **`await-registry` timeout** — npm has not propagated the version to its CDN
  within 15 minutes. The packages are published; re-run the job. `npm view`
  lagging is not evidence of anything — the wait polls the tarball URL.
- **`smoke` red** — a registry install of core is broken (missing built-in,
  unresolvable sandbox helper, missing `@sigrun/tui`). **The image and chart
  do not ship.** This is the gate that catches a packument regression.

## Core 0.3.0 storage migration and rollback

The first 0.3.0 boot performs a **one-way SQLite durable-schema migration**
for pi-durable 1.4.0. Before opening storage, boot writes a crash-consistent
snapshot beside the database named
`<storagePath>.pre-durable-schema-v<CURRENT>-<UTC stamp>.bak`. Snapshots are
never deleted automatically. If a needed snapshot cannot be written, boot
stops before migration. `SIGRUN_SKIP_MIGRATION_SNAPSHOT=1` is the emergency
opt-out for an operator with an independent backup.

**Rollback to 0.2.x (SQLite):**

1. Stop sigrun.
2. Restore the `.bak` over the database file.
3. Remove the database's `-wal` and `-shm` sidecars.
4. Deploy 0.2.x.

Anything committed after the upgrade is lost.

**JSONL storage:** there is no snapshot because its schema does not change.
A 0.2.x process nevertheless never resumes a task left `sleeping` by 0.3.0,
so rollback can strand that task.

## Adding a package to the family

Two things are needed before CI can publish a new package: the name must exist
on npm, and a trusted publisher must point at the repo's `release.yml`.

**1. Register the name.** Staged publishing creates the placeholder for a name
npm has never seen — this is the whole bootstrap, and the reject is *not* part
of it (rejecting unpublishes the name again):

```sh
cd <package dir>
npm stage publish --provenance=false    # required locally: no OIDC here
```

`--provenance=false` is needed on a workstation only. Every package sets
`publishConfig.provenance: true`, and npm refuses to generate provenance
without an OIDC provider ("Automatic provenance generation not supported for
provider: null"). CI has one, so the real publish keeps its attestation.

Do **not** try to `npm publish` a `0.0.0-stage` tarball: npm reserves that
version for staged publishing and refuses ("You cannot publish using the
version: 0.0.0-stage").

**2. Configure the trusted publisher.** `npm trust github` is 2FA-gated, and a
granular access token cannot perform 2FA-gated account actions — it returns
`403 Granular access tokens that bypass two-factor authentication may not
perform this action`, and no key-touch changes that. Use the browser:

> npmjs.com → the package → **Settings** → **Trusted Publisher** →
> **GitHub Actions** → org `sigrun-ai`, repository `<repo>`, workflow
> filename **`release.yml`**, and tick **Allow npm publish**.

The workflow filename matters more than it looks: under `workflow_call`
npm validates the **caller's** filename, which is why every family repo's
caller is named `release.yml`. It must match exactly, including `.yml`.

All core-family packages (`sigrun`, `shared`, `tui`, and both `sandbox-*`)
name the repository **`sigrun`** — core's release publishes them, so they have
no repo of their own.

Once a config exists, `npm trust github` returns `409 Conflict` ("a trusted
publisher configuration that a token could also match already exists") — that
is a re-run succeeding, not a failure. Verify the four fields by eye in the
browser instead, because npm does not validate them at save time and a typo
only surfaces at publish.

**3. Add it to the enumerations.** `scripts/publish-deps.mjs` is the single
list the workflows' checkouts, the lock regen, and the smoke all derive from.
`test/builtins-wiring.test.ts` asserts the enumerations agree, so a package
added in one place and forgotten in another fails core's suite.

## Trusted publishers expire

A trusted-publisher configuration **expires if no successful publish uses it
within 2 days** of creation. Configure it immediately before the release that
validates it, not weeks earlier. If a release is more than two days out,
configure only the packages being released now and the rest at release time.

A config that expired is indistinguishable from one that was never set until
you publish: the publish fails with `ENEEDAUTH`. Re-add it in the browser.

## GHCR visibility (one-time, manual — browser only)

Packages are born private in GHCR. Flip the two core packages to public once
so anonymous pulls work. **There is no API for this**: the REST org-packages
surface exposes only Get/List/Delete/Restore (a `PATCH` returns 404, and
GraphQL has no package-visibility mutation — recipes claiming otherwise are
cargo-cult). `write:packages`/`delete:packages` govern deletion and restore,
not visibility.

1. `https://github.com/orgs/sigrun-ai/packages` → package `sigrun` →
   *Package settings* → *Danger Zone* → *Change visibility* → **Public**.
2. Same for the chart package, listed as `charts/sigrun/sigrun` — `helm push`
   appends the chart NAME as a final path segment, so the OCI repository is
   `ghcr.io/sigrun-ai/charts/sigrun/sigrun`, not `.../charts/sigrun`.

Until the flip, pulls need a GitHub token with `read:packages`.

## Proxy auth behind Cilium

When sigrun runs behind a Cilium Gateway API / Ingress forward-auth
proxy, `server.auth.proxy.trustedProxies` must list the per-node Cilium
ingress IPs (the address the proxy connects from, out of the pod CIDR).
If you trust the whole pod CIDR instead, enable the chart's
`networkPolicy.enabled` so only the `ingress` entity can reach the
Service; the default policy also admits `host` for kubelet probes.
Remember that the `ingress` entity covers every Cilium gateway in the
cluster, so every route to sigrun must pass through forward auth.
The full deploy contract (header hygiene, dual-stack, own-host peers,
diagnostic reasons, proxy-only onboarding) is in the core README's
Authentication → Proxy method section and Authentication → Browser
sessions and account links → Onboarding (the first claim).

## Flux wiring (pointer only)

The homelab consumes the artifacts through Flux, not by hand:

- Hub cluster: an `ImageRepository` watching `ghcr.io/sigrun-ai/sigrun`, and
  an OCI `HelmRepository` at `oci://ghcr.io/sigrun-ai/charts/sigrun` serving
  chart `sigrun` (helm's path-segment convention: the repository URL ends one
  segment above the chart name).
- Satellite: the `HelmRelease` referencing chart `sigrun`, with
  `chart.spec.version` advanced per release or automated by an
  `ImagePolicy`/`Policy` controller.

The exact manifests are the user's GitOps work in the flux repos, deliberately
kept out of this runbook.

## Where things live

| Thing | Path |
| --- | --- |
| Core release workflow | `.github/workflows/release.yml` |
| Reusable extension CI / release | `.github/workflows/ext-ci.yml`, `ext-release.yml` |
| Shared sandbox build | `.github/workflows/sandbox-build.yml` |
| Tag + version guard | `scripts/release-guard.mjs` |
| Registry wait | `scripts/await-registry.mjs` |
| Registry smoke | `scripts/smoke-registry.sh` |
| Built-in enumeration | `scripts/publish-deps.mjs` |
| CI (build check, no push) | `.github/workflows/ci.yml` |
| Workflow contract tests | `test/workflows.test.ts`, `test/release-guard.test.ts`, `test/builtins-wiring.test.ts` |
| Dockerfile (APP_VERSION label) | `Dockerfile` |
| Chart | `charts/sigrun/` |