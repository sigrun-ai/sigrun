#!/bin/sh
# Registry-install smoke (release workstream Task 2.3): prove the
# PUBLISHED tarball installs and boots from the registry — never a local
# path. Inside `docker run --rm node:22-bookworm-slim`:
#
#   1. npm i -g @sigrun/sigrun@<version>     (REGISTRY only)
#   2. boot `sigrun serve` on 127.0.0.1 with the pi-ai built-in provider
#      model (openai/gpt-4o boots with no credential — the same env
#      shape test/build.test.ts:147 spawns the entry with) and a
#      synthetic API token;
#   3. poll /healthz, then assert /v1/meta reports every built-in as
#      loaded. CRITICAL: /v1/meta rows key on the loader SLUG
#      (`codemode`, `sigrun-mcp`, …), never the package name, and the
#      rows carry no `builtin` flag — the slug list comes from the
#      HOST's `publish-deps.mjs slugs` (the single enumeration), exactly
#      as scripts/smoke-image.sh does;
#   4. assert require.resolve('@sigrun/sandbox-linux-x64/bin/sigrun-sandbox')
#      succeeds and the file is executable (the optionalDependencies
#      registry-mode dance must have shipped the x64 platform package);
#   5. assert @sigrun/tui resolves.
#
# The docker image ships curl AND node, so polling and assertions stay
# inside the one container — no bind-mounted state.
#
# Honors NPM_CONFIG_REGISTRY (npm reads it natively; the smoke passes it
# through to the container), so a local verdaccio proves the flow
# without touching the public registry.
#
#   smoke-registry.sh <version>
set -eu

if [ "$#" -ne 1 ]; then
	echo "usage: smoke-registry.sh <version>" >&2
	exit 2
fi

version="$1"
image="node:22-bookworm-slim"

# The built-in slug list is a HOST derivation (the container has no
# sibling checkouts to re-derive from): publish-deps.mjs's BUILTINS map
# is the single source of truth — the same call smoke-image.sh makes.
builtin_slugs="$(node scripts/publish-deps.mjs slugs | cut -d' ' -f2 | paste -sd, -)"
if [ -z "$builtin_slugs" ]; then
	echo "publish-deps.mjs slugs returned nothing — refusing to smoke an empty set" >&2
	exit 1
fi

# NPM_CONFIG_REGISTRY passes through when set (local verdaccio proof);
# unset → the public registry. The docker flag must carry the value
# itself: `--env NPM_CONFIG_REGISTRY` (pass-through form) is a no-op
# when the host var is unset, and we never want an empty assignment to
# shadow the registry default inside the container.
registry_env=""
if [ -n "${NPM_CONFIG_REGISTRY-}" ]; then
	registry_env="--env NPM_CONFIG_REGISTRY=${NPM_CONFIG_REGISTRY}"
fi

# The container script takes the version as $1 and the slug list as $2
# (a heredoc inside `sh -s` would eat stdin as the script — arguments
# keep the two channels separate). Quoting note: the heredoc is
# UNQUOTED-free — 'EOS' keeps the host shell out of it entirely.
docker run --rm \
	--env SIGRUN_DEFAULT_MODEL=openai/gpt-4o \
	--env SIGRUN_API_TOKEN=sigrun-smoke-token \
	--env SIGRUN_PORT=3000 \
	$registry_env \
	"$image" sh -s -- "$version" "$builtin_slugs" <<'EOS'
set -eu

version="$1"
builtin_slugs="$2"

echo "smoke-registry: installing @sigrun/sigrun@${version} from $(npm config get registry)"
npm install -g "@sigrun/sigrun@${version}"

# npm root -g is the one true global root (/usr/local/lib/node_modules
# in this image, but never hardcode what npm will tell us).
root="$(npm root -g)"

# Boot: the pi-ai built-in provider model needs no credential to BOOT
# (mirrors test/build.test.ts's serve-spawn env shape); the token is
# synthetic. serve listens on SIGRUN_PORT inside the container (its
# default bind is 0.0.0.0, which is fine here — the probes below target
# 127.0.0.1 and the container publishes no ports). The state roots
# keep the run hermetic inside the container's own /tmp.
state="$(mktemp -d)"
SIGRUN_CONFIG_DIR="$state/config" \
SIGRUN_STORAGE_PATH="$state/sigrun.db" \
SIGRUN_WORKSPACE_PATH="$state/workspace" \
sigrun serve >"$state/boot.log" 2>&1 &
server_pid=$!

cleanup() {
	kill "$server_pid" 2>/dev/null || true
	wait "$server_pid" 2>/dev/null || true
}
trap cleanup EXIT

i=0
until curl -fsS http://127.0.0.1:3000/healthz >/dev/null 2>&1; do
	i=$((i + 1))
	if [ "$i" -ge 60 ]; then
		echo "sigrun did not pass /healthz within 60s" >&2
		cat "$state/boot.log" >&2 || true
		exit 1
	fi
	sleep 1
done

# Boot assertion: /v1/meta rows key on the loader SLUG and must each
# report status ok — a tarball whose built-ins quarantined at boot
# (dangling file: specifiers, a missing shared, a loader regression)
# shows up HERE and nowhere else in the smoke.
BUILTIN_SLUGS="$builtin_slugs" node -e '
fetch("http://127.0.0.1:3000/v1/meta", {
	headers: { authorization: "Bearer sigrun-smoke-token" },
}).then(async (response) => {
	if (!response.ok) throw new Error(`/v1/meta answered ${response.status}`);
	const meta = await response.json();
	const byName = new Map(meta.extensions.map((row) => [row.name, row]));
	for (const slug of process.env.BUILTIN_SLUGS.split(",")) {
		const row = byName.get(slug);
		if (row === undefined) throw new Error(`built-in ${slug} absent from /v1/meta`);
		if (row.status !== "ok") {
			throw new Error(`built-in ${slug} did not load: status=${row.status} ${row.error ?? ""}`);
		}
	}
	console.log(`boot smoke OK: ${process.env.BUILTIN_SLUGS.split(",").length} built-ins loaded`);
}).catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
'

cleanup
trap - EXIT

# Static assertions: the x64 sandbox platform package must be there and
# executable (the optionalDependencies registry-mode dance), and the TUI
# workspace must resolve. require.resolve runs against the INSTALLED
# core's own manifest — createRequire anchors at the installed package,
# never at a repo path.
ROOT="$root" node -e '
import assert from "node:assert/strict";
import { accessSync, constants } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(join(process.env.ROOT, "@sigrun/sigrun/package.json"));
const sandboxBin = require.resolve("@sigrun/sandbox-linux-x64/bin/sigrun-sandbox");
accessSync(sandboxBin, constants.X_OK);
assert.ok(require.resolve("@sigrun/tui"), "cannot resolve @sigrun/tui");
console.log("registry install layout OK");
'
EOS
