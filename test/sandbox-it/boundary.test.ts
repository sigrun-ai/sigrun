/**
 * Kernel proof for the multi-user execution boundary (spec §6 / M1 Task 10).
 *
 * CI on ubuntu-24.04 is the real run. Its sandbox-it job first requires
 * `sigrun-sandbox probe` to report ABI >= 6, so an unsuitable CI kernel fails
 * the job instead of turning these tests into skips. A local opt-in run on
 * WSL2 6.6 (ABI 3) skips with that exact named reason; it is NOT a pass.
 *
 * Every denial has a positive control and asserts a boundary errno or named
 * policy reason. Targets are independently checked outside the jail, so
 * ENOENT, bad paths, missing utilities, and dead fixtures cannot look like
 * confinement. The sigrun child is separate from vitest: a signal-scoping
 * regression cannot kill the test runner itself.
 */

import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	AgentConversation,
	assertFileExists,
	BOB_CONTROL,
	bootDeployment,
	CORE_ROOT,
	HELPER,
	buildNativeProbes,
	privilegedHelper,
	helperCommand,
	directCommand,
	nativePolicy,
	spawnUnjailed,
	directWorker,
	captureWorkerPid,
	terminateOutside,
	KILL_PROBE,
	MEM_PROBE,
	nodeProbe,
	plantCoreEnv,
	probeSandbox,
	READ_PROBE,
	WORKER_PID_PROBE,
	WRITE_PROBE,
	type Deployment,
	type NativeProbes,
	type PrivilegedHelper,
} from "./helpers.js";

const probe = await probeSandbox();
const SKIP_REASON = probe.reason ?? "";
if (SKIP_REASON !== "") console.warn(`sandbox-it skipped: ${SKIP_REASON}; CI on ubuntu-24.04 is the real run`);
const enabled = process.env.SIGRUN_SANDBOX_IT === "1" && probe.available;
const describeKernel = describe.skipIf(!enabled);

let deployment: Deployment;
let bob: AgentConversation;
let alice: AgentConversation;
let root: string;
let bobHome: string;
let bobTmp: string;
let coreEnv: { path: string; restore(): Promise<void> } | undefined;
let aliceWorkerPid: string;
let outsideDir: string;
let native: NativeProbes;
let privileged: PrivilegedHelper;
let service: ChildProcess | undefined;
let servicePid = 0;
let abstractSocket: ChildProcess | undefined;
const abstractName = `sigrun-boundary-${process.pid}-${Date.now()}`;
const roots: string[] = [];

function spawnOutside(command: string, args: string[], env: NodeJS.ProcessEnv = {}): ChildProcess {
	const child = spawnUnjailed(command, args, env);
	return child;
}

async function stopOutside(child: ChildProcess | undefined): Promise<void> {
	if (child === undefined) return;
	if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	await new Promise<void>((resolve) => {
		if (child.exitCode !== null || child.signalCode !== null) resolve();
		else child.once("exit", () => resolve());
	});
}

