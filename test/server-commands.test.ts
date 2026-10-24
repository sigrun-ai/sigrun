/**
 * Task 7: the slash-command catalog — `GET /v1/commands` serves the thin
 * metadata list the composer's `/` menu consumes, and every catalog entry's
 * `endpoint` must resolve to a REAL registered route (the catalog is a map
 * over existing endpoints; a dangling path would make the menu execute a
 * 404).
 *
 * Hermetic pattern: faux provider + tmp workspace + `app.inject()` (see
 * server-submissions.test.ts). One booted server covers both tests.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { SLASH_COMMANDS } from "../src/server/commands.js";
import { createServer } from "../src/server/index.js";
import { seededIdentity } from "./helpers/identity.js";
import type { FastifyInstance } from "fastify";

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

async function bootServer(): Promise<FastifyInstance> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-commands-"));
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	const contributor: ProviderContributor = {
		name: "ext-faux",
		providers: [{ provider: faux.provider }],
	};
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_AUTH: "none",
		SIGRUN_WORKSPACE_PATH: dir,
	});
	const opened: OpenedHarness = await openHarness(config, {
		identity: await seededIdentity(dir),
		extensions: [contributor],
		env: {},
	});
	const app = await createServer(opened, config);
	cleanups.push(async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	});
	return app;
}

/** A 1x1 red PNG (base64) — the same verified fixture bytes server-submissions.test.ts uses. */
const RED_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8BQDwAEBQAF" +
	"yN0c5gAAAABJRU5ErkJggg==";

/** Submit `input` to `conversationId` (the §5 body shape); returns status + body. */
async function submit(
	app: FastifyInstance,
	conversationId: number,
	input: unknown,
	waitMs?: number,
): Promise<{ status: number; body: Record<string, unknown> }> {
	const response = await app.inject({
		method: "POST",
		url: `/v1/conversations/${conversationId}/submissions`,
		payload: waitMs === undefined ? { input } : { input, waitMs },
	});
	return { status: response.statusCode, body: response.json() as Record<string, unknown> };
}

