/** Process-level fixtures for the opt-in kernel boundary suite. */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { buildUserPolicy, defaultModuleTrees, type UserPolicy } from "../../src/sandbox/policy.js";
import { resolveWorkerEntry, sandboxLauncher, WorkerPool } from "../../src/sandbox/pool.js";
import type { DirectoryUser } from "../../src/harness/identity/users.js";

const execFileAsync = promisify(execFile);
export const CORE_ROOT = join(import.meta.dirname, "..", "..");
export const HELPER = join(CORE_ROOT, "sandbox", "target", "release", "sigrun-sandbox");
export const BOB_CONTROL = "BOB-WORKSPACE-CONTROL";
export const CORE_ENV_MARKER = "SIGRUN_SANDBOX_IT_CORE_ENV=core-env-must-not-leak\n";

export interface SandboxProbe { readonly available: boolean; readonly abi: number; readonly reason?: string }

export async function probeSandbox(): Promise<SandboxProbe> {
	if (process.platform !== "linux") return { available: false, abi: 0, reason: `requires Linux with Landlock ABI >= 6 (host is ${process.platform})` };
	if (!existsSync(HELPER)) return { available: false, abi: 0, reason: `sandbox helper not built at ${HELPER}; run cargo build --release --manifest-path sandbox/Cargo.toml` };
	try {
		const { stdout } = await execFileAsync(HELPER, ["probe"], { encoding: "utf8", timeout: 10_000 });
		const parsed: unknown = JSON.parse(stdout);
		if (typeof parsed !== "object" || parsed === null || !("abi" in parsed) || typeof parsed.abi !== "number" || !Number.isInteger(parsed.abi)) throw new Error(`invalid probe output: ${stdout}`);
		return parsed.abi >= 6 ? { available: true, abi: parsed.abi } : { available: false, abi: parsed.abi, reason: `requires Landlock ABI >= 6; sigrun-sandbox probe reported ABI ${parsed.abi}` };
	} catch (error) {
		return { available: false, abi: 0, reason: `sigrun-sandbox probe failed: ${String(error)}` };
	}
}

