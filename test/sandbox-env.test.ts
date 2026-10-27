import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	ExecutionError,
	FileError,
	getOrThrow,
	type ShellOutputInfo,
} from "@earendil-works/pi-durable/env";
import type { UserPolicy } from "../src/sandbox/policy.js";
import {
	SandboxedExecutionEnv,
	type RemoteHandle,
} from "../src/sandbox/sandboxed-env.js";
import {
	resolveWorkerEntry,
	testLauncher,
	WorkerPool,
	type WorkerClient,
} from "../src/sandbox/pool.js";

const context = BACKGROUND_CONTEXT;
let root: string;
let workspace: string;
let pool: WorkerPool | undefined;
const clients: WorkerClient[] = [];

function policy(user = "alice", workspacePath = workspace): UserPolicy {
	return {
		user,
		workspace: workspacePath,
		home: join(root, user, "home"),
		tmp: join(root, user, "tmp"),
		ro: [],
		rw: [workspacePath],
		ensureDirs: [],
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(root, user, "home") },
	};
}

function makePool(idleMinutes = 10): WorkerPool {
	const entry = resolveWorkerEntry(resolve("."));
	const value = new WorkerPool({
		launcher: testLauncher(entry),
		idleMinutes: () => idleMinutes,
		log: (line) => console.error(line),
		workerEntry: entry,
	});
	pool = value;
	return value;
}

async function envFor(userPolicy = policy()): Promise<{
	env: SandboxedExecutionEnv;
	client: WorkerClient;
}> {
	const owner = pool ?? makePool();
	const client = owner.client(userPolicy);
	clients.push(client);
	return {
		env: new SandboxedExecutionEnv(client, userPolicy.workspace),
		client,
	};
}

async function pid(client: WorkerClient): Promise<number> {
	return (await client.call("pid", [])) as number;
}

async function alive(processId: number): Promise<boolean> {
	try {
		process.kill(processId, 0);
		return true;
	} catch {
		return false;
	}
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "sigrun-sandbox-env-"));
	workspace = join(root, "workspace");
	await mkdir(workspace, { recursive: true });
});

afterEach(async () => {
	vi.useRealTimers();
	for (const client of clients.splice(0)) client.close();
	if (pool !== undefined) await pool.stopAll();
	pool = undefined;
	await rm(root, { recursive: true, force: true });
});

