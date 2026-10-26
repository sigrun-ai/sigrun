// Out-of-process registry stub for test/await-registry.test.ts.
// The test harness spawns the script under test with spawnSync, which
// BLOCKS the event loop — an in-process http.Server could never answer.
// So the stub runs here, as a child process, and reports its port on
// stdout as a JSON line once listening.
//
// Usage: node stub-server.mjs '<json array of live tarball paths>'
//        node stub-server.mjs --add <path>   (not used; the test drives
//                                             liveness via a control file)
//
// Liveness is re-read from the file named by SIGRUN_STUB_LIVE_FILE on
// every request, so the test can flip a tarball live mid-poll without
// IPC.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const liveFile = process.env.SIGRUN_STUB_LIVE_FILE;
if (!liveFile) {
	console.error("stub-server: SIGRUN_STUB_LIVE_FILE is required");
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
	if (liveSet().has(req.url ?? "")) {
		res.writeHead(200, { "content-length": "0" });
	} else {
		res.writeHead(404, { "content-length": "0" });
	}
	res.end();
});

server.listen(0, "127.0.0.1", () => {
	const { port } = server.address();
	process.stdout.write(`${JSON.stringify({ port })}\n`);
});
