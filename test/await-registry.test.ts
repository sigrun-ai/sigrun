/**
 * await-registry.mjs (release workstream Task 2.3): the registry
 * propagation waiter. After publish-npm publishes the core-family
 * versions, npm's CDN can lag the write by minutes; this script polls
 * each package's TARBALL URL (fetch-only — no `npm view`, so none of the
 * §39/§43 packument-lag classes) until every one answers HTTP 200, then
 * exits 0. On timeout it exits 1, naming the still-missing versions.
 *
 * These tests are hermetic BY CONSTRUCTION: the registry base is
 * overridable via SIGRUN_REGISTRY_BASE (the release jobs never set it;
 * the script defaults to https://registry.npmjs.org), so every case runs
 * against a loopback HTTP stub — no network, no npm. The poll interval
 * is overridable via SIGRUN_POLL_INTERVAL_MS for the same reason (a
 * 60 s default would make the "becomes 200 mid-window" case untestable).
 *
 * THE STUB RUNS OUT OF PROCESS. The script under test is spawned with
 * `spawnSync`, which blocks this process's event loop for its whole
 * duration — an in-process `http.Server` could never answer a request
 * while it runs, so every fetch would time out and the suite would be
 * vacuous. The stub therefore lives in `fixtures/registry-stub.mjs`, is
 * spawned as a child, and reports its port on stdout. Liveness is read
 * from a JSON file on every request, so a test can flip a tarball live
 * mid-poll without any IPC.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "await-registry.mjs");
const STUB = join(import.meta.dirname, "fixtures", "registry-stub.mjs");

/** Live stub processes and temp dirs, torn down in afterEach. */
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

/**
 * Start the out-of-process registry stub. `tarballs` is the initial set
 * of paths that answer 200 (`/-/basename-version.tgz`); everything else
 * 404s. `add` makes a tarball live mid-poll by rewriting the stub's
 * liveness file.
 */
async function registryStub(
	tarballs: string[],
): Promise<{ base: string; add: (path: string, delayMs?: number) => void }> {
	const dir = mkdtempSync(join(tmpdir(), "await-registry-stub-"));
	const liveFile = join(dir, "live.json");
	writeFileSync(liveFile, JSON.stringify(tarballs));

	const child = spawn(process.execPath, [STUB], {
		env: { ...process.env, SIGRUN_STUB_LIVE_FILE: liveFile },
		stdio: ["ignore", "pipe", "pipe"],
	});
	cleanups.push(() => {
		child.kill("SIGKILL");
		rmSync(dir, { recursive: true, force: true });
	});

	const port = await new Promise<number>((resolve, reject) => {
		let buffered = "";
		const timer = setTimeout(
			() => reject(new Error("registry stub did not report a port within 10s")),
			10_000,
		);
		child.stdout?.on("data", (chunk: Buffer) => {
			buffered += chunk.toString();
			const newline = buffered.indexOf("\n");
			if (newline === -1) return;
			clearTimeout(timer);
			try {
				resolve((JSON.parse(buffered.slice(0, newline)) as { port: number }).port);
			} catch (cause) {
				reject(cause instanceof Error ? cause : new Error(String(cause)));
			}
		});
		child.once("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`registry stub exited with ${code}`));
		});
	});

	return {
		base: `http://127.0.0.1:${port}`,
		/**
		 * Make a tarball live after `delayMs`. The write must happen from a
		 * SEPARATE process: the caller immediately blocks this event loop with
		 * spawnSync, so an in-process timer would never fire in time. A
		 * detached one-shot node child does the sleep + rewrite.
		 */
		add: (path: string, delayMs = 100) => {
			tarballs.push(path);
			const next = JSON.stringify([...new Set(tarballs)]);
			const flip = spawn(
				process.execPath,
				[
					"-e",
					`setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(liveFile)}, ${JSON.stringify(next)}), ${delayMs})`,
				],
				{ stdio: "ignore", detached: true },
			);
			flip.unref();
		},
	};
}

