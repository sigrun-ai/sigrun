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
   - `oci://ghcr.io/sigrun-ai/charts/sigrun` chart version `0.1.5`
     (`Chart.yaml` `version` and `appVersion` rewritten from the tag,
     `v` stripped).

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

## GHCR visibility flip (one-time, manual)

Packages are born private in GHCR. After the first release, flip the two
packages to public so anonymous pulls work (the homelab cluster's
included):

1. `https://github.com/orgs/sigrun-ai/packages` → package
   `sigrun` → *Package settings* → *Danger Zone* → *Change visibility* →
   **Public**.
2. Same for the chart package `sigrun` under the `charts/sigrun`
   path (it appears as `charts/sigrun` in the org package list).

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
   # Chart round-trip from the OCI registry:
   helm registry login ghcr.io -u <user>   # needs read:packages until public
   helm pull oci://ghcr.io/sigrun-ai/charts/sigrun \
     --version 0.0.0-ci.<shortsha>   # v stripped for the chart version
   ```

   (Image runs can be spot-checked with the verification steps in the
   design doc's smoke section: version label, uid 1000, `/healthz`.)

3. **Delete the tag**:

   ```sh
   git push origin :refs/tags/v0.0.0-ci.<shortsha>
   ```

4. **Delete the ci package versions** from GHCR so the throwaway
   artifacts don't linger (both packages are org-owned; the chart lands
   as a container package named `charts/sigrun`). The
   `0.0.0-ci.*` prefix filter in the jq is the safety boundary — the
   command must never see real release versions (an unfiltered pipe
   would delete every released image/chart version once real releases
   exist):

   ```sh
   # image versions tagged 0.0.0-ci.* only:
   gh api /orgs/sigrun-ai/packages/container/sigrun/versions \
     --jq '.[] | select(.metadata.container.tags[] | startswith("0.0.0-ci.")) | .id' \
     | xargs -r -n1 -I{} gh api -X DELETE \
         /orgs/sigrun-ai/packages/container/sigrun/versions/{}

   # chart package (charts/sigrun — name is URL-encoded in the path;
   # same 0.0.0-ci.* filter):
   gh api '/orgs/sigrun-ai/packages/container/charts%2Fsigrun/versions' \
     --jq '.[] | select(.metadata.container.tags[] | startswith("0.0.0-ci.")) | .id' \
     | xargs -r -n1 -I{} gh api -X DELETE \
         '/orgs/sigrun-ai/packages/container/charts%2Fsigrun/versions/{}'
   ```

   Note: version deletion needs the `admin:packages` scope — if the CLI
   token lacks it, this step is user-side (the web UI path — package →
   versions → delete — is fine for a throwaway).

## Flux wiring (the GitOps move — pointer only)

The homelab consumes the artifacts via Flux, not by hand:

- Hub cluster: an `ImageRepository` watching `ghcr.io/sigrun-ai/sigrun`
  and an OCI `HelmRepository` (`oci://ghcr.io/sigrun-ai/charts` —
  needs an `imagePullSecret`/cert config if the chart package is still
  private).
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
