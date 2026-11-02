/**
 * Task A3 (curator P2 part 1): the per-user learned skills root.
 *
 * A fourth discovery root — `<dataDir>/users/<user>/skills/` — whose
 * precedence is workspace > learned > user dir > package and which
 * exists only for OWNED conversations (ownerless → none). The learned
 * root is resolved from the conversation's `SessionMetaDoc.owner`
 * through the `DocumentReader` the section/tool already carries; the
 * `/skill:name` expansion and the `/v1/commands` catalog resolve the
 * owner from their callers (the submit op / job fire / route).
 *
 * Hermetic pattern: faux provider + tmp workspace + `app.inject()`
 * (curation-attribution.test.ts's shape).
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, Models } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { curationDir, learnedSkillsDir } from "../src/curation/paths.js";
import { expandInput } from "../src/commands/expand.js";
import { fireJob, type JobRuntimeDeps } from "../src/jobs/fire.js";
import { writeJobChange } from "../src/jobs/docs.js";
import { specHash } from "../src/jobs/spec.js";
import { SessionMetaDoc } from "../src/server/session-meta.js";
import { createServer } from "../src/server/index.js";
import { seededIdentity } from "./helpers/identity.js";

// ---------------------------------------------------------------------------
// Boot + drive helpers (curation-attribution.test.ts's shape)
// ---------------------------------------------------------------------------

interface TestServer {
	readonly app: FastifyInstance;
	readonly opened: OpenedHarness;
	readonly dir: string;
}

async function bootServer(
	responses: readonly AssistantMessage[] = [],
): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-learned-"));
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	faux.setResponses([...responses]);
	const contributor: ProviderContributor = {
		name: "ext-faux",
		providers: [{ provider: faux.provider }],
	};
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_AUTH: "none",
		SIGRUN_WORKSPACE_PATH: dir,
		SIGRUN_CONFIG_DIR: join(dir, "config"),
		SIGRUN_DATA_DIR: join(dir, "data"),
		SIGRUN_CACHE_DIR: join(dir, "cache"),
		SIGRUN_STATE_DIR: join(dir, "state"),
	});
	await writeFile(join(dir, "settings.json"), '{"namingModel": false}');
	const opened = await openHarness(config, {
		identity: await seededIdentity(dir),
		extensions: [contributor],
		env: { SIGRUN_CONFIG_DIR: join(dir, "config") },
		settingsDir: dir,
	});
	const app = await createServer(opened, config);
	cleanups.push(async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	});
	return { app, opened, dir };
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

async function createConversation(
	app: FastifyInstance,
	user?: string,
): Promise<number> {
	const response = await app.inject({
		method: "POST",
		url: "/v1/conversations",
		headers: user === undefined ? {} : { "x-sigrun-user": user },
	});
	expect(response.statusCode).toBe(201);
	return response.json().id;
}

async function submitHttp(
	app: FastifyInstance,
	id: number,
	input: string,
	user?: string,
): Promise<Record<string, unknown>> {
	const response = await app.inject({
		method: "POST",
		url: `/v1/conversations/${id}/submissions?waitMs=5000`,
		payload: { input },
		headers: {
			"content-type": "application/json",
			...(user === undefined ? {} : { "x-sigrun-user": user }),
		},
	});
	expect(response.statusCode).toBe(202);
	return response.json().submission;
}

async function commandsFor(
	app: FastifyInstance,
	user?: string,
): Promise<readonly { name: string }[]> {
	const response = await app.inject({
		method: "GET",
		url: "/v1/commands",
		headers: user === undefined ? {} : { "x-sigrun-user": user },
	});
	expect(response.statusCode).toBe(200);
	return response.json().commands;
}

/** Write one learned SKILL.md for a user under the dataDir user area. */
async function writeLearnedSkill(
	dir: string,
	user: string,
	name: string,
	body = "# Learned body\n\nDeploy the acme way.\n",
): Promise<void> {
	const skillDir = join(dir, "data", "users", user, "skills", name);
	await mkdir(skillDir, { recursive: true });
	await writeFile(
		join(skillDir, "SKILL.md"),
		`---\nname: ${name}\ndescription: the acme deploy skill\n---\n${body}`,
	);
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

describe("curation paths", () => {
	test("learnedSkillsDir and curationDir hang off the user area", () => {
		expect(learnedSkillsDir("/data/users/alice")).toBe(
			"/data/users/alice/skills",
		);
		expect(curationDir("/data/users/alice")).toBe(
			"/data/users/alice/curation",
		);
	});
});

// ---------------------------------------------------------------------------
// Discovery: owner resolution through the real server
// ---------------------------------------------------------------------------

describe("learned skills root (P2)", () => {
	test("/v1/commands lists the caller's learned skills only", { timeout: 20_000 }, async () => {
		const server = await bootServer();
		await writeLearnedSkill(server.dir, "alice", "acme-deploy");
		await writeLearnedSkill(server.dir, "bob", "acme-other");
		const alice = await commandsFor(server.app, "alice");
		expect(alice.some((c) => c.name === "skill:acme-deploy")).toBe(true);
		expect(alice.some((c) => c.name === "skill:acme-other")).toBe(false);
		const bob = await commandsFor(server.app, "bob");
		expect(bob.some((c) => c.name === "skill:acme-other")).toBe(true);
		expect(bob.some((c) => c.name === "skill:acme-deploy")).toBe(false);
		// The unidentified caller sees no learned skills at all.
		const anonymous = await commandsFor(server.app);
		expect(anonymous.some((c) => c.name === "skill:acme-deploy")).toBe(false);
		expect(anonymous.some((c) => c.name === "skill:acme-other")).toBe(false);
	});

	test("/skill:acme-deploy expands from the owner's root on HTTP submit", { timeout: 20_000 }, async () => {
		const server = await bootServer([fauxAssistantMessage("expanded answer")]);
		await writeLearnedSkill(server.dir, "alice", "acme-deploy");
		const id = await createConversation(server.app, "alice");
		const record = await submitHttp(
			server.app,
			id,
			"/skill:acme-deploy now",
			"alice",
		);
		expect(record.status).toBe("done");
		const conversation = await server.opened.harness.conversation(
			id as ConversationId,
			BACKGROUND_CONTEXT,
		);
		const page = await conversation!.entries({}, 100, undefined, BACKGROUND_CONTEXT);
		const userEntry = page.items.find(
			(entry) => entry.kind === "sigrun.user.expanded",
		);
		expect(userEntry).toBeDefined();
		// The expanded entry records the typed command; the admitted text
		// carries the learned body's expansion shape.
		expect(
			(userEntry!.data as { command?: string }).command,
		).toBe("skill:acme-deploy");
	});

	test("/skill:acme-deploy expands from the job owner's root on fire", { timeout: 20_000 }, async () => {
		const server = await bootServer([fauxAssistantMessage("job done")]);
		const { opened } = server;
		await writeLearnedSkill(server.dir, "alice", "acme-deploy");
		const conversation = await opened.harness.createConversation(
			{ ownership: { kind: "ownerless" }, agent: { model: opened.defaultModel } },
			BACKGROUND_CONTEXT,
		);
		// The job's fixed conversation carries alice as owner (the auth hook
		// stamps owners on HTTP creates; a job-created conversation takes
		// the job owner through the same meta doc).
		await opened.harness.commit(async (tx) => {
			const meta = await tx.doc(SessionMetaDoc, conversation.id);
			meta.owner = "alice";
		}, BACKGROUND_CONTEXT);
		const fireKey = "nightly:2026-10-31T12:00:00.000Z";
		const spec = {
			name: "nightly",
			schedule: { every: "60s" as const },
			action: {
				kind: "prompt" as const,
				prompt: "/skill:acme-deploy",
				conversation: conversation.id as number,
			},
		};
		const now = Date.parse("2026-10-31T12:00:00.000Z");
		await opened.harness.commit(async (tx) => {
			await writeJobChange(
				tx,
				"nightly",
				{
					source: "api",
					spec,
					owner: "alice",
					enabled: true,
					createdAt: new Date(now).toISOString(),
					hash: specHash("nightly", spec),
					state: "waiting",
				},
				"alice",
				new Date(now).toISOString(),
			);
		}, BACKGROUND_CONTEXT);
		const deps: JobRuntimeDeps = {
			harness: opened.harness,
			storage: opened.storage,
			registry: opened.registry,
			models: opened.models as Models,
			defaultModel: opened.defaultModel,
			now: () => now,
			defaultTz: "UTC",
			gatewayLoaded: false,
			commandExpansion: opened.commandExpansion,
			envBuilder: opened.envBuilder,
		};
		const result = await fireJob(deps, "nightly", fireKey, now, BACKGROUND_CONTEXT);
		expect(result).toMatchObject({ outcome: "running" });
		// The learned skill expanded: the admitted user entry's text is the
		// <skill> block, not the raw "/skill:acme-deploy" prompt. Poll for
		// the entry (the fire admits asynchronously through the job's task).
		let texts: string[] = [];
		const deadline = Date.now() + 10_000;
		for (;;) {
			const page = await conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
			texts = page.items
				.filter((entry) => entry.kind === "pi.user")
				.map((entry) => JSON.stringify(entry));
			if (texts.some((text) => text.includes("acme-deploy"))) break;
			if (Date.now() > deadline) break;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		// The expanded block carries the learned body and the <skill> tag.
		expect(
			texts.some(
				(text) =>
					text.includes("<skill name=\"acme-deploy\"") ||
					text.includes("Deploy the acme way."),
			),
		).toBe(true);
	});

	test("expandInput passes an owner through to the learned root", { timeout: 20_000 }, async () => {
		// The owner parameter selects the learned root: alice's expansion
		// finds the skill, bob's passes through unchanged.
		const dir = await mkdtemp(join(tmpdir(), "sigrun-learned-expand-"));
		cleanups.push(() => rm(dir, { recursive: true, force: true }));
		await writeLearnedSkill(dir, "alice", "acme-deploy");
		const expansion = {
			skills: {
				userDir: join(dir, "absent-user-dir"),
				learnedRoot: (owner: string | undefined) =>
					owner === undefined
						? undefined
						: join(dir, "data", "users", owner, "skills"),
				packageRoots: () => [],
				sectionMaxBytes: () => 4096,
			},
			templates: {
				userDir: join(dir, "absent-prompts"),
				packageRoots: () => [],
			},
			commandNames: () => new Set<string>(),
		};
		const alice = await expandInput(
			[{ type: "text", text: "/skill:acme-deploy go" }],
			expansion,
			undefined,
			BACKGROUND_CONTEXT,
			"alice",
		);
		const text = alice.parts[0];
		expect(text?.type).toBe("text");
		expect(text?.type === "text" && text.text).toContain(
			'<skill name="acme-deploy"',
		);
		expect(text?.type === "text" && text.text).toContain("Deploy the acme way.");
		expect(text?.type === "text" && text.text).toContain("go");
		const bob = await expandInput(
			[{ type: "text", text: "/skill:acme-deploy go" }],
			expansion,
			undefined,
			BACKGROUND_CONTEXT,
			"bob",
		);
		expect(bob.parts[0]).toEqual({ type: "text", text: "/skill:acme-deploy go" });
	});
});