/** Run the script against the stub; returns exit code, stdout, stderr. */
function runAwait(
	args: string[],
	base: string,
	env: Record<string, string> = {},
): { code: number; stdout: string; stderr: string } {
	const res = spawnSync(process.execPath, [SCRIPT, ...args], {
		encoding: "utf8",
		timeout: 30_000,
		killSignal: "SIGKILL",
		env: {
			...process.env,
			SIGRUN_REGISTRY_BASE: base,
			SIGRUN_POLL_INTERVAL_MS: "25",
			// Per-request timeout far below the 30 s spawnSync timeout — a
			// hung request must surface as "missing" and keep polling, not
			// stall the whole test run.
			SIGRUN_REQUEST_TIMEOUT_MS: "2000",
			...env,
		},
	});
	return {
		code: res.status ?? 2,
		stdout: res.stdout ?? "",
		stderr: res.stderr ?? "",
	};
}

describe("await-registry.mjs", () => {
	test("all present → exit 0", async () => {
		const { base } = await registryStub([
			"/@acme/ext-widget/-/ext-widget-0.2.0.tgz",
			"/@acme/ext-gadget/-/ext-gadget-0.3.1.tgz",
		]);
		const res = runAwait(
			["--timeout-min", "0", "@acme/ext-widget@0.2.0", "@acme/ext-gadget@0.3.1"],
			base,
		);
		expect(res.code, res.stderr + res.stdout).toBe(0);
	});

	test("one 404 at --timeout-min 0 → exit 1 naming the missing version", async () => {
		const { base } = await registryStub(["/@acme/ext-widget/-/ext-widget-0.2.0.tgz"]);
		const res = runAwait(
			["--timeout-min", "0", "@acme/ext-widget@0.2.0", "@acme/ext-gadget@0.3.1"],
			base,
		);
		expect(res.code, res.stdout).toBe(1);
		const out = res.stderr + res.stdout;
		expect(out).toContain("@acme/ext-gadget@0.3.1");
		expect(out).not.toContain("@acme/ext-widget@0.2.0");
	});

	test("a 404 that becomes 200 within the poll window → exit 0", async () => {
		const { base, add } = await registryStub([
			"/@acme/ext-widget/-/ext-widget-0.2.0.tgz",
			]);
		// Flip the missing tarball live after ~100 ms: the 25 ms test
		// interval gives several 404 polls before it turns 200, which is
		// what separates a real poll loop from a one-shot check. The flip
		// runs in a detached child because runAwait blocks this event loop.
		add("/@acme/ext-gadget/-/ext-gadget-0.3.1.tgz", 100);
		const res = runAwait(
			["--timeout-min", "1", "@acme/ext-widget@0.2.0", "@acme/ext-gadget@0.3.1"],
			base,
		);
		expect(res.code, res.stderr + res.stdout).toBe(0);
	});

	test("a version that never arrives → exit 1 on timeout, naming it", async () => {
		const { base } = await registryStub(["/@acme/ext-widget/-/ext-widget-0.2.0.tgz"]);
		const res = runAwait(
			["--timeout-min", "0", "@acme/ext-widget@0.2.0", "@acme/ext-gadget@0.3.1"],
			base,
		);
		expect(res.code).toBe(1);
		expect(res.stderr + res.stdout).toContain("@acme/ext-gadget@0.3.1");
	});

	test("usage errors exit 2 (no specs, bad flag)", async () => {
		const { base } = await registryStub([]);
		const noSpecs = runAwait(["--timeout-min", "0"], base);
		expect(noSpecs.code).toBe(2);
		const badFlag = runAwait(["--bogus", "0", "@acme/ext-widget@0.2.0"], base);
		expect(badFlag.code).toBe(2);
	});

	test("a spec without @version is a usage error (exit 2)", async () => {
		const { base } = await registryStub([]);
		const res = runAwait(["--timeout-min", "0", "@acme/ext-widget"], base);
		expect(res.code).toBe(2);
	});
});