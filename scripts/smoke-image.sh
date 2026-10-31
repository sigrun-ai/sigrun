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
	# The loader-slug list for the boot assertion, derived on the HOST —
	# the single source of truth is publish-deps.mjs's BUILTINS map (the
	# container has no sibling checkouts to re-derive from). /v1/meta rows
	# key on the loader SLUG (`codemode`, `sigrun-mcp`, …), never the
	# package name, so the boot assertion matches on slugs; the static
	# require.resolve check keeps the package names.
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
	#
	# The container runs as the INVOKING uid, not the image's default
	# 1000: `mktemp -d` below creates a 0700 dir owned by whoever runs
	# this script (uid 1001 on a GitHub runner), and a bind mount carries
	# that ownership in verbatim — so a fixed uid 1000 could not write
	# /data at all. Matching the mount owner is what a rootless runtime
	# (k8s runAsUser + fsGroup, compose `user:`) does for sigrun in
	# production; this mirrors it instead of sidestepping it with a
	# world-writable dir.
	state="$(mktemp -d)"
	trap 'rm -rf "$state"' EXIT
	docker run --rm -d \
		--name sigrun-smoke \
		--user "$(id -u):$(id -g)" \
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
	# Python + uv in the agent userland: plain checks first — the
	# entrypoint execs "$@" (docker/entrypoint.sh), so a bare command
	# runs exactly like the CMD — then a jailed check proving both work
	# inside the Landlock policy a per-user agent gets. venv creation and
	# uv write only under HOME and read only /usr; neither needs global
	# pip (the Debian EXTERNALLY-MANAGED marker stays; agents use venvs/uv).
	py="$(docker run --rm "$image" python3 --version 2>&1)" || {
		echo "python3 missing from the image (exit $?): $py" >&2
		exit 1
	}
	case "$py" in
	"Python 3"*) ;;
	*) echo "unexpected python3 --version output: $py" >&2; exit 1 ;;
	esac
	out="$(docker run --rm "$image" sh -c 'python3 -m venv /tmp/v && /tmp/v/bin/python -c "print(1)"' 2>&1)" || {
		echo "python3 venv check failed (exit $?): $out" >&2
		exit 1
	}
	printf "%s\n" "$out" | grep -qx 1 || {
		echo "python3 venv check did not print 1: $out" >&2
		exit 1
	}
	out="$(docker run --rm "$image" uv --version 2>&1)" || {
		echo "uv missing from the image (exit $?): $out" >&2
		exit 1
	}
	printf "%s\n" "$out" | grep -q "uv 0\.13\.6" || {
		echo "unexpected uv --version output (want uv 0.13.6): $out" >&2
		exit 1
	}
	out="$(docker run --rm "$image" sh -c 'cd /tmp && HOME=/tmp/h uv venv -q /tmp/u && uv run --no-project --python /usr/bin/python3 python -c "print(2)"' 2>&1)" || {
		echo "uv venv/run check failed (exit $?): $out" >&2
		exit 1
	}
	printf "%s\n" "$out" | grep -qx 2 || {
		echo "uv venv/run check did not print 2: $out" >&2
		exit 1
	}
	# The jailed check: buildUserPolicy for user acme over a throwaway
	# /tmp/sg managed tree — the buildOsUserPolicy shape from
	# test/sandbox-it/helpers.ts (store roots + storagePath + coreRoot +
	# userAreas) — then the sandbox helper runs the python/uv pair under
	# that policy. HOME comes from the policy itself (the helper execs
	# the child with the policy env). Expect exit 0 and a 3 on stdout.
	# The Landlock gate is INSIDE this container: a probe below ABI 6 here
	# means the host kernel predates it or the docker seccomp profile
	# blocks the landlock_* syscalls — fail loud naming that cause (never
	# skip); the fix is --security-opt seccomp=unconfined (or a
	# landlock-allowing profile) on exactly this docker run.
	docker run --rm "$image" node --input-type=module -e '
		import { spawnSync } from "node:child_process";
		import { mkdirSync } from "node:fs";
		import { join } from "node:path";
		import { buildUserPolicy, defaultModuleTrees } from "/app/dist/sandbox/policy.js";

		const helper = "/usr/local/lib/sigrun/sigrun-sandbox";
		const probed = spawnSync(helper, ["probe"], { encoding: "utf8" });
		const abi = probed.status === 0 ? JSON.parse(probed.stdout).abi : 0;
		if (!(Number.isInteger(abi) && abi >= 6)) {
			console.error(
				`jailed python/uv check requires Landlock ABI >= 6 in this container; ` +
				`sigrun-sandbox probe reported ${probed.status === 0 ? String(abi) : `exit ${probed.status}`} — ` +
				`the host kernel predates Landlock ABI 6 or the docker seccomp profile ` +
				`blocks the landlock_* syscalls; re-run this check with ` +
				`--security-opt seccomp=unconfined (or a landlock-allowing profile), never skip it`,
			);
			process.exit(1);
		}

		const root = "/tmp/sg";
		for (const name of ["config", "data", "cache", "state"]) {
			mkdirSync(join(root, name), { recursive: true });
		}
		const managed = {
			roots: {
				configDir: join(root, "config"),
				dataDir: join(root, "data"),
				cacheDir: join(root, "cache"),
				stateDir: join(root, "state"),
			},
			storagePath: join(root, "data", "sigrun.db"),
			coreRoot: "/app",
			userAreas: (user) => join(root, "data", "users", user),
		};
		const built = buildUserPolicy(
			{ user: "acme", admin: false, source: "cli", createdAt: 1 },
			{ managed, nodeBinDir: process.execPath, moduleTrees: defaultModuleTrees("/app") },
		);
		if (!built.ok) {
			console.error(`jailed check: policy build failed: ${built.reason}`);
			process.exit(1);
		}
		const policy = built.policy;
		const serialized = JSON.stringify({
			ro: policy.ro,
			rw: policy.rw,
			ensureDirs: policy.ensureDirs,
			minAbi: 6,
			...(policy.uid === undefined ? {} : { uid: policy.uid }),
			...(policy.gid === undefined ? {} : { gid: policy.gid }),
			...(policy.groups === undefined ? {} : { groups: policy.groups }),
		});
		const command =
			"python3 -m venv \"$HOME/v\" && \"$HOME/v/bin/python\" -c \"print(3)\" && " +
			"uv --version && UV_CACHE_DIR=\"$HOME/.cache/uv\" uv venv -q \"$HOME/u\"";
		const run = spawnSync(
			"/usr/local/lib/sigrun/sigrun-sandbox",
			["run", "--", "sh", "-c", command],
			{ encoding: "utf8", env: { ...policy.env, SIGRUN_SANDBOX_POLICY: serialized } },
		);
		if (run.error !== undefined) {
			console.error(`jailed check: cannot spawn the sandbox helper: ${run.error.message}`);
			process.exit(1);
		}
		if (run.status !== 0) {
			console.error(`jailed python/uv check failed (exit ${run.status}):\n${run.stdout ?? ""}${run.stderr ?? ""}`);
			process.exit(1);
		}
		if (!(run.stdout ?? "").split("\n").includes("3")) {
			console.error(`jailed python/uv check did not print 3:\n${run.stdout ?? ""}${run.stderr ?? ""}`);
			process.exit(1);
		}
		console.log("jailed python/uv check OK (venv + uv inside the per-user Landlock policy)");
	'
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
