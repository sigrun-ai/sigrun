import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FastifyInstance } from "fastify";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import { loadConfig, type SigrunConfig } from "../src/config.js";
import type { HandlerContext, ServiceHandle, UserService } from "../src/extension.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import { UserServices } from "../src/harness/user-services.js";
import type { UserPolicy } from "../src/sandbox/policy.js";
import { createServer } from "../src/server/index.js";
import { seededIdentity } from "./helpers/identity.js";

const CTX: HandlerContext = { abortSignal: undefined };
const FIXTURE = pathToFileURL(join(import.meta.dirname, "fixtures", "fixture-user-service", "index.js")).href;
const ECHO = join(import.meta.dirname, "fixtures", "fixture-user-service", "echo.js");
const NODE = "/usr/bin/node";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	vi.useRealTimers();
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function policy(user: string): Promise<UserPolicy> {
	const home = await mkdtemp(join(tmpdir(), `sigrun-service-${user}-`));
	cleanups.push(() => rm(home, { recursive: true, force: true }));
	return {
		user,
		workspace: `/tmp/${user}/workspace`,
		home,
		tmp: `/tmp/${user}/tmp`,
		ro: ["/usr"],
		rw: [],
		ensureDirs: [],
		env: { PATH: process.env.PATH ?? "", USER: user },
	};
}

async function readLine(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	try {
		let text = "";
		for (;;) {
			const newline = text.indexOf("\n");
			if (newline >= 0) return text.slice(0, newline);
			const next = await reader.read();
			if (next.done) return text;
			text += decoder.decode(next.value, { stream: true });
		}
	} finally { reader.releaseLock(); }
}

async function writeLine(handle: ServiceHandle, line: string): Promise<void> {
	const writer = handle.stdin.getWriter();
	await writer.write(new TextEncoder().encode(`${line}\n`));
	writer.releaseLock();
}

async function unitServices(start: UserService["start"], idleMinutes = 10): Promise<{
	services: UserServices;
	launches: { command: string; args: string[]; env: Record<string, string> }[];
}> {
	const launches: { command: string; args: string[]; env: Record<string, string> }[] = [];
	const services = new UserServices({
		launch: (_policy, command, args, env) => {
			launches.push({ command, args: [...args], env: { ...env } });
			return { command, args: [...args], env: { ...env } };
		},
		policyFor: () => {
			throw new Error("replaced below");
		},
		isolationActive: () => true,
		now: () => Date.now(),
	});
	const policies = new Map<string, UserPolicy>();
	(services as unknown as { deps: { policyFor(user: string): UserPolicy } }).deps.policyFor = (user) => {
		const existing = policies.get(user);
		if (existing !== undefined) return existing;
		throw new Error(`policy not initialized for ${user}`);
	};
	policies.set("alice", await policy("alice"));
	policies.set("bob", await policy("bob"));
	services.register("acme", [{ name: "echo", start, idleMinutes }], import.meta.dirname);
	cleanups.push(() => services.stopAll());
	return { services, launches };
}

const startEcho: UserService["start"] = async () => ({
	command: NODE,
	args: [ECHO],
	env: { SERVICE_TOKEN: "present" },
});