beforeAll(async () => {
	if (!enabled) return;
	root = await mkdtemp(join(tmpdir(), "sigrun-kernel-boundary-"));
	roots.push(root);
	deployment = await bootDeployment({ root });
	native = await buildNativeProbes(root);
	privileged = await privilegedHelper(root);
	coreEnv = await plantCoreEnv();
	await Promise.all([
		writeFile(join(deployment.aliceWorkspace, "alice-secret.txt"), "ALICE-WORKSPACE-SECRET\n"),
		writeFile(join(deployment.bobWorkspace, "bob-control.txt"), `${BOB_CONTROL}\n`),
		writeFile(join(deployment.configDir, "auth.json"), '{"boundary":"AUTH-JSON-SECRET"}\n'),
	]);
	for (const path of [
		join(deployment.aliceWorkspace, "alice-secret.txt"),
		join(deployment.configDir, "users.json"),
		join(deployment.configDir, "auth.json"),
		deployment.dbPath,
		coreEnv.path,
	]) await assertFileExists(path);

	bob = await AgentConversation.create(deployment, "bob");
	alice = await AgentConversation.create(deployment, "alice");
	const env = await bob.bash("printf 'HOME=%s\\nTMPDIR=%s\\n' \"$HOME\" \"$TMPDIR\"");
	expect(env.isError, env.text).toBe(false);
	bobHome = /^HOME=(.+)$/m.exec(env.text)?.[1] ?? "";
	bobTmp = /^TMPDIR=(.+)$/m.exec(env.text)?.[1] ?? "";
	expect(bobHome, env.text).not.toBe("");
	expect(bobTmp, env.text).not.toBe("");
	outsideDir = join(root, "outside-workspace");
	await mkdir(outsideDir);

	// Record the real sibling worker PID via the exec child's parent.
	const pidProbe = await alice.bash(nodeProbe(WORKER_PID_PROBE, join(deployment.aliceWorkspace, "worker-pid.txt")));
	expect(pidProbe.isError, pidProbe.text).toBe(false);
	aliceWorkerPid = (await readFile(join(deployment.aliceWorkspace, "worker-pid.txt"), "utf8")).trim();
	expect(aliceWorkerPid).toMatch(/^\d+$/);

	if (native.available) {
		// M2 per-user services are not shipped. This separate real-helper
		// process exercises the sibling-service boundary they will use.
		service = spawnOutside(HELPER, ["run", "--", native.path, "sleep"], {
			SIGRUN_SANDBOX_POLICY: JSON.stringify(nativePolicy(native.path)),
			SIGRUN_BOUNDARY_SERVICE_SECRET: "service-env-must-not-leak",
		});
		servicePid = service.pid!;
		let serviceReady = false;
		service.stdout!.on("data", (chunk: Buffer) => {
			if (chunk.toString().includes("SERVICE_READY:")) serviceReady = true;
		});
		abstractSocket = spawnOutside(native.path, ["socket-server", abstractName]);
		let socketReady = false;
		abstractSocket.stdout!.on("data", (chunk: Buffer) => {
			if (chunk.toString().includes("ABSTRACT_LISTEN_OK:")) socketReady = true;
		});
		await new Promise<void>((resolve, reject) => {
			const deadline = Date.now() + 10_000;
			const poll = (): void => {
				if (serviceReady && socketReady) resolve();
				else if (Date.now() > deadline) reject(new Error("service fixtures did not become ready"));
				else setTimeout(poll, 25);
			};
			poll();
		});
	}
}, 120_000);

afterAll(async () => {
	if (!enabled) return;
	await coreEnv?.restore();
	await stopOutside(service);
	await stopOutside(abstractSocket);
	await deployment?.stop();
	for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
}, 60_000);

async function ownReadControl(): Promise<void> {
	const own = await bob.read(join(deployment.bobWorkspace, "bob-control.txt"));
	expect(own.isError, own.text).toBe(false);
	expect(own.text).toContain(BOB_CONTROL);
}

async function readDenied(path: string): Promise<void> {
	await assertFileExists(path);
	await ownReadControl();
	const denied = await bob.read(path);
	expect(denied.isError, denied.text).toBe(true);
	expect(denied.text, `expected a boundary denial for ${path}`).toMatch(/EACCES|EPERM/);
	expect(denied.text).not.toMatch(/ENOENT|not found/i);
}

async function probeDenied(source: string, path: string, prefix: string): Promise<string> {
	await assertFileExists(path);
	const result = await bob.bash(nodeProbe(source, path));
	expect(result.isError, result.text).toBe(true);
	expect(result.text).toContain(`${prefix}:EACCES`);
	return result.text;
}

async function writeAllowed(path: string): Promise<void> {
	const result = await bob.bash(nodeProbe(WRITE_PROBE, path));
	expect(result.isError, result.text).toBe(false);
	expect(result.text).toContain("WRITE_OK");
}

async function writeDenied(path: string): Promise<void> {
	const result = await bob.bash(nodeProbe(WRITE_PROBE, path));
	expect(result.isError, result.text).toBe(true);
	expect(result.text).toContain("WRITE_ERRNO:EACCES");
}

interface OutsideControl { readonly allowed: boolean; readonly output: string }

async function outsideProbe(args: string[]): Promise<OutsideControl> {
	expect(native.available, native.reason).toBe(true);
	return await new Promise<OutsideControl>((resolve, reject) => {
		const child = spawnOutside(native.path, args);
		let output = "";
		child.stdout!.on("data", (chunk: Buffer) => { output += chunk.toString(); });
		child.stderr!.on("data", (chunk: Buffer) => { output += chunk.toString(); });
		child.once("error", reject);
		child.once("exit", (code) => resolve({ allowed: code === 0, output }));
	});
}

function recordControl(caseName: string, control: OutsideControl, outsideOperation: string): void {
	if (control.allowed) {
		console.info(`sandbox-it control: ${caseName} discriminates Landlock; outside-jail ${outsideOperation} succeeded`);
	} else {
		console.warn(`sandbox-it control: ${caseName} is Yama/host-policy-satisfied and NOT Landlock-discriminating; outside-jail ${outsideOperation} denied (${control.output.trim()})`);
	}
}

