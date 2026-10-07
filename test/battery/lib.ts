/**
 * Crash-battery orchestration (Task 12): the vitest-side driver runner.
 *
 * Each battery test spawns a driver as a REAL node process, reads its
 * line-delimited stdout markers with FAIL-LOUD deadlines (a missing marker
 * fails the test in seconds, never at vitest's default timeout), SIGKILLs
 * the whole process GROUP on the scenario's kill marker, asserts the
 * killed-by-signal exit, then spawns the verify pass and asserts `VERIFIED`
 * + exit 0. The test owns the tmpdir lifecycle (mkdtemp … rm); drivers never
 * clean it up.
 *
 * Spawn mechanics (hardening, post-orphan-incident): the driver runs as
 * `process.execPath --import <tsx loader> <driver.ts> …` — ONE process, the
 * tsx ESM loader hooks loaded in-process (mirrors how pi runs its own
 * scripts; `node node_modules/.bin/tsx …` spawns a CLI wrapper process
 * whose SIGKILL does NOT reach the real driver — the wrapper's child
 * survived the battery's first run and spun CPU until manually killed).
 * The child is spawned `detached` (its own process group) and the kill goes
 * to the NEGATIVE pid (the whole group), so a missed kill of any descendant
 * is impossible; each driver additionally self-watches (see drivers/lib.ts).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Repo root (this file lives at test/battery/). */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** The tsx ESM loader hooks (loaded IN-PROCESS — no CLI wrapper process). */
const TSX_LOADER = pathToFileURL(
	join(REPO_ROOT, "node_modules/tsx/dist/loader.mjs"),
).href;

/** The drivers directory. */
export const DRIVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "drivers");

/** One marker line + the process exit, both observable. */
export interface DriverExit {
	readonly code: number | null;
	readonly signal: string | null;
}

/** A spawned driver process: line-buffered stdout + exit observation. */
export class DriverProcess {
	readonly lines: string[] = [];
	stderr = "";
	private readonly waiters: {
		prefixes: readonly string[];
		resolve: (line: string) => void;
		reject: (error: Error) => void;
		timer: ReturnType<typeof setTimeout>;
	}[] = [];

