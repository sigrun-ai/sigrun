/** Boot-time Landlock availability probe and fail-closed helper self-test. */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { lookupOsAccount, type OsAccountReader } from "./os-account.js";

const execFileAsync = promisify(execFile);

export interface IsolationAvailability {
	readonly available: boolean;
	readonly abi: number;
	readonly helper?: string;
	readonly reason?: string;
}

/** The independent opt-in uid/gid-switch capability decision. */
export interface OsUsersAvailability {
	readonly available: boolean;
	/** The exact /v1/meta value: available, off, or the failure reason. */
	readonly status: "available" | "off" | "osUsers requires CAP_SETUID";
}

export type OsUsersProbeRunner = (
	helper: string,
	args: readonly string[],
	options: { env: Record<string, string> },
) => Promise<{ stdout: string }>;

/**
 * Prove a real identity transition, not merely the presence of a helper.
 * Every failure has the one operator-actionable reason; no failed switch is
 * ever treated as permission to run under the service account instead.
 */
export async function probeOsUsers(
	helper: string,
	options?: {
		read?: OsAccountReader;
		run?: OsUsersProbeRunner;
	},
): Promise<OsUsersAvailability> {
	const unavailable = (): OsUsersAvailability => ({
		available: false,
		status: "osUsers requires CAP_SETUID",
	});
	try {
		const account = lookupOsAccount("nobody", options?.read);
		if (account === undefined) return unavailable();
		const run = options?.run ?? (async (
			command: string,
			args: readonly string[],
			execOptions: { env: Record<string, string> },
		) => execFileAsync(command, args, execOptions));
		const { stdout } = await run(helper, ["run", "--", "/usr/bin/id", "-u"], {
			env: {
				LC_ALL: "C",
				SIGRUN_SANDBOX_POLICY: JSON.stringify({
					ro: ["/usr", "/usr/bin", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/etc", "/opt", "/proc", "/sys"],
					rw: [],
					minAbi: 6,
					uid: account.uid,
					gid: account.gid,
					groups: account.groups,
				}),
			},
		});
		return stdout.trim() === String(account.uid)
			? { available: true, status: "available" }
			: unavailable();
	} catch {
		return unavailable();
	}
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

/** One reader invocation, changing only whether the probe dir is granted. */
async function runSelfTestLeg(
	helper: string,
	reader: string,
	probe: string,
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
		dirname(reader),
		dirname(process.execPath),
		...(grantProbe ? [probeDir] : []),
	];
	return execFileAsync(helper, ["run", "--", process.execPath, reader, probe], {
		env: {
			...process.env,
			LC_ALL: "C",
			SIGRUN_SANDBOX_POLICY: JSON.stringify({ ro, rw: [], minAbi: 6 }),
		},
	});
}

const SELF_TEST_READER = `
console.log("BEGIN");
try {
	const content = require("node:fs").readFileSync(process.argv[2], "utf8");
	console.log("READ_OK:" + content);
} catch (error) {
	console.log("READ_DENIED:" + (error && error.code ? error.code : "UNKNOWN"));
	process.exitCode = 1;
}
`;

/**
 * The security boundary check runs OUR reader twice with identical argv;
 * only the probe-directory grant changes. The reader prints BEGIN before
 * touching the file, then READ_OK with the content or READ_DENIED with the
 * machine-readable errno. The control requires exact successful output,
 * proving helper exec, node, the script, and the file work when permitted.
 * The denial leg requires BEGIN plus READ_DENIED:EACCES and no helper-refusal
 * line. No locale-dependent stderr text classifies the failure: the errno is
 * the positive evidence, and BEGIN proves the reader actually executed.
 */
export async function selfTestHelper(helper: string): Promise<boolean> {
	const root = await mkdtemp(join(tmpdir(), "sigrun-sandbox-self-test-"));
	const grantedDir = join(root, "granted");
	const probeDir = join(root, "probe");
	const reader = join(grantedDir, "reader.cjs");
	const probe = join(probeDir, "probe");
	const content = "sandbox boundary probe\n";
	try {
		await mkdir(grantedDir);
		await mkdir(probeDir);
		await writeFile(reader, SELF_TEST_READER, { mode: 0o600 });
		await writeFile(probe, content, { mode: 0o600 });

		let control: { stdout: string; stderr: string };
		try {
			control = await runSelfTestLeg(helper, reader, probe, probeDir, true);
		} catch {
			return false;
		}
		if (control.stdout !== `BEGIN\nREAD_OK:${content}\n`) return false;

		try {
			await runSelfTestLeg(helper, reader, probe, probeDir, false);
			return false;
		} catch (error) {
			if (typeof error !== "object" || error === null) return false;
			const outcome = error as {
				code?: unknown;
				stdout?: unknown;
				stderr?: unknown;
			};
			if (typeof outcome.stderr !== "string") return false;
			return (
				typeof outcome.code === "number" &&
				outcome.code !== 0 &&
				outcome.stdout === "BEGIN\nREAD_DENIED:EACCES\n" &&
				!outcome.stderr
					.split(/\r?\n/)
					.some((line) => line.startsWith("sigrun-sandbox:"))
			);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
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
