/**
 * Extension slash commands (core hardening W5 Task 3, spec §9.3): the
 * catalog merge (`/v1/commands` serves core + extension entries), the
 * collision rules (core names reserved — dropped with a warning, never
 * recorded; ext-vs-ext last-registered-wins — recorded in `/v1/meta`
 * `collisions.commands`), the write-gated invoke route
 * (`POST /v1/conversations/:id/commands/:name`), and the loader's
 * `commands` validation (a malformed declaration quarantines).
 *
 * Fixtures: `fixture-commands` (slug `fixture-commands`; declares
 * `hello` → `{notice: "hi " + args}` and `new` — the core collision) and
 * `fixture-commands-alt` (declares `hello` again — the ext-vs-ext
 * collision; loaded second so it wins). The single-fixture server pins
 * the clean-merge + invoke behavior; the two-fixture server pins the
 * collision record and last-registered-wins. Token-method boots with a
 * claimed directory (the extension-routes pattern).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import { resolveExtension } from "../src/harness/loader.js";
import { createServer } from "../src/server/index.js";
import { seededIdentity } from "./helpers/identity.js";

const COMMANDS_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-commands", "index.js"),
).href;
const ALT_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-commands-alt", "index.js"),
).href;

interface TestServer {
	readonly app: FastifyInstance;
	readonly opened: OpenedHarness;
	readonly aliceToken: string;
	readonly testerToken: string;
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

/**
 * Boot one hermetic token-method server. `fixtures` picks the load set:
 * `["commands"]` (the clean single-fixture merge) or both (the
 * ext-vs-ext collision; the ALT loads SECOND so it wins).
 */
async function bootServer(
	fixtures: readonly ("commands" | "alt")[],
): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-ext-commands-"));
	const configDir = join(dir, "config");
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "openai/gpt-test",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
		SIGRUN_WEBUI: "false",
		SIGRUN_AUTH: "token",
		SIGRUN_CONFIG_DIR: configDir,
	});
	const identity = await seededIdentity(join(dir, "seed"));
	await identity.users.add({ user: "alice", admin: false, source: "cli" });
	const specifiers = fixtures.map((fixture) =>
		fixture === "commands" ? COMMANDS_SPECIFIER : ALT_SPECIFIER,
	);
	const opened = await openHarness(config, {
		identity,
		extensionSpecifiers: specifiers,
		env: { SIGRUN_CONFIG_DIR: configDir },
		settingsDir: dir,
	});
	const { token: aliceToken } = await opened.identity.tokens.create(
		"alice-cli",
		"alice",
	);
	const { token: testerToken } = await opened.identity.tokens.create(
		"tester-cli",
		"tester",
	);
	const app = await createServer(opened, config);
	cleanups.push(async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	});
	return { app, opened, aliceToken, testerToken };
}

/** One merged `/v1/commands` catalog entry (the wire shape the clients see). */
interface CommandEntry {
	readonly name: string;
	readonly description: string;
	readonly argsHint?: string;
	readonly extension?: string;
	readonly endpoint: { readonly method: string; readonly path: string };
}

/** One injected request; returns status + parsed body. */
async function call(
	app: FastifyInstance,
	options: {
		readonly method: string;
		readonly url: string;
		readonly token?: string;
		readonly payload?: Record<string, unknown>;
	},
): Promise<{ status: number; json(): unknown }> {
	const response = await app.inject({
		method: options.method as "GET",
		url: options.url,
		headers: {
			...(options.payload === undefined ? {} : { "content-type": "application/json" }),
			...(options.token === undefined
				? {}
				: { authorization: `Bearer ${options.token}` }),
		},
		...(options.payload === undefined
			? {}
			: { payload: JSON.stringify(options.payload) }),
	});
	return { status: response.statusCode, json: () => response.json() };
}

/** Create a conversation as `tester`; resolves to its id. */
async function createConversation(
	app: FastifyInstance,
	token: string,
): Promise<number> {
	const response = await call(app, {
		method: "POST",
		url: "/v1/conversations",
		token,
		payload: {},
	});
	expect(response.status).toBe(201);
	return (response.json() as { id: number }).id;
}

