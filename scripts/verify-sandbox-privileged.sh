#!/bin/sh
# Run the two capability-gated sandbox boundary cases in a disposable
# container, then rerun the ordinary suite without the privileged opt-in.
# A dry run is always the default: no container, source archive, or other
# state is created unless --run is present.
set -eu

usage() {
	cat <<'EOF'
Usage:
  verify-sandbox-privileged.sh [--image IMAGE@sha256:DIGEST] [--runtime PATH] [--run] [REVISION]

REVISION must be a full 40-character sigrun core commit. The checkout's
five built-in extension siblings are archived at their current HEAD commits,
which are printed so a completed run records the exact dependency set it
tested. IMAGE must be digest-pinned and contain Node 22, setcap, ps (procps),
and the sandbox helper at /usr/local/lib/sigrun/sigrun-sandbox. --runtime
defaults to docker; DOCKER_HOST selects the target daemon when using Docker.
The image can also be supplied as SIGRUN_SANDBOX_VERIFY_IMAGE and the runtime
as SIGRUN_SANDBOX_VERIFY_RUNTIME.

Without --run, print the plan and exit 0. With --run, create one disposable
container with every capability dropped except SETFCAP, SETUID, and SETGID,
execute the two privileged cases and the ordinary regression suite, and remove
the container and temporary source archive on every exit.

CURRENT LIMITATION: the two privileged cases are expected to FAIL with the
existing fixture, as recorded in the 2026-10-27 release verification evidence.
A green result requires the fixture redesign; this script never tolerates or
hides those failures and exits non-zero when either case fails.
EOF
}

image=${SIGRUN_SANDBOX_VERIFY_IMAGE-}
runtime=${SIGRUN_SANDBOX_VERIFY_RUNTIME:-docker}
revision=
run=0

while [ "$#" -gt 0 ]; do
	case "$1" in
		--image)
			[ "$#" -ge 2 ] || { usage >&2; exit 2; }
			image=$2
			shift 2
			;;
		--runtime)
			[ "$#" -ge 2 ] || { usage >&2; exit 2; }
			runtime=$2
			shift 2
			;;
		--run)
			run=1
			shift
			;;
		-h|--help)
			usage
			exit 0
			;;
		--)
			shift
			[ "$#" -eq 1 ] && [ -z "$revision" ] || { usage >&2; exit 2; }
			revision=$1
			shift
			;;
		-*)
			usage >&2
			exit 2
			;;
		*)
			[ -z "$revision" ] || { usage >&2; exit 2; }
			revision=$1
			shift
			;;
	esac
done

print_plan() {
	cat <<EOF
Privileged sandbox verification plan (dry run; nothing was created or started):
  core revision: ${revision:-<40-hex-commit>}
  image: ${image:-<IMAGE@sha256:64-hex-digest>}
  container runtime: ${runtime}
  source: git archive of the pinned core revision and five sibling HEADs
  container: disposable, root user, ALL dropped except SETFCAP, SETUID, SETGID
  seccomp: unconfined for the suite's unshare namespace control; capabilities stay narrow
  phase 1: SIGRUN_SANDBOX_IT_PRIVILEGED=1; require the osUser and in-jail uid-switch cases to pass
  phase 2: privileged opt-in unset; require all ordinary cases to pass and those two cases to skip
  evidence: kernel release, Landlock ABI, and per-case JSON-reported results
  cleanup: remove the container and temporary source archive on success or failure
CURRENT LIMITATION: the two privileged cases are expected to FAIL with the
existing fixture (see the 2026-10-27 release verification evidence). A green
result requires the fixture redesign; failures are never tolerated.
No privileged workload is run without --run.
EOF
}

if [ "$run" -ne 1 ]; then
	print_plan
	exit 0
fi

if ! printf '%s' "$revision" | grep -E '^[0-9a-f]{40}$' >/dev/null; then
	echo "REVISION must be a full 40-character lowercase commit; got '$revision'" >&2
	exit 2
fi
if ! printf '%s' "$image" | grep -E '^[^[:space:]]+@sha256:[0-9a-f]{64}$' >/dev/null; then
	echo "--image must pin a digest as IMAGE@sha256:<64-lowercase-hex>" >&2
	exit 2
