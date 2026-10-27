// Out-of-process GHCR stub for test/await-image.test.ts.
// The test harness spawns the script under test with spawnSync, which
// BLOCKS the event loop — an in-process http.Server could never answer.
// So the stub runs here, as a child process, and reports its port on
// stdout as a JSON line once listening.
//
// Usage: node ghcr-stub.mjs
//
// It speaks the two GHCR endpoints await-image.mjs uses:
//
//   GET /token?scope=repository:<repo>:pull&service=<base>
//     -> {"token":"<opaque>"}   (always; the token value is never checked)
//   GET /v2/<repo>/manifests/<tag>
//     -> 200 when "<repo>:<tag>" is in the live set, else 404
//
// Liveness is re-read from the file named by SIGRUN_STUB_LIVE_FILE on
// every request, so a test can flip an image live mid-poll without IPC.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const liveFile = process.env.SIGRUN_STUB_LIVE_FILE;
if (!liveFile) {
	console.error("ghcr-stub: SIGRUN_STUB_LIVE_FILE is required");
	process.exit(2);
}

function liveSet() {
	try {
		return new Set(JSON.parse(readFileSync(liveFile, "utf8")));
	} catch {
		return new Set();
	}
}

const server = createServer((req, res) => {
	const url = new URL(req.url ?? "/", "http://127.0.0.1");

	if (url.pathname === "/token") {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ token: "stub-token" }));
		return;
	}

	// /v2/<owner>/<image...>/manifests/<tag> — the repository may contain
	// slashes, so slice between the fixed prefix and the final segment.
	const match = /^\/v2\/(.+)\/manifests\/([^/]+)$/.exec(url.pathname);
	if (match === null) {
		res.writeHead(404, { "content-length": "0" });
		res.end();
		return;
	}
	const [, repository, tag] = match;
	if (liveSet().has(`${repository}:${tag}`)) {
		res.writeHead(200, { "content-type": "application/vnd.oci.image.index.v1+json" });
	} else {
		res.writeHead(404, { "content-length": "0" });
	}
	res.end();
});

server.listen(0, "127.0.0.1", () => {
	const { port } = server.address();
	process.stdout.write(`${JSON.stringify({ port })}\n`);
});