/** The merged `/v1/commands` catalog entries. */
async function listCommands(
	app: FastifyInstance,
	token: string,
): Promise<readonly CommandEntry[]> {
	const response = await call(app, {
		method: "GET",
		url: "/v1/commands",
		token,
	});
	expect(response.status).toBe(200);
	return (response.json() as { commands: readonly CommandEntry[] }).commands;
}

describe("extension slash commands: the catalog merge", () => {
	test("/v1/commands lists hello with its extension slug + invoke endpoint; the core `new` stays singular", async () => {
		const { app, testerToken } = await bootServer(["commands"]);
		const commands = await listCommands(app, testerToken);
		const hello = commands.find((command) => command.name === "hello");
		expect(hello).toEqual({
			name: "hello",
			description: "Say hello",
			argsHint: "<name>",
			extension: "fixture-commands",
			endpoint: {
				method: "POST",
				path: "/v1/conversations/:id/commands/hello",
			},
		});
		// The core-name collision is DROPPED: exactly one `new`, and it is
		// the core entry (no `extension` field).
		const named = commands.filter((command) => command.name === "new");
		expect(named).toHaveLength(1);
		expect(named[0]?.extension).toBeUndefined();
		// The core table stays intact ahead of the extension entry.
		expect(commands.map((command) => command.name)).toEqual([
			"new",
			"fork",
			"compact",
			"export",
			"import",
			"name",
			"model",
			"thinking",
			"jobs",
			"hello",
		]);
	});

	test("the core-name drop is warned, never recorded: collisions.commands stays empty", async () => {
		const { app, testerToken } = await bootServer(["commands"]);
		const meta = await call(app, {
			method: "GET",
			url: "/v1/meta",
			token: testerToken,
		});
		expect(meta.status).toBe(200);
		const collisions = (
			meta.json() as {
				collisions: { commands: readonly { readonly name: string }[] };
			}
		).collisions;
		expect(collisions.commands).toEqual([]);
	});
});

describe("extension slash commands: ext-vs-ext collisions", () => {
	test("the last registration wins the catalog; one collision record names previous + contributor", async () => {
		const { app, testerToken } = await bootServer(["commands", "alt"]);
		const commands = await listCommands(app, testerToken);
		const hello = commands.find((command) => command.name === "hello");
		expect(hello?.extension).toBe("fixture-commands-alt");
		// Exactly one entry survives — the loser never renders in the menu.
		expect(commands.filter((command) => command.name === "hello")).toHaveLength(1);
		const meta = await call(app, {
			method: "GET",
			url: "/v1/meta",
			token: testerToken,
		});
		const collisions = (
			meta.json() as {
				collisions: {
					commands: readonly {
						readonly kind: string;
						readonly name: string;
						readonly previous: string;
						readonly contributor: string;
					}[];
				};
			}
		).collisions;
		expect(collisions.commands).toEqual([
			{
				kind: "command",
				name: "hello",
				previous: "fixture-commands",
				contributor: "fixture-commands-alt",
			},
		]);
	});

	test("invoking the collided name runs the WINNER (last-registered)", async () => {
		const { app, testerToken } = await bootServer(["commands", "alt"]);
		const id = await createConversation(app, testerToken);
		const response = await call(app, {
			method: "POST",
			url: `/v1/conversations/${id}/commands/hello`,
			token: testerToken,
			payload: { args: "bob" },
		});
		expect(response.status).toBe(200);
		expect(response.json()).toEqual({ notice: "alt greets bob" });
	});
});

