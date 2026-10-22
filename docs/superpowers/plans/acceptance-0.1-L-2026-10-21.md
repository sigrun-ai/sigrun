# Sigrun 0.1 Acceptance Run — L (workstation) — 2026-10-21

Executed against the scrubbed, post-release-merge tree (main @ 51e617f):
- clean-install from the local `npm pack` tarball (registry-shape deps via
  `publish-deps.mjs registry` + pre-seeded sibling ext tarballs, since the
  family is not yet on npm),
- `@sigrun/shared` bundled via `bundleDependencies` (node_modules nested copy),
- boot with a settings-file-only `defaultModel` (no env model).

The full grid (A–P) runs post-publish per the plan; this file records the
workstation-verifiable slice plus the pre-publish packaging proof.

## A. Install and first run

| id | result | note |
|---|---|---|
| A1 (install) | pass | `npm install <tarball>` → 130-file root pkg, bundled shared, 3 seeded ext deps; `serve` boots. `--version` flag is not a flag (usage banner) — `sigrun --version` prints usage; version lives in package metadata. |
| A2 (builtins) | pass | `GET /v1/extensions` (auth'd): codemode, sigrun-mcp, tool-search — all `builtin: true`, `status: "ok"`, v0.1.0. |
| A3 (setup gate) | pass | pre-claim: `403 {"error":"setup_required"}` on `/v1/extensions`, `/v1/conversations`. |
| A4 (claim) | pass | `POST /v1/onboarding/claim {user, code, issueToken}` → admin + `sgr_` token; `POST /v1/auth/login {token}` → `{user:"admin"}` + session cookie; code file cleared after claim (second claim → invalid). Note: the claim body key is `user` (not `name`). |
| A5 (health) | pass | `/healthz` → `sigrun_liveness 1`; `/readyz` → `sigrun_readiness 1`; `/metrics` (auth'd) carries `sigrun_up 1`, `sigrun_ready 1`. |
| A6 (encoded path) | pass | `GET /%761/settings` unauthenticated → 401. |
| A7 (host/origin) | pass | loopback bind: Host header check exempt by design; foreign-`Origin` POST → `{"error":"origin_mismatch"}` (403). |

## C. Conversations and runs (auth-only slice)

| id | result | note |
|---|---|---|
| C1-lite (list) | pass | `GET /v1/conversations` → owner/access/archived/pinned shape. |
| C2 (submit) | pass | `POST /v1/conversations` → 201. |

Live chat/steer/abort/resume cases (C1–C8) require a live provider — deferred
to the post-publish run per the plan.

## Packaging (release plan Task: publish-shape verification)

- Tarball: 130 files, `bundleDependencies: ["@sigrun/shared"]` resolves at
  runtime from the nested `node_modules` — no registry lookup.
- Dev/registry dep rewrite (`publish-deps.mjs`) round-trips byte-exact.
- Regression fixed en route: **settings-file-only `defaultModel` now boots**
  (serve()'s env-only `loadConfig` previously threw before the file was read);
  deploy-entry regression test added (6/6 in that file).

## Result

**Pass** for the workstation-verifiable slice. D (Docker) and K (k8s) channels,
and all provider-dependent cases, run after Phase 2 publish with the real
image/chart.
