/** Test-only child entry; production composition and shutdown are unchanged. */

import { writeFile } from "node:fs/promises";
import { serve } from "../../src/serve.js";

if (process.env.SIGRUN_BOUNDARY_IT !== "1") {
	throw new Error("server-entry.ts is only for the sandbox integration suite");
}

if (process.env.SIGRUN_BOUNDARY_PID_FILE !== undefined) {
	// The unshare wrapper's pid is NOT sigrun's. Record the actual server
	// process for procfs/ptrace assertions before it begins listening.
	await writeFile(process.env.SIGRUN_BOUNDARY_PID_FILE, `${process.pid}\n`, { mode: 0o600 });
}

const booted = await serve(process.env, { host: "127.0.0.1" });
let stopping = false;
const stop = (): void => {
	if (stopping) process.exit(130);
	stopping = true;
	void booted.shutdownOnce().then(
		() => process.exit(0),
		(error: unknown) => {
			console.error("sandbox integration sigrun shutdown failed", error);
			process.exit(1);
		},
	);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
