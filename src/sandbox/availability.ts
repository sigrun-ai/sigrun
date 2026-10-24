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

/**
 * The security boundary check: a fresh probe file is deliberately absent
 * from the policy grants. Only a FAILED read passes; a zero exit means the
 * helper ran the command unconfined and must never count as available.
 * Quoting keeps an unusual TMPDIR from changing the shell command.
 */
export async function selfTestHelper(helper: string): Promise<boolean> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-sandbox-self-test-"));
	const probe = join(dir, "probe");
	const quotedProbe = `'${probe.replaceAll("'", `'"'"'`)}'`;
	try {
		await writeFile(probe, "sandbox boundary probe\n", { mode: 0o600 });
		try {
			await execFileAsync(
				helper,
				["run", "--", "/bin/sh", "-c", `cat ${quotedProbe}`],
				{
					env: {
						...process.env,
						SIGRUN_SANDBOX_POLICY: JSON.stringify({
							ro: [
								"/bin",
								"/usr/bin",
								"/lib",
								"/lib64",
								"/usr/lib",
								"/usr/lib64",
							],
							rw: [],
							minAbi: 6,
						}),
					},
				},
			);
			return false;
		} catch {
			return true;
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
