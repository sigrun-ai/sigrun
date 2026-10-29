import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import { seededIdentity } from "./helpers/identity.js";
import { createServer } from "../src/server/index.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, type DocumentReader } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { IsolationState } from "../src/sandbox/isolation.js";
import type { IsolationAvailability } from "../src/sandbox/availability.js";
import { UnavailableExecutionEnv } from "../src/sandbox/unavailable-env.js";
import { UserDirectory, AdmissionRefusedError } from "../src/harness/identity/users.js";
import { createWorkspaceService, defaultWorkspacePrefs } from "../src/harness/workspace.js";
import { WorkerPool, resolveWorkerEntry, testLauncher } from "../src/sandbox/pool.js";
import { selfPackageRoot } from "../src/harness/packages.js";

const dirs: string[] = [];
afterAll(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function tempDir(prefix = "sigrun-isolation-"): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}
const unavailable: IsolationAvailability = { available: false, abi: 0, reason: "not linux" };
const available: IsolationAvailability = { available: true, abi: 6 };

describe("IsolationState", () => {
	test.each([
		["off", true, 2, false],
		["off", false, 1, false],
		["always", true, 1, true],
		["always", false, 2, false],
		["auto", true, 0, false],
		["auto", true, 1, false],
		["auto", true, 2, true],
		["auto", false, 2, false],
	] as const)("%s available=%s users=%s -> active=%s", (mode, probe, users, expected) => {
		const state = new IsolationState({
			mode,
			availability: probe ? available : unavailable,
			userCount: () => users,
			log: () => undefined,
		});
		expect(state.active()).toBe(expected);
		expect(state.reason()).toBe(mode === "off" ? "isolation mode is off" : probe ? undefined : unavailable.reason);
	});

	test("auto latches on once and stays active after deletion down to one", () => {
		let users = 1;
		const lines: string[] = [];
		const state = new IsolationState({ mode: "auto", availability: available, userCount: () => users, log: (line) => lines.push(line) });
		expect(state.active()).toBe(false);
		expect(state.active()).toBe(false);
		users = 2;
		expect(state.active()).toBe(true);
		expect(state.active()).toBe(true);
		users = 1;
		expect(state.active()).toBe(true);
		users = 0;
		expect(state.active()).toBe(true);
		expect(lines).toHaveLength(2);
	});
});

describe("UnavailableExecutionEnv", () => {
	test("every method fails closed with the reason; id and cwd carry no access", async () => {
		const env: ExecutionEnv = new UnavailableExecutionEnv("not linux");
		expect(env.id).toBe("unavailable");
		expect(env.cwd).toBe(".");
		env.cwd = "/tmp";
		const calls: [string, () => Promise<unknown>][] = [
			["absolutePath", () => env.absolutePath("x", BACKGROUND_CONTEXT)],
			["joinPath", () => env.joinPath(["x"], BACKGROUND_CONTEXT)],
			["readTextFile", () => env.readTextFile("x", BACKGROUND_CONTEXT)],
			["openTextLineReader", () => env.openTextLineReader("x", BACKGROUND_CONTEXT)],
			["readTextLines", () => env.readTextLines("x", undefined, BACKGROUND_CONTEXT)],
			["readBinaryFile", () => env.readBinaryFile("x", BACKGROUND_CONTEXT)],
			["openBinaryReader", () => env.openBinaryReader("x", undefined, BACKGROUND_CONTEXT)],
			["writeFile", () => env.writeFile("x", "x", BACKGROUND_CONTEXT)],
			["appendFile", () => env.appendFile("x", "x", BACKGROUND_CONTEXT)],
			["truncateFile", () => env.truncateFile("x", 0, BACKGROUND_CONTEXT)],
			["flushFile", () => env.flushFile("x", BACKGROUND_CONTEXT)],
			["renameFile", () => env.renameFile("x", "y", BACKGROUND_CONTEXT)],
			["fileInfo", () => env.fileInfo("x", BACKGROUND_CONTEXT)],
			["listDir", () => env.listDir("x", BACKGROUND_CONTEXT)],
			["listFiles", () => env.listFiles!("x", undefined, BACKGROUND_CONTEXT)],
			["openDirReader", () => env.openDirReader("x", BACKGROUND_CONTEXT)],
			["watch", () => env.watch([], () => undefined, BACKGROUND_CONTEXT)],
			["canonicalPath", () => env.canonicalPath("x", BACKGROUND_CONTEXT)],
			["exists", () => env.exists("x", BACKGROUND_CONTEXT)],
			["createDir", () => env.createDir("x", undefined, BACKGROUND_CONTEXT)],
			["remove", () => env.remove("x", undefined, BACKGROUND_CONTEXT)],
			["createTempDir", () => env.createTempDir(undefined, BACKGROUND_CONTEXT)],
			["createTempFile", () => env.createTempFile(undefined, BACKGROUND_CONTEXT)],
			["cleanup", () => env.cleanup(BACKGROUND_CONTEXT)],
			["exec", () => env.exec("true", undefined, BACKGROUND_CONTEXT)],
		];
		for (const [name, call] of calls) {
			let result: unknown;
			try { result = await call(); } catch (error) { result = error; }
			if (name === "cleanup") {
				expect(result, name).toBeInstanceOf(Error);
				expect((result as Error).message).toBe("isolation_unavailable: not linux");
			} else {
				expect(result, name).toMatchObject({ ok: false, error: { message: "isolation_unavailable: not linux" } });
			}
		}
	});
});