describe("UserServices process lifecycle", () => {
	test("concurrent connects share one pid; releasing one keeps it running", async () => {
		const { services, launches } = await unitServices(startEcho);
		const [first, second] = await Promise.all([
			services.connect("acme", "echo", "alice", CTX),
			services.connect("acme", "echo", "alice", CTX),
		]);
		const [firstReport, secondReport] = await Promise.all([
			readLine(first.stdout).then((line) => JSON.parse(line)),
			readLine(second.stdout).then((line) => JSON.parse(line)),
		]);
		expect(firstReport.pid).toBe(secondReport.pid);
		expect(firstReport.pid).toBeGreaterThan(0);
		expect(launches).toHaveLength(1);
		first.release();
		expect(services.statuses()).toEqual([
			{ slug: "acme", name: "echo", user: "alice", state: "running" },
		]);
		await writeLine(second, "still-running");
		expect(await readLine(second.stdout)).toBe("echo:still-running");
		second.release();
	});

	test("idle stop needs no handles and no stdio traffic for idleMinutes", async () => {
		vi.useFakeTimers();
		const { services } = await unitServices(async () => ({ command: NODE, args: ["-e", "process.stdin.resume()"] }), 2);
		cleanups.pop();
		const handle = await services.connect("acme", "echo", "alice", CTX);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(services.statuses()[0]?.state).toBe("running");
		handle.release();
		expect(services.statuses()[0]?.state).toBe("idle");
		await vi.advanceTimersByTimeAsync(90_000);
		expect(services.statuses()).toEqual([]);
		vi.useRealTimers();
		await new Promise((resolve) => setTimeout(resolve, 20));
		await expect(handle.exited).resolves.toMatchObject({ signal: "SIGTERM" });
		expect(services.statuses()).toEqual([]);
		const restarted = await services.connect("acme", "echo", "alice", CTX);
		expect(services.statuses()[0]?.state).toBe("running");
		restarted.release();
		await services.stopAll();
	});

	test("three crashes in 300000ms fail with the last 20 stderr lines", async () => {
		const { services } = await unitServices(startEcho);
		for (let crash = 0; crash < 3; crash++) {
			const handle = await services.connect("acme", "echo", "alice", CTX);
			await writeLine(handle, "crash");
			await expect(handle.exited).resolves.toMatchObject({ code: 7 });
			handle.release();
		}
		await expect(services.connect("acme", "echo", "alice", CTX)).rejects.toThrow(
			/stderr-6[\s\S]*stderr-25/,
		);
		await expect(services.connect("acme", "echo", "alice", CTX)).rejects.not.toThrow(/stderr-5\n/);
		expect(services.statuses()[0]).toMatchObject({ state: "failed", lastError: expect.stringContaining("stderr-25") });
	});

	test("stopUser, quarantine, and stopAll stop their processes", async () => {
		const { services } = await unitServices(startEcho);
		const alice = await services.connect("acme", "echo", "alice", CTX);
		const bob = await services.connect("acme", "echo", "bob", CTX);
		await services.stopUser("alice");
		await expect(alice.exited).resolves.toBeDefined();
		expect(services.statuses().map((row) => row.user)).toEqual(["bob"]);
		await services.quarantine("acme");
		await expect(bob.exited).resolves.toBeDefined();
		expect(services.statuses()).toEqual([]);
		await expect(services.connect("acme", "echo", "bob", CTX)).rejects.toThrow('unknown service "acme/echo"');
		services.register("acme", [{ name: "echo", start: startEcho }], import.meta.dirname);
		const shutdown = await services.connect("acme", "echo", "bob", CTX);
		await services.stopAll();
		await expect(shutdown.exited).resolves.toBeDefined();
		await expect(services.connect("acme", "echo", "bob", CTX)).rejects.toThrow("user services are stopped");
	});

	test("an unavailable service has the exact rejection", async () => {
		const { services } = await unitServices(async () => undefined);
		await expect(services.connect("acme", "echo", "alice", CTX)).rejects.toThrow("service not available for this user");
	});
});

