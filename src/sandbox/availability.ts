/** Boot-time Landlock availability probe and fail-closed helper self-test. */

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface IsolationAvailability {
	readonly available: boolean;
	readonly abi: number;
	readonly helper?: string;
	readonly reason?: string;
}

/** Execute the helper's lightweight `probe` command and parse its ABI. */
export async function runHelperProbe(helper: string): Promise<{ abi: number }> {
	const { stdout } = await execFileAsync(helper, ["probe"]);
	const result: unknown = JSON.parse(stdout);
	if (
		typeof result !== "object" ||
		result === null ||
		!("abi" in result) ||
		typeof result.abi !== "number" ||
		!Number.isInteger(result.abi)
	) {
		throw new Error("sigrun-sandbox probe returned an invalid ABI");
	}
	return { abi: result.abi };
}

/** One self-test leg, changing only whether the probe dir is granted. */
async function runSelfTestLeg(
	helper: string,
	command: string,
	probeDir: string,
	grantProbe: boolean,
): Promise<{ stdout: string; stderr: string }> {
	const ro = [
		"/bin",
		"/usr/bin",
		"/lib",
		"/lib64",
		"/usr/lib",
		"/usr/lib64",
		...(grantProbe ? [probeDir] : []),
	];
	return execFileAsync(helper, ["run", "--", "/bin/sh", "-c", command], {
		env: {
			...process.env,
			SIGRUN_SANDBOX_POLICY: JSON.stringify({ ro, rw: [], minAbi: 6 }),
		},
	});
}

/**
 * The security boundary check runs the IDENTICAL shell command twice; only
 * the policy changes. First the control grants the 0600, user-owned probe's
 * directory read-only: exact probe content on stdout and exit zero prove
 * the helper, /bin/sh, cat, PATH, command, and file all work when permitted.
 * Then the denial leg withholds that grant. It must exit non-zero with only
 * the shell's post-`cat` READ_DENIED marker on stdout, and stderr free of
 * helper refusals and command-missing diagnostics. Requiring both legs makes
 * the policy the sole explanation for the different read outcomes. Quoting
 * keeps an unusual TMPDIR from changing the shell command.
 */
export async function selfTestHelper(helper: string): Promise<boolean> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-sandbox-self-test-"));
	const probe = join(dir, "probe");
	const content = "sandbox boundary probe\n";
	const quotedProbe = `'${probe.replaceAll("'", `'"'"'`)}'`;
	const command = `if cat ${quotedProbe}; then exit 0; else printf 'READ_DENIED\\n'; exit 1; fi`;
	try {
		await writeFile(probe, content, { mode: 0o600 });
		let control: { stdout: string; stderr: string };
		try {
			control = await runSelfTestLeg(helper, command, dir, true);
		} catch {
			return false;
		}
		if (control.stdout !== content || control.stderr !== "") return false;

		try {
			await runSelfTestLeg(helper, command, dir, false);
			return false;
		} catch (error) {
			if (typeof error !== "object" || error === null) return false;
			const outcome = error as {
				code?: unknown;
				stdout?: unknown;
				stderr?: unknown;
			};
			return (
				typeof outcome.code === "number" &&
				outcome.code !== 0 &&
				outcome.stdout === "READ_DENIED\n" &&
				typeof outcome.stderr === "string" &&
				!outcome.stderr.includes("sigrun-sandbox:") &&
				!outcome.stderr.includes("No such file or directory") &&
				!outcome.stderr.includes("not found")
			);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** Decide availability once per boot, short-circuiting unusable helpers. */
export async function probeIsolation(opts: {
	platform: NodeJS.Platform;
	helper: string | undefined;
	runProbe(helper: string): Promise<{ abi: number }>;
	selfTest(helper: string): Promise<boolean>;
}): Promise<IsolationAvailability> {
	if (opts.platform !== "linux") {
		return { available: false, abi: 0, reason: "not linux" };
	}
	if (opts.helper === undefined) {
		return { available: false, abi: 0, reason: "sandbox helper not found" };
	}
	const { abi } = await opts.runProbe(opts.helper);
	if (abi < 6) {
		return {
			available: false,
			abi,
			reason: `landlock ABI ${abi} < 6`,
		};
	}
	if (!(await opts.selfTest(opts.helper))) {
		return { available: false, abi, reason: "self-test failed" };
	}
	return { available: true, abi, helper: opts.helper };
}