describe("admission and first transition", () => {
	test("the first admin gains the configured workspace when bob is added", async () => {
		const dir = await tempDir();
		const workspace = join(dir, "configured-workspace");
		await mkdir(workspace);
		const users = new UserDirectory(join(dir, "users.json"), {
			firstWorkspace: workspace,
		});
		await users.add({ user: "alice", admin: true, source: "cli" });
		await users.add({ user: "bob", admin: false, source: "invite" });
		expect(users.get("alice")?.workspace).toBe(workspace);
		await expect(users.add({ user: "bob", admin: false, source: "cli" })).rejects.toThrow(/already exists/);
	});

	test("a direct second add is refused too", async () => {
		const dir = await tempDir();
		const users = new UserDirectory(join(dir, "users.json"), {
			admit: () => { throw new AdmissionRefusedError("auth_required", "auth_required: configure token or proxy authentication"); },
		});
		await users.add({ user: "alice", admin: true, source: "cli" });
		await expect(users.add({ user: "bob", admin: false, source: "cli" })).rejects.toMatchObject({ code: "auth_required" });
		expect(users.get("bob")).toBeUndefined();
	});
});

describe("proxy-secret transition admission", () => {
	const proxyEnv = {
		SIGRUN_AUTH: "proxy",
		SIGRUN_AUTH_TRUSTED_PROXIES: "10.42.0.0/16",
		SIGRUN_ISOLATION: "auto",
		// The vouched claim below presents this secret when the boot
		// configures secretHeader (the pipeline's env-only credential).
		SIGRUN_PROXY_SECRET: "test-secret",
	};

	async function bootProxyServer(withSecretHeader: boolean) {
		const dir = await tempDir();
		const config = loadConfig({
			SIGRUN_DEFAULT_MODEL: "openai/gpt-4o",
			SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
			SIGRUN_WORKSPACE_PATH: dir,
			...proxyEnv,
		}, withSecretHeader ? { server: { auth: { proxy: { secretHeader: "x-sigrun-proxy-secret" } } } } : undefined);
		const opened = await openHarness(config, {
			identity: await seededIdentity(dir, "alice"),
			env: {},
			builtins: false,
			isolationProbe: async () => available,
		});
		const app = await createServer(opened, { ...config, webui: { ...config.webui, enabled: false } });
		cleanups.push(async () => {
			await app.close();
			await opened.harness.close(BACKGROUND_CONTEXT);
		});
		return { app, opened };
	}
	const cleanups: (() => Promise<void>)[] = [];
	afterAll(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

	test("auto proxy without secretHeader refuses the second user with 409 isolation_required", async () => {
		const { app, opened } = await bootProxyServer(false);
		const { code } = await opened.identity.invites.create({ admin: false });
		// C2 (proxy-trust Task 4): this claimed server is proxy-only on a
		// non-loopback bind, so an UNVOUCHED invite claim is now refused
		// 403 proxy_identity_required before the admission guard runs.
		// Vouch the request (trusted peer + identity header, no secret
		// configured on this boot) so it still reaches the admission
		// logic this test exists to exercise.
		const response = await app.inject({
			method: "POST",
			url: "/v1/onboarding/claim",
			remoteAddress: "10.42.3.4",
			headers: { "remote-user": "bob" },
			payload: { code, user: "bob" },
		});
		expect(response.statusCode).toBe(409);
		expect(response.json()).toEqual({ error: "isolation_required" });
		expect(opened.identity.users.list().map((user) => user.user)).toEqual(["alice"]);
	});

	test("auto proxy with secretHeader permits the second user", async () => {
		const { app, opened } = await bootProxyServer(true);
		const { code } = await opened.identity.invites.create({ admin: false });
		// Vouched as above, plus the configured shared-secret header.
		const response = await app.inject({
			method: "POST",
			url: "/v1/onboarding/claim",
			remoteAddress: "10.42.3.4",
			headers: { "remote-user": "bob", "x-sigrun-proxy-secret": "test-secret" },
			payload: { code, user: "bob" },
		});
		expect(response.statusCode).toBe(200);
		expect(opened.identity.users.list().map((user) => user.user)).toEqual(["alice", "bob"]);
	});
});

describe("boot refusals and fail-closed consumers", () => {
	test("two users and no auth refuses boot naming both fixes", async () => {
		const dir = await tempDir();
		const identity = await seededIdentity(dir, "alice");
		await identity.users.add({ user: "bob", admin: false, source: "cli" });
		const config = loadConfig({
			SIGRUN_DEFAULT_MODEL: "openai/gpt-4o",
			SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
			SIGRUN_WORKSPACE_PATH: dir,
			SIGRUN_AUTH: "none",
		});
		await expect(openHarness(config, { identity, env: {}, builtins: false })).rejects.toThrow(/SIGRUN_AUTH.*token|proxy|remove.*user|one user/i);
	});

	test("always isolation with proxy and no secretHeader refuses boot", async () => {
		const dir = await tempDir();
		const config = loadConfig({
			SIGRUN_DEFAULT_MODEL: "openai/gpt-4o",
			SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
			SIGRUN_WORKSPACE_PATH: dir,
			SIGRUN_AUTH: "proxy",
			SIGRUN_AUTH_TRUSTED_PROXIES: "10.42.0.0/16",
			SIGRUN_ISOLATION: "always",
		});
		await expect(openHarness(config, { identity: await seededIdentity(dir), env: {}, builtins: false, isolationProbe: async () => available })).rejects.toThrow(/proxy.*secretHeader|secretHeader.*proxy/i);
	});

	async function bootTwoUserServer() {
		const dir = await tempDir();
		const faux = fauxProvider({ provider: "faux", models: [{ id: "m", contextWindow: 128_000 }] });
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo must-not-run" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const contributor: ProviderContributor = { name: "ext-faux", providers: [{ provider: faux.provider }] };
		const config = loadConfig({
			SIGRUN_DEFAULT_MODEL: "faux/m",
			SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
			SIGRUN_WORKSPACE_PATH: dir,
			SIGRUN_AUTH: "token",
		});
		const identity = await seededIdentity(dir, "alice");
		await identity.users.add({ user: "bob", admin: false, source: "cli" });
		const opened = await openHarness(config, {
			identity,
			extensions: [contributor],
			env: {},
			builtins: false,
			isolationProbe: async () => unavailable,
		});
		const app = await createServer(opened, { ...config, webui: { ...config.webui, enabled: false } });
		cleanups.push(async () => {
			await app.close();
			await opened.harness.close(BACKGROUND_CONTEXT);
		});
		const { token } = await opened.identity.tokens.create("test", "alice");
		return { app, opened, token };
	}
	const cleanups: (() => Promise<void>)[] = [];
	afterAll(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

	test("a bash tool call fails with isolation_unavailable", async () => {
		const { opened } = await bootTwoUserServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT);
		const submission = await root.submit({ type: "input", content: [{ type: "text", text: "run bash" }] }, BACKGROUND_CONTEXT);
		await submission.wait(BACKGROUND_CONTEXT);
		const view = await root.viewState(BACKGROUND_CONTEXT);
		try {
			const text = JSON.stringify(view.value.entries);
			expect(text).toContain("isolation_unavailable: not linux");
			expect(text).not.toContain("echo must-not-run\nmust-not-run");
		} finally { await view.dispose(); }
	});

	test("GET files fails with isolation_unavailable", async () => {
		const { app, opened, token } = await bootTwoUserServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT);
		const response = await app.inject({ method: "GET", url: `/v1/conversations/${root.id}/files`, headers: { authorization: `Bearer ${token}` } });
		expect(response.statusCode).toBeGreaterThanOrEqual(500);
		expect(response.body).toContain("isolation_unavailable: not linux");
	});

	test("an upload fails with isolation_unavailable", async () => {
		const { app, opened, token } = await bootTwoUserServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT);
		const response = await app.inject({ method: "POST", url: `/v1/conversations/${root.id}/uploads`, headers: { authorization: `Bearer ${token}` }, payload: { name: "x.txt", contentBase64: "aGk=" } });
		expect(response.statusCode).toBeGreaterThanOrEqual(500);
		expect(response.body).toContain("isolation_unavailable: not linux");
	});

	test("job prompt expansion fails with isolation_unavailable", async () => {
		const { opened } = await bootTwoUserServer();
		const expansion = opened.commandExpansion;
		const deps = {
			harness: opened.harness,
			storage: opened.storage,
			registry: opened.registry,
			models: opened.models,
			defaultModel: opened.defaultModel,
			now: () => 1000,
			defaultTz: "UTC",
			commandExpansion: { ...expansion, templates: { userDir: "/no-such-templates", packageRoots: () => [] } },
			envBuilder: opened.envBuilder,
			gatewayLoaded: false,
		};
		await opened.harness.commit(async (tx) => {
			const { writeJobChange } = await import("../src/jobs/docs.js");
			const { specHash } = await import("../src/jobs/spec.js");
			const spec = { name: "expand", schedule: { every: "60s" }, action: { kind: "prompt", prompt: "/expand", conversation: "new" } } as const;
			await writeJobChange(tx, "api:expand", { source: "api", spec, owner: "alice", enabled: true, createdAt: new Date(1000).toISOString(), hash: specHash("api:expand", spec), state: "waiting" }, "alice", new Date(1000).toISOString());
		}, BACKGROUND_CONTEXT);
		const { fireJob } = await import("../src/jobs/fire.js");
		await expect(fireJob(deps, "api:expand", "api:expand:manual:1000", 1000, BACKGROUND_CONTEXT)).rejects.toThrow("isolation_unavailable: not linux");
	});
});