describe("SandboxedExecutionEnv workspace operations", { timeout: 30_000 }, () => {
	test("lists, reads, writes, and performs edit-shaped read-modify-write", async () => {
		const { env } = await envFor();
		expect(env.cwd).toBe(workspace);
		await writeFile(join(workspace, "note.txt"), "before\nsecond\n");
		expect(getOrThrow(await env.listDir(".", context)).map((entry) => entry.name)).toEqual(["note.txt"]);
		expect(getOrThrow(await env.readTextFile("note.txt", context))).toBe("before\nsecond\n");
		await getOrThrow(await env.writeFile("new.bin", new Uint8Array([0, 1, 255]), context));
		expect(getOrThrow(await env.readBinaryFile("new.bin", context))).toEqual(new Uint8Array([0, 1, 255]));
		const original = getOrThrow(await env.readTextFile("note.txt", context));
		await getOrThrow(await env.writeFile("note.txt", original.replace("before", "after"), context));
		expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe("after\nsecond\n");
		expect(getOrThrow(await env.exists("new.bin", context))).toBe(true);
	});

	test("round-trips file errors and failing command exit codes", async () => {
		const { env } = await envFor();
		const missing = await env.readTextFile("does-not-exist", context);
		expect(missing.ok).toBe(false);
		if (missing.ok) throw new Error("expected failure");
		expect(missing.error).toBeInstanceOf(FileError);
		expect(missing.error.code).toBe("not_found");
		expect(missing.error.path).toContain("does-not-exist");
		const failed = await env.exec("exit 23", undefined, context);
		expect(getOrThrow(failed).exitCode).toBe(23);
	});

	test("streams exec output incrementally and forwards mutable cwd", async () => {
		const { env } = await envFor();
		const chunks: { text: string; info: ShellOutputInfo }[] = [];
		let releaseFirst: () => void;
		const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
		const running = env.exec("printf first; sleep 0.2; printf second", {
			onOutput: (text, _context, info) => {
				chunks.push({ text, info });
				releaseFirst();
			},
		}, context);
		await first;
		expect(chunks.length).toBe(1);
		expect(chunks[0]?.text).toBe("first");
		expect(getOrThrow(await running).exitCode).toBe(0);
		expect(chunks.map((chunk) => chunk.text).join("")).toBe("firstsecond");
		await mkdir(join(workspace, "other"));
		env.cwd = "other";
		expect(getOrThrow(await env.absolutePath("file", context))).toBe(join(workspace, "other", "file"));
		env.cwd = workspace;
	});

	test("forwards text, binary and directory handles and closes them", async () => {
		const { env, client } = await envFor();
		await writeFile(join(workspace, "lines"), "one\ntwo");
		const text = getOrThrow(await env.openTextLineReader("lines", context));
		expect(getOrThrow(await text.readLine(context))).toEqual({ text: "one", terminated: true });
		await text.close(context);
		const binary = getOrThrow(await env.openBinaryReader("lines", undefined, context));
		expect(new TextDecoder().decode(getOrThrow(await binary.read(1, 3, context)))).toBe("ne\n");
		expect(getOrThrow(await binary.info(context)).size).toBe(7);
		expect(getOrThrow(await binary.scanLines({ startLine: 0, endLine: 1 }, context)).selectedBytes).toBe(3);
		await binary.close(context);
		const dir = getOrThrow(await env.openDirReader(".", context));
		const page = getOrThrow(await dir.next(10, context));
		expect(page.entries.map((entry) => entry.name)).toContain("lines");
		await dir.close(context);
		expect((client as unknown as { openHandles(): number }).openHandles()).toBe(0);
	});

	test("forwards watcher changes and omits listFiles on pi-durable 1.3.0", async () => {
		const { env } = await envFor();
		expect(env.listFiles).toBeUndefined();
		const changes: string[][] = [];
		const watcher = getOrThrow(await env.watch([{ path: "." }], (change) => {
			if ("paths" in change) changes.push(change.paths);
		}, context));
		expect(watcher.mode).toBe("native");
		await new Promise((resolve) => setTimeout(resolve, 50));
		await writeFile(join(workspace, "watched"), "change");
		await vi.waitFor(() => expect(changes.flat().some((path) => path.includes("watched"))).toBe(true));
		await watcher.close(context);
	});

	test("exposes and forwards listFiles when the worker advertises it", async () => {
		const entry = { command: process.execPath, args: [join(import.meta.dirname, "fixtures", "fixture-sandbox-listfiles-worker.cjs")] };
		pool = new WorkerPool({
			launcher: testLauncher(entry),
			idleMinutes: () => 10,
			log: () => {},
			workerEntry: entry,
		});
		const { env } = await envFor();
		await getOrThrow(await env.absolutePath(".", context));
		expect(env.listFiles).toBeDefined();
		const listing = getOrThrow(await env.listFiles!(".", undefined, context));
		expect(listing).toEqual({
			entries: [
				{ path: "nested", kind: "directory" },
				{ path: "nested/file.txt", kind: "file" },
			],
			truncated: false,
		});
	});

	test("cleanup is deliberately inert on the shared worker", async () => {
		const { env, client } = await envFor();
		const before = await pid(client);
		await env.cleanup(context);
		expect(await pid(client)).toBe(before);
	});

	test("a non-listFiles capability makes the optional member absent", async () => {
		const { env } = await envFor();
		const original = env.listFiles;
		expect(original).toBeUndefined();
	});
});