export function shellQuote(value: string): string { return `'${value.replaceAll("'", `'"'"'`)}'`; }
export function nodeProbe(source: string, ...args: string[]): string {
	return [shellQuote(process.execPath), "-e", shellQuote(source), ...args.map(shellQuote)].join(" ");
}

export const READ_PROBE = `
const fs = require("node:fs");
try { const value = fs.readFileSync(process.argv[1]); console.log("READ_OK:" + value.length); }
catch (error) { console.log("READ_ERRNO:" + (error && error.code || "UNKNOWN")); process.exitCode = 23; }
`;
export const WRITE_PROBE = `
const fs = require("node:fs");
try { fs.writeFileSync(process.argv[1], "sandbox-write-control\\n", { flag: "wx" }); console.log("WRITE_OK"); }
catch (error) { console.log("WRITE_ERRNO:" + (error && error.code || "UNKNOWN")); process.exitCode = 24; }
`;
export const MEM_PROBE = `
const fs = require("node:fs");
try {
 const fd = fs.openSync(process.argv[1], "r");
 // Pread a real executable mapping: /proc/self/mem has no mapping at
 // address zero, while opening another process's mem is ptrace-gated.
 const maps = fs.readFileSync("/proc/self/maps", "utf8");
 const address = Number.parseInt(maps.match(/([0-9a-f]+)-[0-9a-f]+ r-xp /)[1], 16);
 fs.readSync(fd, Buffer.alloc(1), 0, 1, address);
 fs.closeSync(fd);
 console.log("MEM_OK");
} catch (error) { console.log("MEM_ERRNO:" + (error && error.code || "UNKNOWN")); process.exitCode = 25; }
`;
export const KILL_PROBE = `
try { process.kill(Number(process.argv[1]), "SIGTERM"); console.log("KILL_OK"); }
catch (error) { console.log("KILL_ERRNO:" + (error && error.code || "UNKNOWN")); process.exitCode = 26; }
`;
export const WORKER_PID_PROBE = `
// pi-durable exec uses a detached direct shell, so this Node process's
// parent is the actual worker, not an intermediate shell.
require("node:fs").writeFileSync(process.argv[1], String(process.ppid));
console.log("WORKER_PID:" + process.ppid);
`;

export interface NativeProbes { readonly path: string; readonly available: boolean; readonly reason?: string }

export function probeCommand(operation: "ptrace" | "abstract-connect" | "abstract-listen" | "read-environ" | "mem-open", target: string | number): string[] {
	return [HELPER, "probe", operation, String(target)];
}

export async function namespaceUnavailableReason(): Promise<string | undefined> {
	try {
		await execFileAsync("unshare", ["--user", "--map-root-user", "--pid", "--fork", "--mount-proc", "/bin/true"], { timeout: 10_000 });
		return undefined;
	} catch (error) {
		return `requires unprivileged user and PID namespaces for the safe pkill-node control: ${String(error)}`;
	}
}

export async function buildNativeProbes(root: string): Promise<NativeProbes> {
	// Probes are implemented by the Rust helper itself; no C/native build.
	return { path: HELPER, available: true };
}

export interface PrivilegedHelper { readonly helper?: string; readonly native?: string; readonly reason?: string }

/** An opt-in privileged-runner fixture; never uses sudo from the test itself. */
export async function privilegedHelper(root: string): Promise<PrivilegedHelper> {
	if (process.env.SIGRUN_SANDBOX_IT_PRIVILEGED !== "1") {
		return { reason: "requires a privileged runner with SIGRUN_SANDBOX_IT_PRIVILEGED=1 and CAP_SETFCAP; uid-switch controls cannot discriminate without helper file capabilities" };
	}
	const helper = join(root, "sigrun-sandbox-cap");
	const target = helper;
	await copyFile(HELPER, helper);
	await chmod(helper, 0o755);
	try {
		await execFileAsync("setcap", ["cap_setuid,cap_setgid+ep", helper], { timeout: 10_000 });
		const { stdout } = await execFileAsync(helper, ["run", "--", target, "probe", "identity"], {
			env: { SIGRUN_SANDBOX_POLICY: JSON.stringify({ ...nativePolicy(target), uid: 1, gid: 1, groups: [1] }) },
			timeout: 10_000,
		});
		if (stdout.trim() !== "IDENTITY_OK:1:1") return { reason: "privileged helper self-check did not switch to uid/gid 1" };
		return { helper, native: target };
	} catch (error) {
		return { reason: `privileged runner could not grant cap_setuid,cap_setgid+ep to the helper: ${String(error)}` };
	}
}

export function nativePolicy(nativePath: string, extraRw: readonly string[] = []): { ro: string[]; rw: string[]; minAbi: number } {
	return {
		ro: ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/etc", "/opt", "/proc", "/sys", nativePath],
		rw: [...extraRw],
		minAbi: 6,
	};
}

export function helperCommand(helper: string, policy: unknown, command: readonly string[]): string {
	return `SIGRUN_SANDBOX_POLICY=${shellQuote(JSON.stringify(policy))} ${[shellQuote(helper), "run", "--", ...command.map(shellQuote)].join(" ")}`;
}

export function directCommand(command: readonly string[]): string {
	return command.map(shellQuote).join(" ");
}

export function spawnUnjailed(command: string, args: readonly string[], env: NodeJS.ProcessEnv = {}): ChildProcess {
	return spawn(command, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
}

export function buildOsUserPolicy(root: string, account: { uid: number; gid: number; groups: number[]; home: string }): UserPolicy {
	const record: DirectoryUser = { user: "mapped", admin: false, source: "cli", osUser: "mapped", createdAt: 1 };
	const managed = {
		roots: { configDir: join(root, "config"), dataDir: join(root, "data"), cacheDir: join(root, "cache"), stateDir: join(root, "state") },
		storagePath: join(root, "data", "sigrun.db"),
		coreRoot: CORE_ROOT,
		userAreas: (user: string) => join(root, "data", "users", user),
	};
	const built = buildUserPolicy(record, {
		managed,
		nodeBinDir: process.execPath,
		moduleTrees: defaultModuleTrees(CORE_ROOT),
		osAccount: account,
	});
	if (!built.ok) throw new Error(`osUser policy failed: ${built.reason}`);
	return built.policy;
}

export interface DirectWorker {
	readonly pool: WorkerPool;
	readonly client: ReturnType<WorkerPool["client"]>;
	readonly env: import("@earendil-works/pi-durable/env").ExecutionEnv;
	readonly policy: UserPolicy;
}

/** Production policy + production helper launcher; no testLauncher fallback. */
export async function directWorker(root: string, idleMinutes = 10): Promise<DirectWorker> {
	const workspace = join(root, "workspace"), home = join(root, "home"), stateDir = join(root, "state");
	await Promise.all([workspace, home, stateDir].map((path) => mkdir(path, { recursive: true })));
	const record: DirectoryUser = { user: "lifecycle", admin: false, source: "cli", workspace, createdAt: 1 };
	const managed = {
		roots: { configDir: join(root, "config"), dataDir: join(root, "data"), cacheDir: join(root, "cache"), stateDir },
		storagePath: join(root, "data", "sigrun.db"),
		coreRoot: CORE_ROOT,
		userAreas: (user: string) => join(root, "data", "users", user),
	};
	const built = buildUserPolicy(record, { managed, nodeBinDir: process.execPath, moduleTrees: defaultModuleTrees(CORE_ROOT) });
	if (!built.ok) throw new Error(`direct worker policy failed: ${built.reason}`);
	const pool = new WorkerPool({
		launcher: sandboxLauncher(HELPER, resolveWorkerEntry(CORE_ROOT)),
		idleMinutes: () => idleMinutes,
		log: () => undefined,
		workerEntry: resolveWorkerEntry(CORE_ROOT),
	});
	const client = pool.client(built.policy);
	const { SandboxedExecutionEnv } = await import("../../src/sandbox/sandboxed-env.js");
	const env = new SandboxedExecutionEnv(client, built.policy.workspace);
	await env.exists(".", BACKGROUND_CONTEXT);
	return { pool, client, env, policy: built.policy };
}

export async function captureWorkerPid(env: DirectWorker["env"], path: string): Promise<number> {
	let output = "";
	const result = await env.exec(nodeProbe(WORKER_PID_PROBE, path), { onOutput: (text) => { output += text; } }, BACKGROUND_CONTEXT);
	expect(result.ok, output).toBe(true);
	const pid = Number((await readFile(path, "utf8")).trim());
	expect(Number.isInteger(pid) && pid > 0, output).toBe(true);
	return pid;
}

export function terminateOutside(pid: number): void {
	process.kill(pid, "SIGKILL");
}

export function workerPidFromFile(path: string): Promise<number> {
	return readFile(path, "utf8").then((value) => Number(value.trim()));
}

export interface ToolResult { readonly name: string; readonly isError: boolean; readonly text: string }
interface ConversationView { entries: { kind: string; model?: { role: string; toolName?: string; isError?: boolean; content?: { type: string; text?: string }[] }[] }[] }
function toolResults(view: ConversationView): ToolResult[] {
	return view.entries.filter((entry) => entry.kind === "pi.tool-result").flatMap((entry) =>
		(entry.model ?? []).filter((message) => message.role === "toolResult").map((message) => ({
			name: message.toolName ?? "", isError: message.isError === true,
			text: (message.content ?? []).filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n"),
		})),
	);
}

export interface Deployment {
	readonly root: string;
	readonly configDir: string;
	readonly dataDir: string;
	readonly stateDir: string;
	readonly cacheDir: string;
	readonly dbPath: string;
	readonly aliceWorkspace: string;
	readonly bobWorkspace: string;
	readonly baseUrl: string;
	readonly namespacePid: number;
	readonly aliceToken: string;
	readonly bobToken: string;
	readonly pid: number;
	readonly logs: () => string;
	stop(): Promise<void>;
}

let deploymentSequence = 0;

async function reservePort(): Promise<number> {
	const listener = createServer();
	await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
	const address = listener.address();
	if (address === null || typeof address !== "object") throw new Error("could not reserve a loopback port");
	const port = address.port;
	await new Promise<void>((resolve, reject) => listener.close((error) => error === undefined ? resolve() : reject(error)));
	return port;
}

export async function bootDeployment(options?: { root?: string; storagePath?: string; grant?: string }): Promise<Deployment> {
	const root = options?.root ?? await mkdtemp(join(tmpdir(), "sigrun-kernel-boundary-"));
	const configDir = join(root, "config"), dataDir = join(root, "data"), stateDir = join(root, "state"), cacheDir = join(root, "cache");
	const aliceWorkspace = join(root, "alice-workspace"), bobWorkspace = join(root, "bob-workspace");
	await Promise.all([configDir, dataDir, stateDir, cacheDir, aliceWorkspace, bobWorkspace].map((path) => mkdir(path, { recursive: true })));
	const usersPath = join(configDir, "users.json");
	const tokenFixturePath = join(root, "test-tokens.json");
	let tokens: { aliceToken: string; bobToken: string };
	if (!existsSync(usersPath)) {
		tokens = {
			aliceToken: `sgr_alice_${randomBytes(32).toString("base64url")}`,
			bobToken: `sgr_bob_${randomBytes(32).toString("base64url")}`,
		};
		await writeFile(usersPath, `${JSON.stringify([
			{ user: "alice", admin: true, source: "cli", workspace: aliceWorkspace, createdAt: 1 },
			{ user: "bob", admin: false, source: "cli", workspace: bobWorkspace, createdAt: 2, ...(options?.grant === undefined ? {} : { grants: [{ path: options.grant, access: "rw" }] }) },
		], null, 2)}\n`, { mode: 0o600 });
		await writeFile(tokenFixturePath, `${JSON.stringify(tokens)}\n`, { mode: 0o600 });
		const digest = (token: string): string => createHash("sha256").update(token).digest("hex");
		await writeFile(join(configDir, "api-tokens.json"), `${JSON.stringify([
			{ id: "boundary-alice", name: "boundary", user: "alice", sha256: digest(tokens.aliceToken), createdAt: 1 },
			{ id: "boundary-bob", name: "boundary", user: "bob", sha256: digest(tokens.bobToken), createdAt: 2 },
		], null, 2)}\n`, { mode: 0o600 });
	} else {
		tokens = JSON.parse(await readFile(tokenFixturePath, "utf8")) as { aliceToken: string; bobToken: string };
	}
	const settingsPath = join(configDir, "settings.json");
	if (!existsSync(settingsPath)) await writeFile(settingsPath, '{"namingModel":false}\n');
	const port = await reservePort();
	const pidFile = join(root, `sigrun-server-${deploymentSequence++}.pid`);
	const child = spawn("unshare", ["--user", "--map-root-user", "--pid", "--fork", "--mount-proc", process.execPath, "--import", "tsx", join(CORE_ROOT, "test", "sandbox-it", "server-entry.ts")], {
		cwd: CORE_ROOT,
		env: {
			...process.env,
			SIGRUN_CONFIG_DIR: configDir, SIGRUN_DATA_DIR: dataDir, SIGRUN_STATE_DIR: stateDir, SIGRUN_CACHE_DIR: cacheDir,
			SIGRUN_DEFAULT_MODEL: "boundary/m", SIGRUN_STORAGE_PATH: options?.storagePath ?? join(dataDir, "sigrun.db"),
			SIGRUN_WORKSPACE_PATH: aliceWorkspace, SIGRUN_AUTH: "token", SIGRUN_ISOLATION: "always",
			SIGRUN_SANDBOX_HELPER: HELPER, SIGRUN_EXTENSIONS: join(import.meta.dirname, "provider-entry.mjs"),
			SIGRUN_PROVIDER_REFRESH_MINUTES: "0", SIGRUN_WEBUI: "false", SIGRUN_PORT: String(port), SIGRUN_BOUNDARY_IT: "1",
			SIGRUN_BOUNDARY_PID_FILE: pidFile,
			SIGRUN_BOUNDARY_SERVER_IDENTITY: "sigrun-real-server",
		}, stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => { output += chunk; }); child.stderr.on("data", (chunk: string) => {
		output += chunk;
	});
	const logs = () => output, baseUrl = `http://127.0.0.1:${port}`;
	try {
		await waitForHealth(baseUrl, child, logs);
		const serverPid = Number((await readFile(pidFile, "utf8")).trim());
		expect(Number.isInteger(serverPid) && serverPid > 0, `invalid server pid in ${pidFile}`).toBe(true);
		const stop = async (): Promise<void> => {
			if (child.exitCode === null && child.signalCode === null) {
				child.kill("SIGTERM");
				const deadline = Date.now() + 20_000;
				while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
			}
			if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); throw new Error(`sigrun did not stop\n${logs()}`); }
		};
		// The child is PID 1 in its disposable PID namespace; the host-side
		// pid is used by /proc and ptrace cases.
		return { root, configDir, dataDir, stateDir, cacheDir, dbPath: options?.storagePath ?? join(dataDir, "sigrun.db"), aliceWorkspace, bobWorkspace, baseUrl, namespacePid: 1, aliceToken: tokens.aliceToken, bobToken: tokens.bobToken, pid: serverPid, logs, stop };
	} catch (error) {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		throw error;
	}
}

async function waitForHealth(baseUrl: string, child: ChildProcess, logs: () => string): Promise<void> {
	const deadline = Date.now() + 60_000;
	let last = "not attempted";
	while (Date.now() < deadline) {
		if (child.exitCode !== null || child.signalCode !== null) {
			throw new Error(`sigrun exited during boot (${child.exitCode ?? child.signalCode})\n${logs()}`);
		}
		try {
			const response = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(1_000) });
			last = `${response.status} ${await response.text()}`;
			if (response.status === 200) return;
		} catch (error) { last = String(error); }
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`sigrun did not become healthy: ${last}\n${logs()}`);
}

