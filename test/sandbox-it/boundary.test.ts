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

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
	AgentConversation,
	assertFileExists,
	BOB_CONTROL,
	bootDeployment,
	CORE_ROOT,
	installWorkspaceHelper,
	KILL_PROBE,
	MEM_PROBE,
	nodeProbe,
	plantCoreEnv,
	probeSandbox,
	READ_PROBE,
	shellQuote,
	WORKER_PID_PROBE,
	WRITE_PROBE,
	type Deployment,
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
const roots: string[] = [];

beforeAll(async () => {
	if (!enabled) return;
	root = await mkdtemp(join(tmpdir(), "sigrun-kernel-boundary-"));
	roots.push(root);
	deployment = await bootDeployment({ root });
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
}, 120_000);

afterAll(async () => {
	if (!enabled) return;
	await coreEnv?.restore();
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
		await probeDenied(READ_PROBE, `/proc/${deployment.pid}/environ`, "READ_ERRNO");
	});

	test("bob cannot read another worker's environ or memory", async () => {
		const own = await bob.bash(nodeProbe(READ_PROBE, "/proc/self/environ"));
		expect(own.isError, own.text).toBe(false);
		await probeDenied(READ_PROBE, `/proc/${aliceWorkerPid}/environ`, "READ_ERRNO");
		await probeDenied(MEM_PROBE, `/proc/${aliceWorkerPid}/mem`, "MEM_ERRNO");
	});

	test("reading sigrun's /proc/<pid>/mem fails (the ptrace-access test)", async () => {
		const own = await bob.bash(nodeProbe(MEM_PROBE, "/proc/self/mem"));
		expect(own.isError, own.text).toBe(false);
		expect(own.text).toContain("MEM_OK");
		await probeDenied(MEM_PROBE, `/proc/${deployment.pid}/mem`, "MEM_ERRNO");
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

	test("running the helper inside the jail with uid:1 cannot change uid", async () => {
		const helper = await installWorkspaceHelper(deployment.bobWorkspace);
		const policy = JSON.stringify({
			ro: ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/opt", "/proc", "/sys"],
			rw: [], minAbi: 6, uid: 1, gid: 1, groups: [1],
		});
		const result = await bob.bash(`SIGRUN_SANDBOX_POLICY=${shellQuote(policy)} ${shellQuote(helper)} run -- /usr/bin/id -u`);
		expect(result.isError, result.text).toBe(true);
		expect(result.text).toContain("sigrun-sandbox:");
		expect(result.text).toMatch(/setgroups|setgid|setuid|uid|identity|capabil|permitted|Operation not permitted/i);
		expect(result.text.trim()).not.toMatch(/^1$/m);
		const control = await bob.bash("/usr/bin/id -u");
		expect(control.isError, control.text).toBe(false);
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