async function ptraceDenied(caseName: string, pid: number): Promise<void> {
	expect(native.available, native.reason).toBe(true);
	const control = await outsideProbe(["ptrace", String(pid)]);
	recordControl(caseName, control, "ptrace(PTRACE_ATTACH)");
	const denied = await bob.bash(directCommand([native.path, "ptrace", String(pid)]));
	expect(denied.isError, denied.text).toBe(true);
	expect(denied.text).toMatch(/PROBE_ERRNO:PTRACE_ATTACH:(1|13)/);
}

describeKernel("real tools in real two-user conversations", () => {
	test("bob reads his workspace but cannot read alice's workspace file", async () => {
		await readDenied(join(deployment.aliceWorkspace, "alice-secret.txt"));
	});

	test("bob cannot read users.json", async () => {
		await readDenied(join(deployment.configDir, "users.json"));
	});

	test("bob cannot read auth.json", async () => {
		await readDenied(join(deployment.configDir, "auth.json"));
	});

	test("bob cannot read the sigrun database", async () => {
		await ownReadControl();
		await probeDenied(READ_PROBE, deployment.dbPath, "READ_ERRNO");
	});

	test("bob cannot read the core .env planted for this test", async () => {
		expect(coreEnv?.path).toBe(join(CORE_ROOT, ".env"));
		await readDenied(coreEnv!.path);
	});

	test("bob cannot read sigrun's /proc/<pid>/environ", async () => {
		const own = await bob.bash(nodeProbe(READ_PROBE, "/proc/self/environ"));
		expect(own.isError, own.text).toBe(false);
		expect(own.text).toContain("READ_OK:");
		const control = await outsideProbe(["read-environ", String(deployment.pid)]);
		recordControl("sigrun environ", control, "read /proc/<sigrun>/environ");
		await probeDenied(READ_PROBE, `/proc/${deployment.pid}/environ`, "READ_ERRNO");
	});

	test("bob cannot read a per-user service's /proc/<pid>/environ", async () => {
		expect(native.available, native.reason).toBe(true);
		expect(servicePid).toBeGreaterThan(0);
		const control = await outsideProbe(["read-environ", String(servicePid)]);
		recordControl("service environ", control, "read /proc/<service>/environ");
		await probeDenied(READ_PROBE, `/proc/${servicePid}/environ`, "READ_ERRNO");
	});

	test("bob cannot read another worker's environ or memory", async () => {
		const own = await bob.bash(nodeProbe(READ_PROBE, "/proc/self/environ"));
		expect(own.isError, own.text).toBe(false);
		const envControl = await outsideProbe(["read-environ", aliceWorkerPid]);
		recordControl("other worker environ", envControl, "read /proc/<worker>/environ");
		const memControl = await outsideProbe(["mem-open", aliceWorkerPid]);
		recordControl("other worker mem", memControl, "open /proc/<worker>/mem");
		await probeDenied(READ_PROBE, `/proc/${aliceWorkerPid}/environ`, "READ_ERRNO");
		await probeDenied(MEM_PROBE, `/proc/${aliceWorkerPid}/mem`, "MEM_ERRNO");
	});

	test("reading sigrun's /proc/<pid>/mem fails (the ptrace-access test)", async () => {
		const own = await bob.bash(nodeProbe(MEM_PROBE, "/proc/self/mem"));
		expect(own.isError, own.text).toBe(false);
		expect(own.text).toContain("MEM_OK");
		const control = await outsideProbe(["mem-open", String(deployment.pid)]);
		recordControl("sigrun mem", control, "open /proc/<sigrun>/mem");
		await probeDenied(MEM_PROBE, `/proc/${deployment.pid}/mem`, "MEM_ERRNO");
	});

	test("ptrace attach is denied against sigrun, a service, and the other worker", async () => {
		await ptraceDenied("sigrun ptrace", deployment.pid);
		await ptraceDenied("service ptrace", servicePid);
		await ptraceDenied("other worker ptrace", Number(aliceWorkerPid));
	});

	test("abstract Unix sockets outside the jail cannot be connected", async () => {
		expect(native.available, native.reason).toBe(true);
		const control = await outsideProbe(["socket", abstractName]);
		expect(control.allowed, control.output).toBe(true);
		expect(control.output).toContain("ABSTRACT_CONNECT_OK");
		const denied = await bob.bash(directCommand([native.path, "socket", abstractName]));
		expect(denied.isError, denied.text).toBe(true);
		expect(denied.text).toMatch(/PROBE_ERRNO:CONNECT_ABSTRACT:(1|13)/);
		expect(denied.text).not.toContain("ABSTRACT_CONNECT_OK");
	});

	test("two-user pkill node cannot kill sigrun and /healthz stays up", async () => {
		const denied = await bob.bash("pkill -x node; status=$?; printf 'PKILL_STATUS=%s\\n' \"$status\"");
		expect(denied.isError, denied.text).toBe(true);
		const health = await fetch(`${deployment.baseUrl}/healthz`);
		expect(health.status).toBe(200);
		expect(await health.text()).toContain("sigrun_liveness 1");
		const followup = await bob.read(join(deployment.bobWorkspace, "bob-control.txt"));
		expect(followup.isError, followup.text).toBe(false);
		expect(followup.text).toContain(BOB_CONTROL);
	});

	test("kill -TERM <sigrun pid> fails and /healthz keeps answering", async () => {
		const ownChild = await bob.bash(`
			child=$(sleep 30 & echo $!)
			kill -TERM "$child"
			status=$?
			wait "$child" 2>/dev/null
			printf 'OWN_CHILD_KILL_STATUS=%s\\n' "$status"
		`);
		expect(ownChild.isError, ownChild.text).toBe(false);
		expect(ownChild.text).toContain("OWN_CHILD_KILL_STATUS=0");
		const denied = await bob.bash(nodeProbe(KILL_PROBE, String(deployment.pid)));
		expect(denied.isError, denied.text).toBe(true);
		expect(denied.text).toContain("KILL_ERRNO:EPERM");
		const health = await fetch(`${deployment.baseUrl}/healthz`);
		expect(health.status).toBe(200);
		expect(await health.text()).toContain("sigrun_liveness 1");
	});

	test("/dev/shm is not writable", async () => {
		await writeAllowed(join(bobTmp, "tmp-control.txt"));
		await writeDenied(`/dev/shm/sigrun-boundary-${process.pid}`);
	});

	test("writes outside workspace, home and tmp fail", async () => {
		await writeAllowed(join(deployment.bobWorkspace, "workspace-write.txt"));
		await writeAllowed(join(bobHome, "home-write.txt"));
		await writeAllowed(join(bobTmp, "tmp-write.txt"));
		await writeDenied(join(outsideDir, "must-not-exist.txt"));
		await writeDenied(join(deployment.aliceWorkspace, "bob-must-not-write.txt"));
		await writeDenied(join(deployment.configDir, "bob-must-not-write.txt"));
	});

	test("the same helper uid/gid switch succeeds unjailed and fails inside the jail", async (ctx) => {
		if (privileged.helper === undefined || privileged.native === undefined) {
			ctx.skip(privileged.reason!);
			return;
		}
		// The capability-enabled helper can switch OUTSIDE a jail. Running the
		// same helper/policy inside Bob's worker exercises confinement rather
		// than the ordinary unprivileged-uid restriction.
		const helper = join(deployment.bobWorkspace, "sigrun-sandbox-cap");
		const nativePath = join(deployment.bobWorkspace, "native-probe");
		await copyFile(privileged.helper, helper);
		await copyFile(privileged.native, nativePath);
		const policy = { ...nativePolicy(nativePath), uid: 1, gid: 1, groups: [1] };
		const outside = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
			const child = spawnOutside(privileged.helper!, ["run", "--", privileged.native!, "identity"], {
				SIGRUN_SANDBOX_POLICY: JSON.stringify(policy),
			});
			let output = "";
			child.stdout!.on("data", (chunk: Buffer) => { output += chunk.toString(); });
			child.stderr!.on("data", (chunk: Buffer) => { output += chunk.toString(); });
			child.once("error", reject);
			child.once("exit", (code) => resolve({ code, output }));
		});
		expect(outside.code, outside.output).toBe(0);
		expect(outside.output).toContain("IDENTITY_OK:1:1");
		const result = await bob.bash(helperCommand(helper, policy, [nativePath, "identity"]));
		expect(result.isError, result.text).toBe(true);
		expect(result.text).toContain("sigrun-sandbox:");
		expect(result.text).toMatch(/setgroups|setgid|setuid|uid|identity|capabil|permitted|Operation not permitted/i);
		expect(result.text).not.toContain("IDENTITY_OK:1:1");
	});

	test("osUser successfully switches through a file-capability-enabled helper", async (ctx) => {
		if (privileged.helper === undefined || privileged.native === undefined) {
			ctx.skip(privileged.reason!);
			return;
		}
		const policy = { ...nativePolicy(privileged.native), uid: 1, gid: 1, groups: [1] };
		const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
			const child = spawnOutside(privileged.helper!, ["run", "--", privileged.native!, "identity"], {
				SIGRUN_SANDBOX_POLICY: JSON.stringify(policy),
			});
			let output = "";
			child.stdout!.on("data", (chunk: Buffer) => { output += chunk.toString(); });
			child.stderr!.on("data", (chunk: Buffer) => { output += chunk.toString(); });
			child.once("error", reject);
			child.once("exit", (code) => resolve({ code, output }));
		});
		expect(result.code, result.output).toBe(0);
		expect(result.output).toContain("IDENTITY_OK:1:1");
	});

	test("commands inherit no worker IPC descriptors", async () => {
		const direct = await directWorker(root);
		try {
			let output = "";
			const result = await direct.env.exec(directCommand([native.path, "fds"]), { onOutput: (text) => { output += text; } }, BACKGROUND_CONTEXT);
			expect(result.ok, output).toBe(true);
			expect(output).toContain("INHERITED_FDS:0");
			expect(direct.client.pid).toBeTypeOf("number");
		} finally {
			await direct.pool.stopAll();
		}
	});

	test("worker crash errors the in-flight exec and the next call gets a new pid", async () => {
		const direct = await directWorker(root);
		const pidPath = join(direct.policy.workspace, "worker-pid.txt");
		try {
			const oldPid = await captureWorkerPid(direct.env, pidPath);
			const inFlight = direct.env.exec("sleep 30", undefined, BACKGROUND_CONTEXT);
			// Wait for the worker's observed exec-spawn event, not a race-prone
			// sleep. The real helper launcher owns this lifecycle path.
			const spawnDeadline = Date.now() + 10_000;
			while (direct.client.trackedCommandGroups().length === 0 && Date.now() < spawnDeadline) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			expect(direct.client.trackedCommandGroups().length).toBeGreaterThan(0);
			expect(direct.client.pid).toBe(oldPid);
			terminateOutside(oldPid);
			const crashed = await inFlight;
			expect(crashed.ok).toBe(false);
			if (!crashed.ok) expect(crashed.error.message).toMatch(/sandbox worker.*exited|aborted/i);
			const nextPid = await captureWorkerPid(direct.env, pidPath);
			expect(nextPid).not.toBe(oldPid);
			expect(direct.client.pid).toBe(nextPid);
		} finally {
			await direct.pool.stopAll();
		}
	});

	test("the real helper worker stops after the idle timeout", async () => {
		const direct = await directWorker(root, 1 / 60_000);
		try {
			const pid = await captureWorkerPid(direct.env, join(direct.policy.workspace, "idle-pid.txt"));
			expect(direct.client.pid).toBe(pid);
			const deadline = Date.now() + 5_000;
			while (direct.client.pid !== undefined && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
			expect(direct.client.pid).toBeUndefined();
		} finally {
			await direct.pool.stopAll();
		}
	});

	test("a grant moved under a store root stops the worker with the validation reason", async () => {
		const grantRoot = await mkdtemp(join(tmpdir(), "sigrun-moving-grant-"));
		roots.push(grantRoot);
		await writeFile(join(grantRoot, "control.txt"), "GRANT-MOVED-UNDER-STORE-ROOT\n");
		const first = await bootDeployment({ grant: grantRoot });
		try {
			const grantedBob = await AgentConversation.create(first, "bob");
			const allowed = await grantedBob.read(join(grantRoot, "control.txt"));
			expect(allowed.isError, allowed.text).toBe(false);
			expect(allowed.text).toContain("GRANT-MOVED-UNDER-STORE-ROOT");
			const movedStorage = join(grantRoot, "moved-store", "sigrun.db");
			await mkdir(join(grantRoot, "moved-store"));
			await first.stop();
			const second = await bootDeployment({ root: first.root, storagePath: movedStorage });
			try {
				const deniedBob = await AgentConversation.create(second, "bob");
				const denied = await deniedBob.read(join(second.bobWorkspace, "missing-is-not-the-assertion"));
				expect(denied.isError, denied.text).toBe(true);
				expect(denied.text).toContain("isolation_unavailable");
				expect(denied.text).toContain(grantRoot);
				expect(denied.text).toMatch(/storagePath|store root|contains/i);
			} finally {
				await second.stop();
			}
		} finally {
			await first.stop();
		}
	}, 120_000);
});