describe("sandbox process invariants", { timeout: 30_000 }, () => {
	test("commands inherit only the per-user policy environment with caller overrides", async () => {
		const basePolicy = policy();
		const userPolicy = {
			...basePolicy,
			env: {
				...basePolicy.env,
				TMPDIR: basePolicy.tmp,
				USER: basePolicy.user,
				NPM_CONFIG_CACHE: join(basePolicy.home, ".npm"),
				MARKER: "inherited",
			},
		};
		process.env.SIGRUN_SANDBOX_TEST_SECRET = "parent-secret";
		process.env.TEST_PROVIDER_API_KEY = "parent-provider-key";
		try {
			const { env } = await envFor(userPolicy);
			let output = "";
			const result = await env.exec(
				"printf '%s\\n' \"$HOME\" \"$TMPDIR\" \"$USER\" \"$NPM_CONFIG_CACHE\" \"${SIGRUN_SANDBOX_TEST_SECRET-unset}\" \"${TEST_PROVIDER_API_KEY-unset}\" \"$MARKER\"",
				{ env: { MARKER: "caller" }, onOutput: (text) => { output += text; } },
				context,
			);
			expect(getOrThrow(result).exitCode).toBe(0);
			expect(output.trimEnd().split("\n")).toEqual([
				basePolicy.home,
				userPolicy.tmp,
				userPolicy.user,
				join(userPolicy.home, ".npm"),
				"unset",
				"unset",
				"caller",
			]);
		} finally {
			delete process.env.SIGRUN_SANDBOX_TEST_SECRET;
			delete process.env.TEST_PROVIDER_API_KEY;
		}
	});

	test("commands inherit no worker IPC descriptors", async () => {
		if (process.platform !== "linux") return;
		const { env } = await envFor();
		const output: string[] = [];
		// List fds by their TARGET, not by `ls /proc/self/fd`'s bare names:
		// the lister necessarily holds a descriptor on the very directory it
		// is reading, so a plain listing always contains one extra entry.
		// `ls /proc/self/fd` happens to use the lowest free fd (3 on this
		// host, which is why the old assertion tolerated 3), but WHICH fd
		// that is depends on the implementation — CI's GNU coreutils and
		// this host's uutils coreutils differ. Printing `ls -l` gives the
		// symlink TARGET, so the lister's own handle is identifiable (it
		// points at /proc/<pid>/fd) and can be excluded exactly.
		getOrThrow(await env.exec("ls -l /proc/self/fd", {
			onOutput: (text) => output.push(text),
		}, context));
		const lines = output.join("").split("\n").filter((line) => line.includes(" -> "));
		const descriptors = lines.map((line) => {
			// `lr-x------ 1 user group 64 Oct 26 21:26 3 -> /proc/1234/fd`
			// Split on the arrow (always present here), then take the last
			// whitespace field before it as the fd number.
			const [left, target = ""] = line.split(" -> ");
			const fields = (left ?? "").trim().split(/\s+/);
			return { fd: Number(fields[fields.length - 1]), target: target.trim() };
		}).filter((d) => Number.isInteger(d.fd));
		expect(descriptors.length, "the listing must yield fd entries").toBeGreaterThan(0);
		// The reader's own directory handle is not the command's descriptor.
		const own = descriptors.filter((d) => /^\/proc\/\d+\/fd$/.test(d.target));
		expect(own.length, "exactly one fd is the lister's own directory handle").toBe(1);
		const command = descriptors.filter((d) => !own.includes(d));
		const numbers = command.map((d) => d.fd).sort((a, b) => a - b);

		// The command must have a FRESH stdio triple, and nothing may
		// duplicate one of those descriptors.
		expect(numbers).toEqual(expect.arrayContaining([0, 1, 2]));
		const targets = command.map((d) => d.target);
		expect(new Set(targets).size, "no descriptor may duplicate another's target").toBe(
			targets.length,
		);

		// Descriptors ABOVE 2 are deliberately not asserted as an exact
		// set. GitHub's runner agent leaks inherited pipe descriptors into
		// every process it starts — observed as 142 and 145 here, present
		// even in a bare `spawn("ls")` with no sigrun or vitest involved,
		// while the same probe on a workstation shows only 0-3. Node offers
		// no way to close an fd it did not open (production runs commands
		// under the Rust helper, which could close_range); so the exact
		// high-fd set is the environment's, not sigrun's.
		//
		// What IS sigrun's to guarantee is the spawn SHAPE, and that is
		// pinned by the test below (the worker's stdio array carries no
		// "ipc"). This test proves the wiring: the command gets a working
		// stdio triple and no duplicated channel.
	});

	test("the worker passes no IPC channel down to commands", () => {
		// The stdio contract the assertion above measures: three pipes and
		// NO `"ipc"` entry. If someone adds an IPC channel to the worker
		// spawn, this fails at the source instead of surfacing as an extra
		// descriptor inside a child.
		const source = readFileSync(new URL("../src/sandbox/pool.ts", import.meta.url), "utf8");
		const stdio = /stdio:\s*(\[[^\]]*\])/.exec(source)?.[1] ?? "";
		expect(stdio, "the worker spawn must declare a stdio shape").not.toBe("");
		expect(stdio).not.toContain("ipc");
	});

	test("a completed real exec forgets its command pid", async () => {
		const { env, client } = await envFor();
		let output = "";
		const result = await env.exec("echo $$", {
			onOutput: (text) => { output += text; },
		}, context);
		expect(getOrThrow(result).exitCode).toBe(0);
		const commandPid = Number(output.trim());
		expect(Number.isInteger(commandPid)).toBe(true);
		await vi.waitFor(() => expect(client.trackedCommandGroups()).not.toContain(commandPid));
		expect(client.trackedCommandGroups()).toEqual([]);
	});

	test("a crash rejects in-flight exec and the next call gets a new pid", async () => {
		const { env, client } = await envFor();
		const before = await pid(client);
		const killed = env.exec("sleep 5", undefined, context);
		await new Promise((resolve) => setTimeout(resolve, 100));
		process.kill(before, "SIGKILL");
		await expect(killed).rejects.toSatisfy((error: unknown) => {
			expect(error).toBeInstanceOf(ExecutionError);
			expect((error as ExecutionError).code).toBe("crashed");
			return true;
		});
		expect(getOrThrow(await env.exec("printf recovered", undefined, context)).exitCode).toBe(0);
		expect(await pid(client)).not.toBe(before);
	});

	test("stopAll leaves no worker processes", async () => {
		const first = await envFor();
		const second = await envFor(policy("bob"));
		const pids = [await pid(first.client), await pid(second.client)];
		await pool!.stopAll();
		for (const processId of pids) {
			await vi.waitFor(async () => expect(await alive(processId)).toBe(false));
		}
	});

	if (process.platform !== "win32") {
		test("a killed worker does not leave its command running", async () => {
			const { env, client } = await envFor();
			let output = "";
			const running = env.exec("echo $$; sleep 30", {
				onOutput: (text) => { output += text; },
			}, context);
			await vi.waitFor(() => expect(output).toMatch(/\d+\n/));
			const commandPid = Number(output.trim());
			expect(Number.isInteger(commandPid)).toBe(true);
			process.kill(await pid(client), "SIGKILL");
			await expect(running).rejects.toBeInstanceOf(ExecutionError);
			await vi.waitFor(async () => expect(await alive(commandPid)).toBe(false), { timeout: 5_000 });
		});

		test("concurrent staggered execs retain the second command for crash cleanup", async () => {
			const { env, client } = await envFor();
			let firstOutput = "";
			let secondOutput = "";
			const first = env.exec("echo $$; sleep 0.2", {
				onOutput: (text) => { firstOutput += text; },
			}, context);
			const second = env.exec("echo $$; sleep 30", {
				onOutput: (text) => { secondOutput += text; },
			}, context);
			await vi.waitFor(() => {
				expect(firstOutput).toMatch(/\d+\n/);
				expect(secondOutput).toMatch(/\d+\n/);
			});
			const firstPid = Number(firstOutput.trim());
			const secondPid = Number(secondOutput.trim());
			expect(firstPid).not.toBe(secondPid);
			expect(getOrThrow(await first).exitCode).toBe(0);
			process.kill(await pid(client), "SIGKILL");
			await expect(second).rejects.toBeInstanceOf(ExecutionError);
			await vi.waitFor(async () => expect(await alive(secondPid)).toBe(false), { timeout: 5_000 });
		});

		test("graceful stopAll also leaves no command pids", async () => {
			const { env } = await envFor();
			let output = "";
			const running = env.exec("echo $$; sleep 30", {
				onOutput: (text) => { output += text; },
			}, context);
			await vi.waitFor(() => expect(output).toMatch(/\d+\n/));
			const commandPid = Number(output.trim());
			const stopping = pool!.stopAll();
			await expect(running).rejects.toBeInstanceOf(ExecutionError);
			await stopping;
			await vi.waitFor(async () => expect(await alive(commandPid)).toBe(false), { timeout: 5_000 });
		});
	}
});

