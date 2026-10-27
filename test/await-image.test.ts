/**
 * await-image.mjs (chart decoupling): the image-propagation waiter.
 * The chart's default image tag is its `appVersion`, so a chart pushed
 * before that image exists deploys into ImagePullBackOff — and a pushed
 * chart version is immutable. This script polls each
 * `<owner>/<image>:<tag>` manifest on GHCR until every one answers 200,
 * then exits 0. On timeout it exits 1, naming the missing images.
 *
 * These tests are hermetic BY CONSTRUCTION: the registry base is
 * overridable via SIGRUN_GHCR_BASE (the release jobs never set it; the
 * script defaults to https://ghcr.io), so every case runs against a
 * loopback HTTP stub — no network. The poll interval is overridable via
 * SIGRUN_POLL_INTERVAL_MS for the same reason (a 60 s default would make
 * the "becomes 200 mid-window" case untestable).
 *
 * THE STUB RUNS OUT OF PROCESS, mirroring await-registry.test.ts: the
 * script under test is spawned with `spawnSync`, which blocks this
 * process's event loop for its whole duration, so an in-process
 * `http.Server` could never answer a request while it runs. The stub
 * therefore lives in `fixtures/ghcr-stub.mjs`, is spawned as a child,
 * and reports its port on stdout. Liveness is read from a JSON file on
 * every request, so a test can flip an image live mid-poll without IPC.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "await-image.mjs");
const STUB = join(import.meta.dirname, "fixtures", "ghcr-stub.mjs");

/** Live stub processes and temp dirs, torn down in afterEach. */
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

/**
 * Start the out-of-process GHCR stub. `images` is the initial set of
 * `<owner>/<image>:<tag>` entries that answer 200; everything else 404s.
 * `add` makes an image live mid-poll by rewriting the stub's liveness
 * file.
 */
async function ghcrStub(
	images: string[],
): Promise<{ base: string; add: (spec: string, delayMs?: number) => void }> {
	const dir = mkdtempSync(join(tmpdir(), "await-image-stub-"));
	const liveFile = join(dir, "live.json");
	writeFileSync(liveFile, JSON.stringify(images));

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
			() => reject(new Error("ghcr stub did not report a port within 10s")),
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
			reject(new Error(`ghcr stub exited with ${code}`));
		});
	});

	return {
		base: `http://127.0.0.1:${port}`,
		/**
		 * Make an image live after `delayMs`. The write must happen from a
		 * SEPARATE process: the caller immediately blocks this event loop with
		 * spawnSync, so an in-process timer would never fire in time.
		 */
		add: (spec: string, delayMs = 100) => {
			images.push(spec);
			const next = JSON.stringify([...new Set(images)]);
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
			SIGRUN_GHCR_BASE: base,
			SIGRUN_POLL_INTERVAL_MS: "25",
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

describe("await-image.mjs", () => {
	test("all present → exit 0", async () => {
		const { base } = await ghcrStub([
			"acme/app:0.2.0",
			"acme/other:0.3.1",
		]);
		const res = runAwait(
			["--timeout-min", "0", "acme/app:0.2.0", "acme/other:0.3.1"],
			base,
		);
		expect(res.code, res.stderr + res.stdout).toBe(0);
		expect(res.stdout).toContain("all 2 image(s) live");
	});

	test("a repository with slashes resolves (the charts/<name> shape)", async () => {
		// helm push appends the chart name, so the OCI repository is
		// `sigrun-ai/charts/sigrun` — the tag is still after the LAST colon.
		const { base } = await ghcrStub(["acme/charts/widget:0.2.0"]);
		const res = runAwait(
			["--timeout-min", "0", "acme/charts/widget:0.2.0"],
			base,
		);
		expect(res.code, res.stderr + res.stdout).toBe(0);
	});

	test("one 404 at --timeout-min 0 → exit 1 naming the missing image", async () => {
		const { base } = await ghcrStub(["acme/app:0.2.0"]);
		const res = runAwait(
			["--timeout-min", "0", "acme/app:0.2.0", "acme/other:0.3.1"],
			base,
		);
		expect(res.code, res.stdout).toBe(1);
		const out = res.stderr + res.stdout;
		expect(out).toContain("acme/other:0.3.1");
		expect(out).not.toContain("acme/app:0.2.0");
	});

	test("a 404 that becomes 200 within the poll window → exit 0", async () => {
		const { base, add } = await ghcrStub(["acme/app:0.2.0"]);
		// Flip the missing image live after ~100 ms: the 25 ms test interval
		// gives several 404 polls first, which is what separates a real poll
		// loop from a one-shot check.
		add("acme/other:0.3.1", 100);
		const res = runAwait(
			["--timeout-min", "1", "acme/app:0.2.0", "acme/other:0.3.1"],
			base,
		);
		expect(res.code, res.stderr + res.stdout).toBe(0);
	});

	test("usage errors exit 2 (no specs, bad flag, missing tag)", async () => {
		const { base } = await ghcrStub([]);
		expect(runAwait(["--timeout-min", "0"], base).code).toBe(2);
		expect(runAwait(["--bogus", "0", "acme/app:0.2.0"], base).code).toBe(2);
		// No colon → no tag.
		expect(runAwait(["--timeout-min", "0", "acme/app"], base).code).toBe(2);
		// Colon but no repository slash (a bare tag).
		expect(runAwait(["--timeout-min", "0", "app:0.2.0"], base).code).toBe(2);
	});
});