export class AgentConversation {
	private constructor(readonly deployment: Deployment, readonly id: number, readonly token: string) {}
	static async create(deployment: Deployment, user: "alice" | "bob"): Promise<AgentConversation> {
		const token = user === "alice" ? deployment.aliceToken : deployment.bobToken;
		const response = await fetch(`${deployment.baseUrl}/v1/conversations`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
		const body = await response.text(); expect(response.status, body).toBe(201);
		return new AgentConversation(deployment, (JSON.parse(body) as { id: number }).id, token);
	}
	async run(calls: { name: string; args: Record<string, unknown> }[]): Promise<ToolResult[]> {
		const script = { calls: calls.map((call, index) => ({ ...call, id: `boundary-${Date.now()}-${index}` })) };
		const submitted = await fetch(`${this.deployment.baseUrl}/v1/conversations/${this.id}/submissions?waitMs=60000`, {
			method: "POST", headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
			body: JSON.stringify({ input: [{ type: "text", text: JSON.stringify(script) }] }),
		});
		const submittedBody = await submitted.text(); expect(submitted.status, submittedBody).toBe(202);
		expect((JSON.parse(submittedBody) as any).submission?.status, submittedBody).toBe("done");
		const view = await fetch(`${this.deployment.baseUrl}/v1/conversations/${this.id}`, { headers: { authorization: `Bearer ${this.token}` } });
		const viewBody = await view.text(); expect(view.status, viewBody).toBe(200);
		const results = toolResults(JSON.parse(viewBody) as ConversationView);
		expect(results.map((result) => result.name)).toEqual(calls.map((call) => call.name));
		return results;
	}
	async bash(command: string): Promise<ToolResult> { const [result] = await this.run([{ name: "bash", args: { command, timeout: 30 } }]); expect(result).toBeDefined(); return result!; }
	async read(path: string): Promise<ToolResult> { const [result] = await this.run([{ name: "read", args: { path } }]); expect(result).toBeDefined(); return result!; }
}

export async function assertFileExists(path: string): Promise<void> {
	const info = await stat(path);
	expect(info.isFile(), path).toBe(true);
	// procfs reports size 0 even for readable environ/maps. Read those
	// targets outside the jail as the fixture control instead of stat size.
	if (path.startsWith("/proc/")) {
		if (path.endsWith("/mem")) {
			// Memory has no stream at offset zero. A successful host open is
			// the control; the self-mem probe reads a real mapping instead.
			const { open } = await import("node:fs/promises");
			let handle;
			try {
				handle = await open(path, "r");
			} finally {
				await handle?.close();
			}
			return;
		}
		const contents = await readFile(path);
		expect(contents.length, `proc fixture is empty: ${path}`).toBeGreaterThan(0);
		return;
	}
	expect(info.size, `fixture is empty: ${path}`).toBeGreaterThan(0);
}
export async function plantCoreEnv(): Promise<{ path: string; restore(): Promise<void> }> {
	const path = join(CORE_ROOT, ".env");
	let previous: Buffer | undefined;
	try { previous = await readFile(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	await writeFile(path, CORE_ENV_MARKER, { mode: 0o600 });
	return { path, restore: async () => { if (previous === undefined) await import("node:fs/promises").then(({ rm }) => rm(path, { force: true })); else await writeFile(path, previous, { mode: 0o600 }); } };
}
export async function installWorkspaceHelper(workspace: string): Promise<string> {
	const path = join(workspace, "sigrun-sandbox"); await copyFile(HELPER, path); await chmod(path, 0o755); return path;
}
