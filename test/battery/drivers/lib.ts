/**
 * Shared library for the crash-battery DRIVERS (Task 12, spec §7 M1 battery).
 *
 * Driver protocol (see test/battery/lib.ts for the vitest-side orchestration):
 *
 * - argv: `<mode> <dir>` where mode is `setup` or `verify`; `dir` is the
 *   battery tmpdir the TEST owns (mkdtemp … rm) — drivers never clean it up.
 * - stdout markers are line-delimited and flushed (drain-awaited) before any
 *   deliberate exit, printed only AFTER the state they describe is durably
 *   established, so the test's read-marker-then-kill ordering cannot race:
 *   `READY` (harness booted + scenario registered), scenario kill markers
 *   (`GENERATING`, `TOOL_RUNNING:<tool>`), and the verify pair
 *   `VERIFIED:<json>` (exit 0) / `VERIFY-FAIL:<reason>` (exit 1).
 * - drivers are standalone tsx scripts: NO vitest imports in this file tree.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	fauxProvider,
	type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";
import { loadConfig } from "../../../src/config.js";
import { openHarness, type OpenedHarness } from "../../../src/harness/boot.js";
import type { ProviderContributor } from "../../../src/harness/providers/index.js";

/** The scenario state the setup pass records for the verify pass. */
export interface ScenarioState {
	/** The submission the scenario killed mid-flight. */
	readonly submissionId: string | number;
}

/**
 * The driver self-watchdog: at driver start, arm a hard exit at
 * `budgetMs` (default 2 minutes) printing `SELF-TIMEOUT`. A driver that
 * outlives its scenario budget — e.g. its orchestration test died before
 * killing it — exits loudly instead of spinning on keepalive timers
 * forever (observed in the wild: an orphaned battery driver burned 37%
 * CPU for minutes). Wired into `parseDriverArgs` so no driver can forget
 * it; `unref`d so it never holds a healthy driver's event loop open.
 */
export function startSelfWatchdog(budgetMs = 120_000): void {
	const timer = setTimeout(() => {
		process.stdout.write("SELF-TIMEOUT\n");
		process.exit(3);
	}, budgetMs);
	timer.unref();
}

/** Parse and validate the driver argv. Fail-loud on misuse (exit 2). */
export function parseDriverArgs(): { mode: "setup" | "verify"; dir: string } {
	const [mode, dir] = process.argv.slice(2);
	if ((mode !== "setup" && mode !== "verify") || dir === undefined) {
		process.stderr.write("usage: tsx <driver.ts> <setup|verify> <dir>\n");
		process.exit(2);
	}
	startSelfWatchdog();
	return { mode, dir };
}

/** Print one stdout marker line (line-delimited protocol). */
export function marker(line: string): void {
	process.stdout.write(`${line}\n`);
}

/** Read the scenario state the setup pass recorded. */
export async function readScenarioState(
	dir: string,
): Promise<ScenarioState> {
	return JSON.parse(
		await readFile(join(dir, "scenario.json"), "utf8"),
	) as ScenarioState;
}

/** Record the scenario state for the verify pass. */
export async function writeScenarioState(
	dir: string,
	state: ScenarioState,
): Promise<void> {
	await writeFile(join(dir, "scenario.json"), JSON.stringify(state));
}

/**
 * Boot a REAL harness on `<dir>/sigrun.db` with the faux provider — the same
 * registration pattern as `test/backup.test.ts`'s `bootHarness` (T11). The
 * faux options pass `tokensPerSecond`/`tokenSize` through so a driver can
 * slow streaming deterministically (the kill-timing lever).
 */
export async function bootScenarioHarness(
	dir: string,
	responses: FauxResponseStep[],
	fauxOptions?: { tokensPerSecond?: number; tokenSize?: { min?: number; max?: number } },
): Promise<OpenedHarness> {
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
		...fauxOptions,
	});
	faux.setResponses(responses);
	const contributor: ProviderContributor = {
		name: "ext-faux",
		providers: [{ provider: faux.provider }],
	};
	const config = loadConfig({
		SIGRUN_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
	});
	return openHarness(config, { extensions: [contributor], env: {} });
}

/** Await `promise` but never longer than `ms`; fail loud on the deadline. */
export async function withDeadline<T>(
	promise: Promise<T>,
	ms: number,
	what: string,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(`${what} did not settle within ${ms}ms`)),
					ms,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/** The one-shot success exit: flush the marker, then exit 0. */
export async function verified(payload: unknown): Promise<never> {
	await flushMarker(`VERIFIED:${JSON.stringify(payload)}`);
	process.exit(0);
}

/** The one-shot failure exit: flush the marker, then exit 1. */
export async function verifyFailed(reason: string): Promise<never> {
	await flushMarker(`VERIFY-FAIL:${reason}`);
	process.exit(1);
}

/** Flush one marker line to the pipe (await drain) before a hard exit. */
async function flushMarker(line: string): Promise<void> {
	await new Promise<void>((resolve) => {
		if (process.stdout.write(`${line}\n`)) resolve();
		else process.stdout.once("drain", resolve);
	});
}