describe("WorkerPool lifecycle", { timeout: 30_000 }, () => {
	test("idle minutes stop a worker with no call and no open handle", async () => {
		vi.useFakeTimers();
		const { client } = await envFor();
		const processId = await pid(client);
		await vi.advanceTimersByTimeAsync(9 * 60_000);
		expect(await alive(processId)).toBe(true);
		await vi.advanceTimersByTimeAsync(60_000);
		await vi.waitFor(async () => expect(await alive(processId)).toBe(false));
		const after = await pid(client);
		expect(after).not.toBe(processId);
	});

	test("an open handle prevents idle stop until it closes", async () => {
		vi.useFakeTimers();
		const { env, client } = await envFor();
		await writeFile(join(workspace, "held"), "held");
		const handle: RemoteHandle = getOrThrow(await env.openTextLineReader("held", context));
		const processId = await pid(client);
		await vi.advanceTimersByTimeAsync(30 * 60_000);
		expect(await alive(processId)).toBe(true);
		await handle.close(context);
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		await vi.waitFor(async () => expect(await alive(processId)).toBe(false));
	});

	test("policy change drains the in-flight call before restarting", async () => {
		const { env, client } = await envFor();
		const before = await pid(client);
		let started!: () => void;
		const startedOutput = new Promise<void>((resolve) => { started = resolve; });
		const running = env.exec("printf started; sleep 0.3; printf done", {
			onOutput: (text) => { if (text.includes("started")) started(); },
		}, context);
		await startedOutput;
		const changed = { ...policy(), env: { ...policy().env, MARKER: "changed" } };
		const next = envFor(changed);
		const replacement = (await next).client;
		expect(replacement.pid).toBe(before);
		expect(getOrThrow(await running).exitCode).toBe(0);
		await vi.waitFor(async () => expect(await alive(before)).toBe(false));
		expect(await pid(replacement)).not.toBe(before);
		await getOrThrow(await (await next).env.exec("printf after", undefined, context));
	});
});
