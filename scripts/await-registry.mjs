#!/usr/bin/env node
/**
 * await-registry.mjs (release workstream Task 2.3): wait until every
 * <name@version> tarball is fetchable from the npm registry, then exit 0.
 *
 *   await-registry.mjs --timeout-min <n> <name@version>...
 *
 * The probe is the TARBALL URL (`<base>/<name>/-/<basename>-<version>.tgz`,
 * HEAD first, GET on a 405/501) — fetch-only, so none of the `npm view`
 * packument-lag classes (§39/§43) apply: a tarball that 200s is installable.
 *
 * Polls every 60 s until the deadline; each pass re-checks only the
 * still-missing specs. Exit 0 once every spec 200s; exit 1 at the
 * deadline, listing the versions that never arrived; exit 2 on usage
 * errors. `--timeout-min 0` is a ONE-SHOT check (the publish-npm
 * pre-check that every built-in pin is already live uses it).
 *
 * DEPENDENCY-FREE (node: built-ins only): the release jobs run this from
 * a bare checkout of this repo's scripts/ at `.sigrun-tools`, with no
 * `npm ci` — the same contract as release-guard.mjs.
 *
 * Overrides (CI never sets these; tests do):
 *   SIGRUN_REGISTRY_BASE     registry root (default https://registry.npmjs.org)
 *   SIGRUN_POLL_INTERVAL_MS  poll interval (default 60000)
 */
const REGISTRY_BASE = (process.env.SIGRUN_REGISTRY_BASE ?? "https://registry.npmjs.org").replace(
	/\/+$/,
	"",
);
const POLL_INTERVAL_MS = Number.parseInt(process.env.SIGRUN_POLL_INTERVAL_MS ?? "60000", 10);
// Default 30 s; tests lower it via the env knob — a timeout must never
// exceed the remaining poll window by minutes (that would stall the CI
// job on a hung CDN edge instead of retrying).
const REQUEST_TIMEOUT_MS = Number.parseInt(
	process.env.SIGRUN_REQUEST_TIMEOUT_MS ?? "30000",
	10,
);

function usage() {
	process.stderr.write(
		"usage: await-registry.mjs --timeout-min <n> <name@version>...\n",
	);
	process.exit(2);
}

const args = process.argv.slice(2);
const positional = [];
let timeoutMin;
for (let i = 0; i < args.length; i += 1) {
	const arg = args[i];
	if (arg === "--timeout-min") {
		i += 1;
		if (i >= args.length) usage();
		timeoutMin = Number.parseFloat(args[i]);
		if (!Number.isFinite(timeoutMin) || timeoutMin < 0) usage();
	} else if (arg.startsWith("--")) {
		usage();
	} else {
		positional.push(arg);
	}
}
if (timeoutMin === undefined || positional.length === 0) usage();

// Each spec's deadline is its own: the loop is a single pass per poll
// interval, and specs that 200 early drop out of `missing`.
function sleep(ms) {
	// DO NOT unref this timer. An unref'd timer does not keep the event
	// loop alive, so when the poll sleep is the ONLY pending work (the
	// common case: one 404, then wait) node considers the process done
	// and exits 13 "unsettled top-level await" — the script would die
	// mid-poll instead of waiting out the interval. The sleep is bounded
	// by the deadline, and every exit path calls process.exit(), so
	// holding the loop open here cannot outlive the script.
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parse `<name>@<version>`; the name itself may be scoped (@sigrun/…),
 * so the split is at the LAST '@' (a bare name has none → usage error). */
function parseSpec(spec) {
	const at = spec.lastIndexOf("@");
	if (at <= 0 || at === spec.length - 1) {
		process.stderr.write(
			`await-registry: '${spec}' is not <name@version>\n`,
		);
		process.exit(2);
	}
	return { name: spec.slice(0, at), version: spec.slice(at + 1) };
}

const specs = positional.map(parseSpec);

/** The tarball URL for a spec: <base>/<name>/-/<basename>-<version>.tgz. */
function tarballUrl({ name, version }) {
	const basename = name.slice(name.lastIndexOf("/") + 1);
	return `${REGISTRY_BASE}/${name}/-/${basename}-${version}.tgz`;
}

/** HEAD (falling back to GET) the tarball URL; true when it 200s. */
async function fetchable(spec) {
	const url = tarballUrl(spec);
	for (const method of ["HEAD", "GET"]) {
		try {
			const response = await fetch(url, {
				method,
				redirect: "follow",
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			if (response.status === 405 || response.status === 501) continue;
			return response.status === 200;
		} catch (cause) {
			// A network error is indistinguishable from "not there yet" for
			// our purpose — treat it as missing and let the poll retry. The
			// debug knob exists so a fetch failure in CI is diagnosable
			// without re-running locally.
			if (process.env.SIGRUN_AWAIT_DEBUG === "1") {
				process.stderr.write(
					`await-registry: fetch ${url} failed: ${cause instanceof Error ? cause.message : String(cause)}\n`,
				);
			}
			return false;
		} finally {
			// DO NOT drain or cancel the body here: both touch the response
			// stream and can hang the await on node ≥22 in a spawned CI
			// context. Leaving the response unreferenced lets GC close the
			// socket — a tarball probe is one fetch per minute, not a hot
			// loop, so the transient keep-alive cost is noise.
		}
	}
	return false;
}

const deadline = Date.now() + timeoutMin * 60_000;
let missing = [...specs];

for (;;) {
	const stillMissing = [];
	for (const spec of missing) {
		if (!(await fetchable(spec))) stillMissing.push(spec);
	}
	missing = stillMissing;
	if (missing.length === 0) {
		process.stdout.write(
			`await-registry: all ${specs.length} version(s) live\n`,
		);
		process.exit(0);
	}
	if (Date.now() >= deadline) {
		for (const spec of missing) {
			process.stderr.write(
				`await-registry: ${spec.name}@${spec.version} is NOT live at ${tarballUrl(spec)}\n`,
			);
		}
		process.stderr.write(
			`await-registry: timed out after ${timeoutMin} min with ${missing.length} version(s) missing\n`,
		);
		process.exit(1);
	}
	await sleep(POLL_INTERVAL_MS);
}