describe("per-owner workspace envs", () => {
	test("alice and bob use different workers rooted at their own workspaces", async () => {
		const dir = await tempDir();
		const coreRoot = selfPackageRoot();
		if (coreRoot === undefined) throw new Error("core root required");
		const aliceWorkspace = join(dir, "alice-work");
		const bobWorkspace = join(dir, "bob-work");
		await mkdir(aliceWorkspace);
		await mkdir(bobWorkspace);
		const users = new UserDirectory(join(dir, "users.json"));
		await users.add({ user: "alice", admin: true, source: "cli", workspace: aliceWorkspace });
		await users.add({ user: "bob", admin: false, source: "cli", workspace: bobWorkspace });
		const pool = new WorkerPool({
			launcher: testLauncher(resolveWorkerEntry(coreRoot)),
			idleMinutes: () => 10,
			log: () => undefined,
			workerEntry: resolveWorkerEntry(coreRoot),
		});
		try {
			const owners = new Map([[1, "alice"], [2, "bob"]]);
			const service = createWorkspaceService({
				isolation: new IsolationState({ mode: "auto", availability: available, userCount: () => users.list().length, log: () => undefined }),
				pool,
				directory: users,
				managed: {
					roots: { configDir: join(dir, "config"), dataDir: join(dir, "data"), cacheDir: join(dir, "cache"), stateDir: join(dir, "state") },
					storagePath: join(dir, "data", "sigrun.db"),
					coreRoot,
					userAreas: (user) => join(dir, "data", "users", user),
				},
				ownerOf: async (id) => owners.get(id),
			});
			const prefs = defaultWorkspacePrefs(join(dir, "shared"));
			const read = null as unknown as DocumentReader;
			const alice = await service.forConversation({ id: 1 as never }, prefs, read, BACKGROUND_CONTEXT);
			const bob = await service.forConversation({ id: 2 as never }, prefs, read, BACKGROUND_CONTEXT);
			await writeFile(join(aliceWorkspace, "owner.txt"), "alice");
			await writeFile(join(bobWorkspace, "owner.txt"), "bob");
			expect(alice.cwd).toBe(aliceWorkspace);
			expect(bob.cwd).toBe(bobWorkspace);
			const aliceRead = await alice.readTextFile("owner.txt", BACKGROUND_CONTEXT);
			const bobRead = await bob.readTextFile("owner.txt", BACKGROUND_CONTEXT);
			expect(aliceRead.ok && aliceRead.value).toBe("alice");
			expect(bobRead.ok && bobRead.value).toBe("bob");
			let alicePid = "";
			let bobPid = "";
			const aliceExec = await alice.exec("echo $$", { onOutput: (text) => { alicePid += text; } }, BACKGROUND_CONTEXT);
			const bobExec = await bob.exec("echo $$", { onOutput: (text) => { bobPid += text; } }, BACKGROUND_CONTEXT);
			expect(aliceExec.ok && bobExec.ok).toBe(true);
			expect(aliceExec.ok && bobExec.ok && aliceExec.value.exitCode).toBe(0);
			expect(alicePid.trim()).toMatch(/^\d+$/);
			expect(bobPid.trim()).toMatch(/^\d+$/);
			expect(alicePid.trim()).not.toBe(bobPid.trim());
			expect(alice.id).not.toBe(bob.id);
		} finally {
			await pool.stopAll();
		}
	});
});
