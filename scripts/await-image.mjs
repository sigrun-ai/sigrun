#!/usr/bin/env node
/**
 * await-image.mjs (chart decoupling): wait until every
 * `<owner>/<image>:<tag>` manifest is fetchable from GHCR, then exit 0.
 *
 *   await-image.mjs --timeout-min <n> <owner>/<image>:<tag>...
 *
 * WHY THIS EXISTS: the chart and the image are separate release
 * artifacts. A chart's default image tag is its `appVersion`, so a chart
 * pushed before its image exists deploys into ImagePullBackOff — a bad
 * chart that is immutable once pushed. The chart job therefore waits for
 * the image it names. The chart's `appVersion` comes from SOURCE (the
 * tagged commit's package.json), never from a registry query, so the
 * wait is the ONLY ordering constraint: resolving the version by asking
 * the registry "what is latest?" would race a same-commit core release
 * and could publish a chart pinned to the PREVIOUS version permanently.
 *
 * The probe is an OCI manifest GET with an anonymous pull token
 * (`/token?scope=repository:<owner>/<image>:pull`), Accept-ing the OCI
 * image index — the multi-arch shape this repo pushes. 200 = live;
 * 404/401/403 = not there yet (a private or absent package is
 * indistinguishable to an anonymous caller, and both mean "not
 * deployable yet", so both keep polling).
 *
 * Polls every 60 s until the deadline; each pass re-checks only the
 * still-missing specs. Exit 0 once every spec 200s; exit 1 at the
 * deadline, listing the ones that never arrived; exit 2 on usage
 * errors. `--timeout-min 0` is a ONE-SHOT check.
 *
 * DEPENDENCY-FREE (node: built-ins only): the release jobs run this from
 * a bare checkout of this repo's scripts/ at `.sigrun-tools`, with no
 * `npm ci` — the same contract as release-guard.mjs and
 * await-registry.mjs.
 *
 * Overrides (CI never sets these; tests do):
 *   SIGRUN_GHCR_BASE         registry root (default https://ghcr.io)
 *   SIGRUN_POLL_INTERVAL_MS  poll interval (default 60000)
 *   SIGRUN_REQUEST_TIMEOUT_MS per-request timeout (default 30000)
 *   SIGRUN_AWAIT_DEBUG=1     log fetch failures
 */
const GHCR_BASE = (process.env.SIGRUN_GHCR_BASE ?? "https://ghcr.io").replace(
	/\/+$/,
	"",
);
const POLL_INTERVAL_MS = Number.parseInt(process.env.SIGRUN_POLL_INTERVAL_MS ?? "60000", 10);
const REQUEST_TIMEOUT_MS = Number.parseInt(
	process.env.SIGRUN_REQUEST_TIMEOUT_MS ?? "30000",
	10,
);

/** The OCI image-index media type the multi-arch build pushes. Asking for
 * the index (not a platform manifest) is what makes one probe answer for
 * every architecture. */
const MANIFEST_ACCEPT = [
	"application/vnd.oci.image.index.v1+json",
	"application/vnd.docker.distribution.manifest.list.v2+json",
	"application/vnd.oci.image.manifest.v1+json",
].join(", ");

function usage() {
	process.stderr.write(
		"usage: await-image.mjs --timeout-min <n> <owner>/<image>:<tag>...\n",
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

function sleep(ms) {
	// DO NOT unref this timer — the same reason await-registry.mjs
	// documents: an unref'd timer lets node exit 13 "unsettled top-level
	// await" when the poll sleep is the only pending work.
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parse `<owner>/<image>:<tag>`. The repository path may itself contain
 * slashes (`sigrun-ai/charts/sigrun`), so the tag is everything after the
 * LAST ':' — which is also why a registry host with a port cannot be
 * accepted here: the specs are repositories, not URLs. */
function parseSpec(spec) {
	const colon = spec.lastIndexOf(":");
	if (colon <= 0 || colon === spec.length - 1) {
		process.stderr.write(`await-image: '${spec}' is not <owner>/<image>:<tag>\n`);
		process.exit(2);
	}
	const repository = spec.slice(0, colon);
	const tag = spec.slice(colon + 1);
	if (!repository.includes("/")) {
		process.stderr.write(
			`await-image: '${spec}' must be <owner>/<image>:<tag> (got repository '${repository}')\n`,
		);
		process.exit(2);
	}
	return { repository, tag };
}

const specs = positional.map(parseSpec);

function debug(message) {
	if (process.env.SIGRUN_AWAIT_DEBUG === "1") process.stderr.write(`${message}\n`);
}

/** The anonymous pull token for one repository. GHCR scopes tokens per
 * repository, so this is fetched per spec and cached for the run. */
const tokenCache = new Map();
async function pullToken(repository) {
	const cached = tokenCache.get(repository);
	if (cached !== undefined) return cached;
	const url = `${GHCR_BASE}/token?scope=repository:${repository}:pull&service=${encodeURIComponent(GHCR_BASE)}`;
	try {
		const response = await fetch(url, {
			redirect: "follow",
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (!response.ok) {
			debug(`await-image: token for ${repository} answered ${response.status}`);
			return undefined;
		}
		const body = await response.json();
		const token = typeof body?.token === "string" ? body.token : undefined;
		if (token !== undefined) tokenCache.set(repository, token);
		return token;
	} catch (cause) {
		debug(
			`await-image: token fetch for ${repository} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
		);
		return undefined;
	}
}

/** GET the manifest; true when it 200s. */
async function fetchable({ repository, tag }) {
	const token = await pullToken(repository);
	if (token === undefined) return false;
	const url = `${GHCR_BASE}/v2/${repository}/manifests/${tag}`;
	try {
		const response = await fetch(url, {
			method: "GET",
			headers: { Authorization: `Bearer ${token}`, Accept: MANIFEST_ACCEPT },
			redirect: "follow",
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		return response.status === 200;
	} catch (cause) {
		// A network error is indistinguishable from "not there yet" — treat
		// it as missing and let the poll retry (await-registry's contract).
		debug(
			`await-image: fetch ${url} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
		);
		return false;
	}
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
		process.stdout.write(`await-image: all ${specs.length} image(s) live\n`);
		process.exit(0);
	}
	if (Date.now() >= deadline) {
		for (const spec of missing) {
			process.stderr.write(
				`await-image: ${spec.repository}:${spec.tag} is NOT live at ${GHCR_BASE}/v2/${spec.repository}/manifests/${spec.tag}\n`,
			);
		}
		process.stderr.write(
			`await-image: timed out after ${timeoutMin} min with ${missing.length} image(s) missing\n`,
		);
		process.exit(1);
	}
	await sleep(POLL_INTERVAL_MS);
}
