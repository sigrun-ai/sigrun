/** Process-level fixtures for the opt-in kernel boundary suite. */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect } from "vitest";

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
require("node:fs").writeFileSync(process.argv[1], String(process.ppid));
console.log("WORKER_PID:" + process.ppid);
`;

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
	readonly aliceToken: string;
	readonly bobToken: string;
	readonly pid: number;
	readonly logs: () => string;
	stop(): Promise<void>;
}

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
	const child = spawn(process.execPath, ["--import", "tsx", join(CORE_ROOT, "test", "sandbox-it", "server-entry.ts")], {
		cwd: CORE_ROOT,
		env: {
			...process.env,
			SIGRUN_CONFIG_DIR: configDir, SIGRUN_DATA_DIR: dataDir, SIGRUN_STATE_DIR: stateDir, SIGRUN_CACHE_DIR: cacheDir,
			SIGRUN_DEFAULT_MODEL: "boundary/m", SIGRUN_STORAGE_PATH: options?.storagePath ?? join(dataDir, "sigrun.db"),
			SIGRUN_WORKSPACE_PATH: aliceWorkspace, SIGRUN_AUTH: "token", SIGRUN_ISOLATION: "always",
			SIGRUN_SANDBOX_HELPER: HELPER, SIGRUN_EXTENSIONS: join(import.meta.dirname, "provider-entry.mjs"),
			SIGRUN_PROVIDER_REFRESH_MINUTES: "0", SIGRUN_WEBUI: "false", SIGRUN_PORT: String(port), SIGRUN_BOUNDARY_IT: "1",
		}, stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => { output += chunk; }); child.stderr.on("data", (chunk: string) => { output += chunk; });
	const logs = () => output, baseUrl = `http://127.0.0.1:${port}`;
	try {
		await waitForHealth(baseUrl, child, logs);
		const stop = async (): Promise<void> => {
			if (child.exitCode === null && child.signalCode === null) {
				child.kill("SIGTERM");
				const deadline = Date.now() + 20_000;
				while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
			}
			if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); throw new Error(`sigrun did not stop\n${logs()}`); }
		};
		return { root, configDir, dataDir, stateDir, cacheDir, dbPath: options?.storagePath ?? join(dataDir, "sigrun.db"), aliceWorkspace, bobWorkspace, baseUrl, aliceToken: tokens.aliceToken, bobToken: tokens.bobToken, pid: child.pid!, logs, stop };
	} catch (error) {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		throw error;
	}
}

async function waitForHealth(baseUrl: string, child: ChildProcess, logs: () => string): Promise<void> {
	const deadline = Date.now() + 60_000;
	let last = "not attempted";
	while (Date.now() < deadline) {
		if (child.exitCode !== null || child.signalCode !== null) throw new Error(`sigrun exited during boot (${child.exitCode ?? child.signalCode})\n${logs()}`);
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
