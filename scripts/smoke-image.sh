#!/bin/sh
# Inspect the runtime image without starting sigrun: boot needs deployment
# configuration, but every path its entrypoint and workspace links need is
# fixed at build time.
set -eu

image="${1-}"

if [ "$#" -eq 1 ]; then
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
	"@sigrun/ext-mcp",
	"@sigrun/ext-tool-search",
]) {
	assert.ok(require.resolve(name), `cannot resolve ${name}`);
}

console.log("image runtime layout OK");
'