describe("GET /v1/commands", () => {
	test("serves the catalog: the known set with metadata shape", async () => {
		const app = await bootServer();
		const response = await app.inject({ method: "GET", url: "/v1/commands" });
		expect(response.statusCode).toBe(200);
		const body = response.json() as {
			commands: {
				name: string;
				description: string;
				argsHint?: string;
				endpoint: { method: string; path: string };
			}[];
		};
		expect(body.commands.map((c) => c.name)).toEqual([
			"new",
			"fork",
			"compact",
			"export",
			"import",
			"name",
			"model",
			"thinking",
			"jobs",
			// The gateway built-in's two commands (gateway Task 4, §8.2) —
			// extension-declared, merged after the core table.
			"pair",
			"link",
		]);
		for (const command of body.commands) {
			expect(typeof command.description).toBe("string");
			expect(command.description.length).toBeGreaterThan(0);
			expect(["GET", "POST", "PATCH"]).toContain(command.endpoint.method);
			expect(command.endpoint.path).toMatch(/^\/v1\//);
		}
		// The argless commands carry NO argsHint; the arg-taking ones do.
		const byName = new Map(body.commands.map((c) => [c.name, c]));
		expect(byName.get("new")?.argsHint).toBeUndefined();
		expect(byName.get("export")?.argsHint).toBeUndefined();
		expect(byName.get("fork")?.argsHint).toBe("[at]");
		expect(byName.get("compact")?.argsHint).toBe("[instructions]");
		expect(byName.get("import")?.argsHint).toBe("<jsonl>");
		expect(byName.get("name")?.argsHint).toBe("<name>");
		expect(byName.get("model")?.argsHint).toBe("<provider/model>");
		expect(byName.get("thinking")?.argsHint).toBe("<level>");
		expect(byName.get("jobs")?.argsHint).toBeUndefined();
	});

	test("every catalog entry's endpoint resolves to a real registered route", async () => {
		const app = await bootServer();
		for (const command of SLASH_COMMANDS.values()) {
			const endpoint = command.endpoint;
			if (endpoint === undefined) continue;
			expect(
				app.hasRoute({ method: endpoint.method, url: endpoint.path }),
				`${command.name} -> ${endpoint.method} ${endpoint.path}`,
			).toBe(true);
		}
	});

	test("the registry is keyed by bare name (menu lookups)", () => {
		expect(SLASH_COMMANDS.get("name")?.endpoint).toEqual({
			method: "PATCH",
			path: "/v1/conversations/:id/meta",
		});
		// /model and /thinking share the configure endpoint — each sends
		// exactly one of its two body fields.
		expect(SLASH_COMMANDS.get("model")?.endpoint).toEqual(
			SLASH_COMMANDS.get("thinking")?.endpoint,
		);
	});
});

// ─── Task 2c: /skill:name + prompt templates, expanded at admission ────────

/**
 * One hermetic server with a workspace skill, a workspace template, and a
 * user-dir template that collides with the core `fork` command (the
 * collision-skip case). Boots with the faux provider so submissions can
 * settle, and scripting off (the submissions read the transcript, not
 * scripted responses).
 */
interface ExpansionServer {
	app: FastifyInstance;
	opened: OpenedHarness;
	/** The tmp workspace root (`SIGRUN_WORKSPACE_PATH`). */
	workspace: string;
	/** The tmp config dir (`SIGRUN_CONFIG_DIR`) carrying `prompts/fork.md`. */
	configDir: string;
}

async function bootExpansionServer(): Promise<ExpansionServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-commands-exp-"));
	const configDir = join(dir, "config");
	await mkdir(join(dir, "skills", "greet"), { recursive: true });
	await writeFile(
		join(dir, "skills", "greet", "SKILL.md"),
		"---\nname: greet\ndescription: Greet someone warmly.\n---\n" +
			"# Greeting\n\nSay hello to the user.\n",
	);
	await mkdir(join(dir, "prompts"), { recursive: true });
	await writeFile(
		join(dir, "prompts", "review.md"),
		"---\ndescription: Review the changes\nargument-hint: \"[focus]\"\n---\n" +
			"Review with focus: $1\n",
	);
	await mkdir(join(configDir, "prompts"), { recursive: true });
	await writeFile(
		join(configDir, "prompts", "fork.md"),
		"---\ndescription: Not the fork\n---\nshould never expand\n",
	);
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	faux.setResponses([fauxAssistantMessage("ok")]);
	const contributor: ProviderContributor = {
		name: "ext-faux",
		providers: [{ provider: faux.provider }],
	};
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_AUTH: "none",
		SIGRUN_WORKSPACE_PATH: dir,
		SIGRUN_CONFIG_DIR: configDir,
	});
	const opened = await openHarness(config, {
		identity: await seededIdentity(dir),
		extensions: [contributor],
		env: {},
		settingsDir: configDir,
	});
	const app = await createServer(opened, config);
	cleanups.push(async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	});
	return { app, opened, workspace: dir, configDir };
}

describe("the expand catalog (GET /v1/commands)", () => {
	test("skills and templates appear as kind:expand entries; a command-colliding template is skipped", async () => {
		const { app } = await bootExpansionServer();
		const response = await app.inject({ method: "GET", url: "/v1/commands" });
		expect(response.statusCode).toBe(200);
		const body = response.json() as {
			commands: {
				name: string;
				description: string;
				argsHint?: string;
				kind?: string;
				endpoint?: { method: string; path: string };
			}[];
		};
		const byName = new Map(body.commands.map((command) => [command.name, command]));
		// Every skill becomes skill:<name> with its description.
		expect(byName.get("skill:greet")).toEqual({
			name: "skill:greet",
			description: "Greet someone warmly.",
			kind: "expand",
		});
		// Templates carry their argument-hint and kind:expand, no endpoint.
		expect(byName.get("review")).toEqual({
			name: "review",
			description: "Review the changes",
			argsHint: "[focus]",
			kind: "expand",
		});
		// The fork.md template collides with the core /fork command — skipped.
		expect(byName.has("fork")).toBe(true); // the core entry, still endpoint-kind
		expect(byName.get("fork")?.kind).toBeUndefined();
		expect(body.commands.filter((command) => command.name === "fork")).toHaveLength(1);
		// The core table itself is unchanged: endpoint entries carry no kind.
		expect(byName.get("new")?.kind).toBeUndefined();
		expect(byName.get("new")?.endpoint).toBeDefined();
	});
});

