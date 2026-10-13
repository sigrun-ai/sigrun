#!/bin/sh
# sigrun image entry (Task 8): boot-time canary pre-step, fail loud.
#
# The spec's boot smoke: when the vendored codemode extension is present in
# the image, execute its in-image canary against the VENDORED dists BEFORE
# the server starts — a missing quickjs wasm/worker exits 1 here, not a 500
# on the first real script in prod (a runtime guarantee, not a build one).
#
# A non-vendored image (network build without .docker-ext) carries no
# codemode extension to smoke: skip with a note on stderr. Which extensions
# actually load is SIGRUN_EXTENSIONS — the operator's secret, never baked in.
set -e

CANARY=/app/node_modules/sigrun-ext-codemode/scripts/canary.mjs
if [ -f "$CANARY" ]; then
  echo "sigrun: codemode boot canary..."
  node "$CANARY"
else
  echo "sigrun: codemode extension absent — skipping boot canary" >&2
fi

exec "$@"