interface Boot {
	opened: OpenedHarness;
	config: SigrunConfig;
	app: FastifyInstance;
	dir: string;
	tokens: Record<string, string>;
}
async function boot(): Promise<Boot> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-user-services-"));
	const configDir = join(dir, "config");
	await writeFile(join(dir, "settings.json"), '{"namingModel":false}');
	process.env.PARENT_SECRET_MUST_NOT_LEAK = "never-pass-this";
	process.env.SSH_AUTH_SOCK = "/tmp/parent-agent.sock";
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_AUTH: "token",
		SIGRUN_WORKSPACE_PATH: dir,
		SIGRUN_CONFIG_DIR: configDir,
		SIGRUN_DATA_DIR: join(dir, "data"),
		SIGRUN_CACHE_DIR: join(dir, "cache"),
		SIGRUN_STATE_DIR: join(dir, "state"),
		SIGRUN_PROVIDER_REFRESH_MINUTES: "0",
	});
	const identity = await seededIdentity(join(dir, "seed"));
	for (const user of ["alice", "bob"]) await identity.users.add({ user, admin: false, source: "cli" });
	const opened = await openHarness(config, {
		identity,
		extensionSpecifiers: [FIXTURE],
		builtins: false,
		settingsDir: dir,
		env: { PARENT_SECRET_MUST_NOT_LEAK: process.env.PARENT_SECRET_MUST_NOT_LEAK, SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK },
		isolationProbe: async () => ({ available: false, abi: 0, reason: "unit fixture" }),
	});
	const app = await createServer(opened, config);
	const tokens: Record<string, string> = {};
	for (const user of ["tester", "alice", "bob"]) tokens[user] = (await opened.identity.tokens.create(`${user}-test`, user)).token;
	cleanups.push(async () => {
		await opened.userServices.stopAll();
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
		delete process.env.PARENT_SECRET_MUST_NOT_LEAK;
		delete process.env.SSH_AUTH_SOCK;
	});
	return { opened, config, app, dir, tokens };
}

function host(opened: OpenedHarness) {
	const value = opened.seamHosts.get("acme");
	if (value === undefined) throw new Error("fixture host missing");
	return value;
}

describe("loaded services and HTTP surfaces", () => {
	test("the fixture env has spec.env and no parent secret or SSH agent", async () => {
		const { opened } = await boot();
		const handle = await host(opened).services.connect("echo", "alice", CTX);
		const report = JSON.parse(await readLine(handle.stdout));
		expect(report.env.SERVICE_TOKEN).toBe("alice-service-token");
		expect(report.env.PARENT_SECRET_MUST_NOT_LEAK).toBeUndefined();
		expect(report.env.SSH_AUTH_SOCK).toBeUndefined();
		handle.release();
	});

	test("a user's settings PUT clears only that user's failed state", async () => {
		const { opened, app, tokens } = await boot();
		for (let crash = 0; crash < 3; crash++) {
			const handle = await host(opened).services.connect("echo", "alice", CTX);
			await writeLine(handle, "crash");
			await handle.exited;
			handle.release();
		}
		await expect(host(opened).services.connect("echo", "alice", CTX)).rejects.toThrow("stderr-25");
		// A stop/start cycle is not a settings change and must not clear it.
		await opened.userServices.stopUser("alice");
		await expect(host(opened).services.connect("echo", "alice", CTX)).rejects.toThrow("stderr-25");
		const response = await app.inject({ method: "PUT", url: "/v1/me/extensions/acme/settings", headers: { authorization: `Bearer ${tokens.alice}` }, payload: { changed: true } });
		expect(response.statusCode).toBe(200);
		const restarted = await host(opened).services.connect("echo", "alice", CTX);
		restarted.release();
	});

	test("/v1/me/services shows only the caller; admin inventory shows all", async () => {
		const { opened, app, tokens } = await boot();
		const alice = await host(opened).services.connect("echo", "alice", CTX);
		const bob = await host(opened).services.connect("echo", "bob", CTX);
		const own = await app.inject({ method: "GET", url: "/v1/me/services", headers: { authorization: `Bearer ${tokens.alice}` } });
		expect(own.statusCode).toBe(200);
		expect(own.json().services).toEqual([{ slug: "acme", name: "echo", user: "alice", state: "running" }]);
		expect(own.body).not.toContain('"user":"bob"');
		const inventory = await app.inject({ method: "GET", url: "/v1/extensions", headers: { authorization: `Bearer ${tokens.tester}` } });
		const acme = inventory.json().extensions.find((row: { name: string }) => row.name === "acme");
		expect(acme.services).toEqual([
			{ slug: "acme", name: "echo", user: "alice", state: "running" },
			{ slug: "acme", name: "echo", user: "bob", state: "running" },
		]);
		alice.release();
		bob.release();
	});
});