	constructor(private readonly child: ChildProcess) {
		child.stdout?.setEncoding("utf8");
		let buffer = "";
		child.stdout?.on("data", (chunk: string) => {
			buffer += chunk;
			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (line.length > 0) this.lines.push(line);
				this.notify(line);
				newline = buffer.indexOf("\n");
			}
		});
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			this.stderr += chunk;
		});
		// A driver that exits (or fails to spawn) before its marker fails the
		// wait IMMEDIATELY, carrying everything it printed — never a silent
		// hang until the wait deadline.
		child.once("exit", (code, signal) => {
			this.rejectWaiters(
				`driver exited (code=${String(code)}, signal=${String(signal)}) before printing the awaited marker`,
			);
		});
		child.once("error", (error) => {
			this.rejectWaiters(`driver failed to spawn: ${String(error)}`);
		});
	}

	/**
	 * Wait for the first line starting with any of `prefixes`, with a
	 * fail-loud deadline. Rejects when the driver exits or errors first,
	 * carrying everything it printed (the failure must be diagnosable).
	 */
	waitForLine(prefix: string, timeoutMs: number): Promise<string> {
		return this.waitForAny([prefix], timeoutMs);
	}

	/** Same as `waitForLine` with several acceptable prefixes. */
	waitForAny(prefixes: readonly string[], timeoutMs: number): Promise<string> {
		for (const line of this.lines) {
			if (prefixes.some((prefix) => line.startsWith(prefix))) {
				return Promise.resolve(line);
			}
		}
		return new Promise((resolve, reject) => {
			const waiter = {
				prefixes,
				resolve,
				reject,
				timer: setTimeout(() => {
					const index = this.waiters.indexOf(waiter);
					if (index !== -1) this.waiters.splice(index, 1);
					reject(
						new Error(
							`driver never printed ${prefixes.join(" | ")} within ${timeoutMs}ms (lines so far: ${JSON.stringify(this.lines)}, stderr: ${this.stderr})`,
						),
					);
				}, timeoutMs),
			};
			this.waiters.push(waiter);
		});
	}

	/**
	 * SIGKILL the whole process GROUP (the driver leads it — detached spawn)
	 * and observe the exit. The group kill makes a missed kill impossible:
	 * the direct child alone would suffice here (no wrapper process), but any
	 * process the driver itself spawned dies with it too, and an orphaned
	 * driver keeps the stdout pipe open (the test hangs) and burns CPU.
	 */
	async kill(): Promise<DriverExit> {
		try {
			process.kill(-this.child.pid!, "SIGKILL");
		} catch {
			// Group already gone (ESRCH): fall through to the direct kill.
		}
		try {
			this.child.kill("SIGKILL");
		} catch {
			// Already dead — the exit event is what matters.
		}
		return this.exited();
	}

	/** The process exit, once it happens (deadline-guarded). */
	async exited(timeoutMs = 10_000): Promise<DriverExit> {
		return await new Promise((resolve, reject) => {
			const timer = setTimeout(
				() =>
					reject(
						new Error(
							`driver did not exit within ${timeoutMs}ms (lines: ${JSON.stringify(this.lines)}, stderr: ${this.stderr})`,
						),
					),
				timeoutMs,
			);
			const done = (code: number | null, signal: string | null) => {
				clearTimeout(timer);
				resolve({ code, signal });
			};
			this.child.once("exit", done);
			this.child.once("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
		});
	}

	private notify(line: string): void {
		for (const waiter of [...this.waiters]) {
			if (waiter.prefixes.some((prefix) => line.startsWith(prefix))) {
				clearTimeout(waiter.timer);
				this.removeWaiter(waiter);
				waiter.resolve(line);
			}
		}
	}

	private rejectWaiters(reason: string): void {
		for (const waiter of [...this.waiters]) {
			this.removeWaiter(waiter);
			waiter.reject(
				new Error(
					`${reason} (lines: ${JSON.stringify(this.lines)}, stderr: ${this.stderr})`,
			),
		);
		}
	}

	private removeWaiter(waiter: (typeof this.waiters)[number]): void {
		const index = this.waiters.indexOf(waiter);
		if (index !== -1) this.waiters.splice(index, 1);
	}
}

/** Spawn a driver pass: one node process with the tsx loader in-process. */
export function spawnDriver(
	driverPath: string,
	args: readonly string[],
): DriverProcess {
	// detached: the driver leads its own process group so the kill can reach
	// every descendant at once (negative-pid group kill in DriverProcess.kill).
	const child = spawn(
		process.execPath,
		["--import", TSX_LOADER, driverPath, ...args],
		{ stdio: ["ignore", "pipe", "pipe"], env: process.env, detached: true },
	);
	return new DriverProcess(child);
}

/**
 * Run the verify pass to completion: wait for `VERIFIED`/`VERIFY-FAIL` with
 * a fail-loud deadline, then require exit 0. Returns the parsed payload; a
 * VERIFY-FAIL or non-zero exit rejects with everything the driver printed.
 */
export async function runVerifyPass(
	driverPath: string,
	args: readonly string[],
	timeoutMs: number,
): Promise<Record<string, unknown>> {
	const driver = spawnDriver(driverPath, args);
	let line: string;
	try {
		line = await driver.waitForAny(["VERIFIED:", "VERIFY-FAIL:"], timeoutMs);
	} catch (error) {
		await driver.exited(1_000).catch(() => undefined);
		throw error;
	}
	const exit = await driver.exited();
	if (line.startsWith("VERIFY-FAIL:")) {
		throw new Error(
			`verify pass failed: ${line.slice("VERIFY-FAIL:".length)} (stderr: ${driver.stderr})`,
		);
	}
	if (exit.code !== 0) {
		throw new Error(
			`verify pass exited ${exit.code ?? `signal ${exit.signal}`} after VERIFIED`,
		);
	}
	return JSON.parse(line.slice("VERIFIED:".length)) as Record<string, unknown>;
}