describe("extension slash commands: the invoke route", () => {
	test("POST …/commands/hello {args} runs the extension command and returns its notice", async () => {
		const { app, testerToken } = await bootServer(["commands"]);
		const id = await createConversation(app, testerToken);
		const response = await call(app, {
			method: "POST",
			url: `/v1/conversations/${id}/commands/hello`,
			token: testerToken,
			payload: { args: "bob" },
		});
		expect(response.status).toBe(200);
		expect(response.json()).toEqual({ notice: "hi bob" });
	});

	test("an absent body runs with empty args (args ?? \"\")", async () => {
		const { app, testerToken } = await bootServer(["commands"]);
		const id = await createConversation(app, testerToken);
		const response = await call(app, {
			method: "POST",
			url: `/v1/conversations/${id}/commands/hello`,
			token: testerToken,
		});
		expect(response.status).toBe(200);
		expect(response.json()).toEqual({ notice: "hi " });
	});

	test("an unknown name is 404 command_not_found", async () => {
		const { app, testerToken } = await bootServer(["commands"]);
		const id = await createConversation(app, testerToken);
		const response = await call(app, {
			method: "POST",
			url: `/v1/conversations/${id}/commands/nosuch`,
			token: testerToken,
			payload: {},
		});
		expect(response.status).toBe(404);
		expect(response.json()).toEqual({ error: "command_not_found" });
	});

	test("the dropped core-collision name does not invoke (404, not the extension's run)", async () => {
		const { app, testerToken } = await bootServer(["commands"]);
		const id = await createConversation(app, testerToken);
		const response = await call(app, {
			method: "POST",
			url: `/v1/conversations/${id}/commands/new`,
			token: testerToken,
			payload: {},
		});
		expect(response.status).toBe(404);
		expect(response.json()).toEqual({ error: "command_not_found" });
	});

	test("a read-only sharee gets 403 (the invoke route is write-gated)", async () => {
		const { app, aliceToken, testerToken } = await bootServer(["commands"]);
		const id = await createConversation(app, testerToken);
		const shared = await call(app, {
			method: "PATCH",
			url: `/v1/conversations/${id}/meta`,
			token: testerToken,
			payload: { sharing: { scope: "household", level: "read" } },
		});
		expect(shared.status).toBe(200);
		const response = await call(app, {
			method: "POST",
			url: `/v1/conversations/${id}/commands/hello`,
			token: aliceToken,
			payload: { args: "bob" },
		});
		expect(response.status).toBe(403);
		expect(response.json()).toEqual({ error: "forbidden" });
	});
});

describe("extension slash commands: loader validation", () => {
	test("a malformed commands declaration fails the load (quarantine, never silent)", async () => {
		await expect(
			resolveExtension({
				default: () => ({
					extension: { name: "bad-commands" },
					commands: [{ name: "Bad Name", description: "x", run: () => undefined }],
				}),
			}),
		).rejects.toThrow(/name/);
		await expect(
			resolveExtension({
				default: () => ({
					extension: { name: "bad-commands" },
					commands: [{ name: "ok-name", description: "x", run: "not a function" }],
				}),
			}),
		).rejects.toThrow(/run/);
		await expect(
			resolveExtension({
				default: () => ({
					extension: { name: "bad-commands" },
					commands: [{ name: "ok-name", description: 42, run: () => undefined }],
				}),
			}),
		).rejects.toThrow(/description/);
		await expect(
			resolveExtension({
				default: () => ({
					extension: { name: "bad-commands" },
					commands: [{ name: "ok-name", description: "x", args: 7, run: () => undefined }],
				}),
			}),
		).rejects.toThrow(/args/);
	});

	test("a commands field that is not an array quarantines", async () => {
		await expect(
			resolveExtension({
				default: () => ({
					extension: { name: "bad-commands" },
					commands: "hello",
				}),
			}),
		).rejects.toThrow(/array/);
	});

	test("a well-formed declaration resolves with its commands retained", async () => {
		const run = async () => ({ notice: "ok" });
		const result = await resolveExtension({
			default: () => ({
				extension: { name: "good-commands" },
				commands: [
					{ name: "hello", description: "Say hello", args: "<name>", run },
					{ name: "plain", description: "No args", run },
				],
			}),
		});
		expect(result?.commands).toEqual([
			{ name: "hello", description: "Say hello", args: "<name>", run },
			{ name: "plain", description: "No args", run },
		]);
	});
});