describe("expansion at admission (POST .../submissions)", () => {
	/** Read the conversation view through the API. */
	async function readView(app: FastifyInstance, id: number) {
		const response = await app.inject({
			method: "GET",
			url: `/v1/conversations/${id}`,
		});
		return response.json() as {
			entries: {
				id: number;
				kind: string;
				data?: { typed?: string; command?: string };
				model?: { content: { type: string; text?: string }[] }[];
			}[];
		};
	}

	test("/review concurrency admits the expanded text and the entry carries typed", async () => {
		const { app, opened } = await bootExpansionServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const response = await app.inject({
			method: "POST",
			url: `/v1/conversations/${root.id}/submissions`,
			payload: { input: "/review concurrency", waitMs: 5000 },
		});
		expect(response.statusCode).toBe(202);
		const view = await readView(app, root.id as number);
		const expanded = view.entries.find(
			(entry) => entry.kind === "sigrun.user.expanded",
		);
		expect(expanded?.data).toEqual({
			typed: "/review concurrency",
			command: "review",
		});
		// The admitted text (what the model saw) is the substituted template.
		const user = view.entries.find((entry) => entry.kind === "sigrun.user.expanded");
		expect(user?.model?.[0]?.content).toEqual([
			{ type: "text", text: "Review with focus: concurrency" },
		]);
	});

	test("a message not starting with / is untouched", async () => {
		const { app, opened } = await bootExpansionServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		await submit(app, root.id as number, "just a message", 5000);
		const view = await readView(app, root.id as number);
		expect(
			view.entries.some((entry) => entry.kind === "sigrun.user.expanded"),
		).toBe(false);
		const user = view.entries.find((entry) => entry.kind === "pi.user");
		expect(user?.model?.[0]?.content).toEqual([
			{ type: "text", text: "just a message" },
		]);
	});

	test("/fork is untouched (a core command keeps its meaning)", async () => {
		const { app, opened } = await bootExpansionServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		// The fork.md template exists in the user dir but collides with the
		// core command: /fork admits verbatim, no expansion entry.
		await submit(app, root.id as number, "/fork", 5000);
		const view = await readView(app, root.id as number);
		expect(
			view.entries.some((entry) => entry.kind === "sigrun.user.expanded"),
		).toBe(false);
		const user = view.entries.find((entry) => entry.kind === "pi.user");
		expect(user?.model?.[0]?.content).toEqual([{ type: "text", text: "/fork" }]);
	});

	test("an unterminated quote in template args is a 400, not a 500 (fix round)", async () => {
		const { app, opened } = await bootExpansionServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		// `/review "oops` is ordinary user input — a malformed submission,
		// never a server crash: the 400 carries the invalid_input shape the
		// rest of the submit path uses, and NOTHING is admitted.
		const response = await app.inject({
			method: "POST",
			url: `/v1/conversations/${root.id}/submissions`,
			payload: { input: "/review \"oops" },
		});
		expect(response.statusCode).toBe(400);
		expect(response.json()).toEqual({ error: "invalid_input" });
		const view = await readView(app, root.id as number);
		expect(view.entries).toHaveLength(0);
	});

	test("an input with attachments expands only the text part", async () => {
		const { app, opened, workspace } = await bootExpansionServer();
		await writeFile(join(workspace, "shot.png"), Buffer.from(RED_PNG, "base64"));
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const response = await app.inject({
			method: "POST",
			url: `/v1/conversations/${root.id}/submissions`,
			payload: {
				input: [
					{ type: "text", text: "/review api" },
					{ type: "image", path: "shot.png", mime: "image/png" },
				],
				waitMs: 5000,
			},
		});
		expect(response.statusCode).toBe(202);
		const view = await readView(app, root.id as number);
		const user = view.entries.find((entry) => entry.kind === "sigrun.user.expanded");
		const content = user?.model?.[0]?.content ?? [];
		expect(content[0]).toEqual({ type: "text", text: "Review with focus: api" });
		// The image part is untouched, in place.
		expect(content[1]?.type).toBe("image");
	});
});
