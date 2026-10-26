#!/bin/sh
# Inspect the runtime image: boot it (the five built-in extensions must
# LOAD — a registry-mode build that ships dangling file: symlinks
# quarantines them, and only a real boot + /v1/meta proves they loaded),
# then run the static layout/resolve checks. Built-ins resolve through
# core's own node_modules, so a container CAN resolve them with no
# sibling checkouts — the resolve list still comes from the host's
# `publish-deps.mjs list` (the single enumeration; the list is a comment
# input inside the container, not a build input).
set -eu

image="${1-}"

if [ "$#" -eq 1 ]; then
	# The built-in resolve list (package names) and the loader-slug list,
	# both derived on the HOST — the single source of truth is
	# publish-deps.mjs's BUILTINS map (the container has no sibling
	# checkouts to re-derive from). /v1/meta rows key on the loader SLUG
	# (`codemode`, `sigrun-mcp`, …), never the package name, so the boot
	# assertion matches on slugs; the static require.resolve check keeps
	# the package names.
	resolve_list="$(node scripts/publish-deps.mjs list | cut -d' ' -f1)"
	builtin_slugs="$(node scripts/publish-deps.mjs slugs | cut -d' ' -f2 | paste -sd, -)"
	probe="$(docker run --rm "$image" /usr/local/lib/sigrun/sigrun-sandbox probe)"
	PROBE="$probe" node -e '
		const report = JSON.parse(process.env.PROBE);
		if (!Number.isInteger(report.abi)) throw new Error("sandbox probe returned no integer abi");
	'
	init="$(docker run --rm "$image" sh -c 'ps -o comm= 1')"
	if [ "$init" != "tini" ]; then
		echo "expected tini as PID 1, got: $init" >&2
		exit 1
	fi
	# Boot assertion: a real boot with the pi-ai built-in provider model
	# (openai/gpt-4o needs no credential to BOOT — the same env
	# test/build.test.ts spawns the entry with) and a synthetic API
	# token. Poll /healthz, then /v1/meta: every built-in must report an
	# ok status — a registry-mode build that shipped dangling file:
	# symlinks quarantines them, and ONLY this check sees it.
	state="$(mktemp -d)"
	trap 'rm -rf "$state"' EXIT
	docker run --rm -d \
		--name sigrun-smoke \
		-e SIGRUN_DEFAULT_MODEL=openai/gpt-4o \
		-e SIGRUN_API_TOKEN=sigrun-smoke-token \
		-e SIGRUN_CONFIG_DIR=/data/config \
		-e SIGRUN_STORAGE_PATH=/data/sigrun.db \
		-e SIGRUN_WORKSPACE_PATH=/data/workspace \
		-e SIGRUN_PORT=3000 \
		-v "$state:/data" \
		"$image" >/dev/null
	trap 'docker rm -f sigrun-smoke >/dev/null 2>&1 || true; rm -rf "$state"' EXIT
	i=0
	until docker exec sigrun-smoke curl -fsS http://127.0.0.1:3000/healthz >/dev/null 2>&1; do
		i=$((i + 1))
		if [ "$i" -ge 60 ]; then
			echo "sigrun did not pass /healthz within 60s" >&2
			docker logs sigrun-smoke >&2 || true
			exit 1
		fi
		sleep 1
	done
	BUILTIN_SLUGS="$builtin_slugs" docker exec -e BUILTIN_SLUGS sigrun-smoke node -e '
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
	docker rm -f sigrun-smoke >/dev/null
	exec docker run --rm -i "$image" sh -s < "$0"
elif [ "$#" -ne 0 ]; then
	echo "usage: smoke-image.sh [IMAGE]" >&2
	exit 2
fi

node --input-type=module -e '
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

for (const file of [
	"dist/index.js",
	"dist/cli.js",
	"webui/dist/index.html",
	"shared/package.json",
	"shared/dist/access.js",
	"shared/dist/themes.js",
	"tui/package.json",
	"tui/dist/launch.js",
]) {
	assert.ok(existsSync(resolve("/app", file)), `missing /app/${file}`);
}

const require = createRequire("/app/package.json");
for (const name of [
	"@sigrun/shared/themes",
	"@sigrun/tui",
	"@sigrun/ext-codemode",
	"@sigrun/ext-gateway",
	"@sigrun/ext-mcp",
	"@sigrun/ext-tool-search",
	"@sigrun/oauth",
]) {
	assert.ok(require.resolve(name), `cannot resolve ${name}`);
}

console.log("image runtime layout OK");
'