fi
case "$runtime" in
	""|*[!A-Za-z0-9_./-]*)
		echo "--runtime must be one executable path without arguments" >&2
		exit 2
		;;
esac
command -v "$runtime" >/dev/null 2>&1 || { echo "container runtime not found: $runtime" >&2; exit 1; }
command -v git >/dev/null 2>&1 || { echo "git is required" >&2; exit 1; }

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
core_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
workspace_root=$(CDPATH= cd -- "$core_root/.." && pwd)
siblings="sigrun-ext-codemode sigrun-ext-gateway sigrun-ext-mcp sigrun-ext-tool-search sigrun-ext-oauth"
git -C "$core_root" cat-file -e "$revision^{commit}" 2>/dev/null || {
	echo "core commit is not present locally: $revision" >&2
	exit 1
}
for sibling in $siblings; do
	git -C "$workspace_root/$sibling" rev-parse --verify HEAD >/dev/null 2>&1 || {
		echo "required sibling checkout is missing: $workspace_root/$sibling" >&2
		exit 1
	}
done

source_dir=$(mktemp -d "${TMPDIR:-/tmp}/sigrun-sandbox-verify.XXXXXX")
# The name is collision-resistant even when clients on a shared daemon reuse
# PIDs. Destructive cleanup is registered only after create returns this
# invocation's own ID; a name conflict therefore cannot remove another
# client's pre-existing container.
container_suffix=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
container="sigrun-sandbox-verify-$$-$container_suffix"
container_id=
cleanup() {
	status=$?
	trap - EXIT HUP INT TERM
	if [ -n "$container_id" ]; then
		"$runtime" rm -f "$container_id" >/dev/null 2>&1 || true
	fi
	rm -rf -- "$source_dir"
	exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir "$source_dir/sigrun"
git -C "$core_root" archive "$revision" | tar -x -C "$source_dir/sigrun"
printf 'SOURCE core %s\n' "$revision"
for sibling in $siblings; do
	sibling_revision=$(git -C "$workspace_root/$sibling" rev-parse HEAD)
	mkdir "$source_dir/$sibling"
	git -C "$workspace_root/$sibling" archive HEAD | tar -x -C "$source_dir/$sibling"
	printf 'SOURCE %s %s\n' "$sibling" "$sibling_revision"
done
# With DAC_OVERRIDE dropped, container root cannot traverse mktemp's 0700
# directory or read host-private files. The archive is public source, so make
# this temporary copy readable rather than widening the capability set.
chmod 0755 "$source_dir"
chmod -R a+rX "$source_dir"

# Create and start are separate so cleanup owns the exact ID returned by a
# successful create, including a container that only partially starts.
# SETFCAP only sets the file-capability xattr. Executing the capped helper
# also requires its granted SETUID/SETGID capabilities in the bounding set.
# The boundary suite's namespace control uses unshare; Docker's default
# seccomp profile rejects it. Keep the capability set exactly as above.
# Keep this continued invocation a pure argument list: a comment inside it
# terminates the command instead of continuing onto the remaining arguments.
container_id=$("$runtime" create \
	--name "$container" \
	--user 0:0 \
	--cap-drop ALL \
	--cap-add SETFCAP \
	--cap-add SETUID \
	--cap-add SETGID \
	--security-opt seccomp=unconfined \
	--volume "$source_dir:/src:ro" \
	--entrypoint /bin/sh \
	"$image" -s -- "$revision")
"$runtime" start -a -i "$container_id" <<'INNER'
set -eu
revision=$1
work=/work
mkdir "$work"
# CHOWN is deliberately absent, so do not ask cp to preserve ownership.
cp -R /src/. "$work/"
cd "$work/sigrun"

for command in node setcap ps unshare; do
	command -v "$command" >/dev/null 2>&1 || {
		echo "the verification image is missing required command: $command (install procps for ps)" >&2
		exit 1
	}
done
[ -x /usr/local/lib/sigrun/sigrun-sandbox ] || {
	echo "the verification image is missing executable helper: /usr/local/lib/sigrun/sigrun-sandbox" >&2
	exit 1
}
printf 'VERIFY core %s\n' "$revision"
printf 'LIMITATION current fixture is expected to fail both privileged cases; a green result requires the fixture redesign recorded in the 2026-10-27 release evidence\n'
printf 'KERNEL %s\n' "$(uname -srmo)"
mkdir -p sandbox/target/release
cp /usr/local/lib/sigrun/sigrun-sandbox sandbox/target/release/sigrun-sandbox
probe=$(sandbox/target/release/sigrun-sandbox probe)
printf 'LANDLOCK_PROBE %s\n' "$probe"
abi=$(PROBE="$probe" node -e 'const p = JSON.parse(process.env.PROBE); if (!Number.isInteger(p.abi)) process.exit(2); process.stdout.write(String(p.abi));')
printf 'LANDLOCK_ABI %s\n' "$abi"
[ "$abi" -ge 6 ] || { echo "Landlock ABI >= 6 is required" >&2; exit 1; }

for sibling in sigrun-ext-codemode sigrun-ext-gateway sigrun-ext-mcp sigrun-ext-tool-search sigrun-ext-oauth; do
	npm --prefix "$work/$sibling" ci --ignore-scripts
done
npm ci
npm run build

cat > "$work/report.cjs" <<'REPORTER'
const fs = require("node:fs");
const [mode, path, commandStatusText] = process.argv.slice(2);
const expected = [
	"the same helper uid/gid switch succeeds unjailed and fails inside the jail",
	"osUser successfully switches through a file-capability-enabled helper",
];
const commandStatus = Number(commandStatusText);
let failed = commandStatus !== 0;
if (!fs.existsSync(path)) {
	console.error(`REPORT missing ${path} (vitest exit ${commandStatus})`);
	process.exit(1);
}
const report = JSON.parse(fs.readFileSync(path, "utf8"));
const rows = report.testResults.flatMap((file) => file.assertionResults);
for (const row of rows) console.log(`CASE ${String(row.status).toUpperCase()} ${row.title}`);
const skipped = new Set(["pending", "skipped", "todo"]);
for (const title of expected) {
	const matches = rows.filter((row) => row.title === title);
	if (matches.length !== 1) {
		console.error(`ASSERT expected exactly one result for: ${title}`);
		failed = true;
		continue;
	}
	const wanted = mode === "privileged" ? "passed" : "skip";
	const actual = matches[0].status;
	const okay = wanted === "passed" ? actual === "passed" : skipped.has(actual);
	if (!okay) {
		console.error(`ASSERT ${title}: wanted ${wanted}, got ${actual}`);
		failed = true;
	}
}
for (const row of rows) {
	if (expected.includes(row.title)) continue;
	const okay = mode === "privileged" ? skipped.has(row.status) : row.status === "passed";
	if (!okay) {
		console.error(`ASSERT ordinary case ${row.title}: unexpected ${row.status} in ${mode} phase`);
		failed = true;
	}
}
console.log(`SUMMARY ${mode} phase: ${report.numPassedTests} passed, ${report.numPendingTests} pending, ${report.numFailedTests} failed; vitest exit ${commandStatus}`);
if (failed) process.exit(1);
REPORTER

privileged_report="$work/privileged-results.json"
printf 'PHASE privileged: osUser success and in-jail uid-switch\n'
if SIGRUN_SANDBOX_IT=1 SIGRUN_SANDBOX_IT_PRIVILEGED=1 \
	npx vitest run test/sandbox-it/boundary.test.ts \
	-t 'the same helper uid/gid switch succeeds unjailed and fails inside the jail|osUser successfully switches through a file-capability-enabled helper' \
	--reporter=json --outputFile="$privileged_report"; then
	privileged_status=0
else
	privileged_status=$?
fi
node "$work/report.cjs" privileged "$privileged_report" "$privileged_status"

ordinary_report="$work/ordinary-results.json"
printf 'PHASE ordinary: regression without the privileged opt-in\n'
if env -u SIGRUN_SANDBOX_IT_PRIVILEGED SIGRUN_SANDBOX_IT=1 \
	npx vitest run test/sandbox-it/boundary.test.ts \
	--reporter=json --outputFile="$ordinary_report"; then
	ordinary_status=0
else
	ordinary_status=$?
fi
node "$work/report.cjs" ordinary "$ordinary_report" "$ordinary_status"
printf 'RESULT PASS privileged cases and ordinary regression suite\n'
INNER
printf 'VERIFY COMPLETE %s\n' "$revision"
