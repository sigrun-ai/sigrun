# Releasing sigrun (image + chart)

The release pipeline is `.github/workflows/release.yml`: push a `v<semver>`
tag and it ships the multi-arch image to `ghcr.io/sigrun-ai/sigrun` and the
Helm chart to the GHCR OCI registry (`ghcr.io/sigrun-ai/charts/sigrun`).
This runbook covers the flow, the re-release semantics, the one-time GHCR
visibility flip, the throwaway smoke procedure, and the Flux wiring pointer.

## Release flow (the human's part)

1. **Bump family versions** — sigrun and any extension/provider family
   members being released (`package.json` versions; the chart's
   `version`/`appVersion` in `charts/sigrun/Chart.yaml` are rewritten
   from the tag by the workflow, so only the npm-side versions need
   bumping by hand).
2. **Publish the npm family from the dev machine** — unchanged today:
   `npm publish` per repo (the `prepublishOnly`/`postpublish` hooks run
   `scripts/publish-deps.mjs registry`/`file` for sigrun's built-ins).
   A fast-follow replaces this manual publish with workflow-driven
   publishing.
3. **Push main**: the commits being released must be on `main` (CI's
   test gate runs there).
4. **Tag and push the tag**:

   ```sh
   git tag v0.1.5
   git push origin v0.1.5
   ```

5. The workflow ships:
   - `ghcr.io/sigrun-ai/sigrun:0.1.5` and `:latest` —
     `linux/amd64` + `linux/arm64`, the `APP_VERSION` build-arg (the
     image's `org.opencontainers.image.version` label) set to the
     stripped semver, so image tag, label, and chart appVersion all
     read `0.1.5`.
   - `ghcr.io/sigrun-ai/charts/sigrun/sigrun` chart version `0.1.5`
     (`Chart.yaml` `version` and `appVersion` rewritten from the tag,
     `v` stripped; `helm push` appends the chart NAME as a final path
     segment, so the OCI repo is `charts/sigrun/sigrun` — flux's
     `HelmRepository` must point at `oci://ghcr.io/sigrun-ai/charts/sigrun`
     and request chart `sigrun`).

Authentication is the workflow's own `GITHUB_TOKEN`
(`permissions: contents: read, packages: write`) — no PATs, no stored
secrets anywhere in the pipeline.

## Dispatch re-release semantics

`workflow_dispatch` takes a **required `tag` input** and re-runs the
release for an EXISTING tag: the workflow checks out `refs/tags/<tag>`
and a guard step fails loud if that ref does not exist as an
exact-match tag. It exists for re-running a failed release after a fix
— **never for building arbitrary SHAs**.

Idempotency boundary (by design, not worked around):

- **Image**: re-pushing a tag overwrites the image tags in GHCR — the
  re-run converges.
- **Chart**: `helm push` of an already-existing chart version FAILS
  (the registry refuses the overwrite). To re-ship a chart you must
  delete the package version in GHCR first (see the smoke cleanup
  commands below) — or, normally, cut a new tag.

A re-run is therefore *half-idempotent*: safe for the image, refused
for the chart.

## GHCR visibility flip (one-time, manual — WEB UI only)

Packages are born private in GHCR. After the first release, flip the two
packages to public so anonymous pulls work (the homelab cluster's
included). **There is no API for this**: the REST org-packages surface
exposes only Get/List/Delete/Restore (verified against the official
endpoint index and by live probes — a PATCH to
`/orgs/<org>/packages/container/<name>` returns 404, and GraphQL has no
package-visibility mutation; blog recipes claiming a PATCH work-around
are cargo-cult). The scopes `write:packages`/`delete:packages` govern
deletion and restore, not visibility. Do it once, in the browser:

1. `https://github.com/orgs/sigrun-ai/packages` → package
   `sigrun` → *Package settings* → *Danger Zone* → *Change visibility* →
   **Public**.
2. Same for the chart package: it appears in the org list under the
   `charts/sigrun/sigrun` name — `helm push` appends the chart NAME as
   a final path segment, so the OCI repository is
   `ghcr.io/sigrun-ai/charts/sigrun/sigrun` (NOT `.../charts/sigrun`).

Until the flip, pulls need a GitHub token with `read:packages`.

## Release smoke test (throwaway)

The push path can't be exercised off-repo (a fork's `GITHUB_TOKEN`
cannot push to the org GHCR namespace), so the smoke is a full workflow
run against a throwaway tag on the REAL repo. Packages stay private
until the visibility flip, so nothing transient is ever publicly
visible.

1. **Push a throwaway tag** (short SHA of any main commit):

   ```sh
   git tag "v0.0.0-ci.$(git rev-parse --short HEAD)"
   git push origin "v0.0.0-ci.$(git rev-parse --short HEAD)"
   ```

2. **Verify the artifacts** once the run is green:

   ```sh
   # Multi-arch image manifest (both platforms present):
   # (needs a docker login to ghcr.io until the visibility flip)
   docker manifest inspect ghcr.io/sigrun-ai/sigrun:0.0.0-ci.<shortsha>
   # Chart round-trip from the OCI registry — NOTE the /sigrun suffix
   # (helm push appends the chart name as a path segment):
   helm registry login ghcr.io -u <user>   # needs read:packages until public
   helm pull oci://ghcr.io/sigrun-ai/charts/sigrun/sigrun \
     --version 0.0.0-ci.<shortsha>   # v stripped for the chart version
   ```

   (Image runs can be spot-checked with the verification steps in the
   design doc's smoke section: version label, uid 1000, `/healthz`.)

3. **Delete the tag**:

   ```sh
   git push origin :refs/tags/v0.0.0-ci.<shortsha>
   ```

4. **Delete the ci package versions** from GHCR so the throwaway
   artifacts don't linger. The image package is at `container/sigrun`;
   the chart is a CONTAINER package named `charts/sigrun/sigrun`
   (URL-encoded `charts%2Fsigrun%2Fsigrun` in API paths). The
   `0.0.0-ci.*` prefix filter in the jq is the safety boundary — the
   command must never see real release versions (an unfiltered pipe
   would delete every released image/chart version once real releases
   exist). One extra trap, learned live: **the LAST TAGGED version of a
   package cannot be deleted** (400 — "you must delete the package
   instead"); and the smoke's multi-arch push leaves UNtagged platform
   versions beside the tagged one that the filter won't match. For a
   pure-smoke package the honest move is deleting the whole PACKAGE
   (both packages hold nothing but smoke artifacts, and the first real
   release re-creates them):

   ```sh
   # smoke cleanup, package-level (safe ONLY while the package holds
   # nothing but 0.0.0-ci.* artifacts — this is the smoke's own state):
   gh api -X DELETE /orgs/sigrun-ai/packages/container/sigrun
   gh api -X DELETE /orgs/sigrun-ai/packages/container/charts%2Fsigrun%2Fsigrun

   # version-level alternative for a package that ALSO holds real
   # releases (0.0.0-ci.* filter; will 400 on the last tagged ci
   # version — untoggle it by deleting the package, or leave the last
   # ci version as a marker):
   gh api /orgs/sigrun-ai/packages/container/sigrun/versions \
     --jq '.[] | select(.metadata.container.tags[] | startswith("0.0.0-ci.")) | .id' \
     | xargs -r -n1 -I{} gh api -X DELETE \
         /orgs/sigrun-ai/packages/container/sigrun/versions/{}
   ```

   Note: version/package deletion needs `read:packages` +
   `delete:packages` scopes (classic PAT) and admin on the package —
   org owners have it automatically.

## Flux wiring (the GitOps move — pointer only)

The homelab consumes the artifacts via Flux, not by hand:

- Hub cluster: an `ImageRepository` watching `ghcr.io/sigrun-ai/sigrun`
  and an OCI `HelmRepository` at
  `oci://ghcr.io/sigrun-ai/charts/sigrun` serving chart `sigrun`
  (helm's path-segment convention: the repository URL ends one segment
  above the chart name — needs an `imagePullSecret`/cert config if the
  chart package is still private).
- Satellite: the `HelmRelease` referencing chart `sigrun` from that
  repository, `chart.spec.version` advanced per release (or automated
  via an `ImagePolicy`/`Policy` controller).

The exact manifests are the user's GitOps move in the flux repos —
kept out of this runbook on purpose.

## Where things live

| Thing | Path |
| --- | --- |
| Release workflow | `.github/workflows/release.yml` |
| CI (build check, no push) | `.github/workflows/ci.yml` |
| Workflow contract tests | `test/workflows.test.ts` |
| Dockerfile (APP_VERSION label) | `Dockerfile` |
| Chart | `charts/sigrun/` |
