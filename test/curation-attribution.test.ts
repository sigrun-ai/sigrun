/**
 * Task A1 (curator P1): message attribution — every user input records
 * the submitting user through every admission path.
 *
 * The carrier is the `sigrun.authors` conversation doc (`byRequest` +
 * `bySubmission`): `byRequest` is written BEFORE `conversation.submit`
 * (the requestId exists pre-admission, so it never races), `bySubmission`
 * right after (the key the LiveDoc run inputs use, readable from a tool).
 *
 * Admission paths pinned here: HTTP submit (the principal),
 * `host.conversations.submit` (`opts.user` verbatim — driven through the
 * host bridge the seam hosts delegate to, the W5 test pattern), a job
 * fire (the job's owner), and a block answer (the acting user). Plus the
 * read side: `authorOfSubmission` from a bare `DocumentReader`, the
 * generated `sigrun:` requestId for callers that pass none, and the
 * fail-closed `undefined` for entries admitted before attribution.
 *
 * Hermetic pattern: faux provider + tmp workspace + `app.inject()` (see
 * naming.test.ts); the job test builds `JobRuntimeDeps` directly (the
 * submit-turn-callers.test.ts rig shape).
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, Models } from "@earendil-works/pi-ai";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type FauxProviderHandle,
} from "@earendil-works/pi-ai/providers/faux";
import type {
	ConversationId,
	EntryId,
	SubmissionId,
	SubmissionRecord,
} from "@earendil-works/pi-durable";
import type { Tree, JsonObject } from "@sigrun/shared/blocks";
import type { JobSpec } from "@sigrun/shared/jobs";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import {
	authorOfSubmission,
	authorsOfEntries,
} from "../src/curation/attribution.js";
import { fireJob, type JobRuntimeDeps } from "../src/jobs/fire.js";
import { writeJobChange } from "../src/jobs/docs.js";
import { specHash } from "../src/jobs/spec.js";
import { createServer } from "../src/server/index.js";
import { seededIdentity } from "./helpers/identity.js";

// ---------------------------------------------------------------------------
// Boot + drive helpers
// ---------------------------------------------------------------------------

/** One hermetic server: harness + faux provider + Fastify app. */
interface TestServer {
	readonly app: FastifyInstance;
	readonly opened: OpenedHarness;
	readonly faux: FauxProviderHandle;
	readonly dir: string;
}

/** Boot a hermetic server in a tmpdir; registers cleanup. */
async function bootServer(
	responses: readonly AssistantMessage[] = [],
): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-attribution-"));
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
	});
	// Naming off: every submit then consumes exactly one faux response.
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
	return { app, opened, faux, dir };
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

/** Create one conversation over HTTP, optionally as an identified caller. */
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

/** Submit one input over HTTP (the §7.1 bounded wait); returns the record. */
async function submitHttp(
	app: FastifyInstance,
	id: number,
	input: string,
	user?: string,
): Promise<SubmissionRecord & Record<string, unknown>> {
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

/**
 * Poll the durable submissions until `requestId` carries an entry (placed
 * or settled — both link the entry attribution resolves through).
 */
async function waitForEntry(
	opened: OpenedHarness,
	conversationId: number,
	requestId: string,
): Promise<SubmissionRecord> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		const page = await opened.storage.scanSubmissions(
			{ conversationId: conversationId as ConversationId, order: "ascending" },
			100,
			undefined,
			BACKGROUND_CONTEXT,
		);
		const record = page.items.find((item) => item.requestId === requestId);
		if (record?.entry !== undefined) return record;
		if (Date.now() > deadline) {
			throw new Error(`submission ${requestId} never placed an entry`);
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

/** The author of one entry (a typed get: the map's presence is the point). */
async function authorOf(
	opened: OpenedHarness,
	conversationId: number,
	entry: EntryId,
): Promise<string | undefined> {
	const authors = await authorsOfEntries(
		opened.harness,
		conversationId as ConversationId,
		BACKGROUND_CONTEXT,
	);
	return authors.get(entry);
}

// ---------------------------------------------------------------------------
// The admission paths
// ---------------------------------------------------------------------------

describe("message attribution (curator P1)", () => {
	test("HTTP submit records the principal as author", { timeout: 20_000 }, async () => {
		const server = await bootServer([fauxAssistantMessage("http answer")]);
		const id = await createConversation(server.app, "alice");
		const record = await submitHttp(server.app, id, "hello", "alice");
		expect(record.status).toBe("done");
		expect(await authorOf(server.opened, id, record.entry as EntryId)).toBe(
			"alice",
		);
	});

	test("host submit records opts.user verbatim", { timeout: 20_000 }, async () => {
		const server = await bootServer([fauxAssistantMessage("bridge answer")]);
		const id = await createConversation(server.app);
		// The host bridge: the surface every seam host's `conversations`
		// delegates to (the W5 in-process path — blocks-notes.test.ts's shape).
		const record = await server.app.hostBridge.conversations.submit(
			id as ConversationId,
			[{ type: "text", text: "from the bridge" }],
			{ user: "bob" },
		);
		const settled = await waitForEntry(
			server.opened,
			id,
			record.requestId!,
		);
		expect(await authorOf(server.opened, id, settled.entry!)).toBe("bob");
	});

	test("job fire records the job owner", { timeout: 20_000 }, async () => {
		const server = await bootServer([fauxAssistantMessage("job done")]);
		const { opened } = server;
		const conversation = await opened.harness.createConversation(
			{ ownership: { kind: "ownerless" }, agent: { model: opened.defaultModel } },
			BACKGROUND_CONTEXT,
		);
		const fireKey = "nightly:2026-10-31T12:00:00.000Z";
		const spec: JobSpec = {
			name: "nightly",
			schedule: { every: "60s" },
			action: {
				kind: "prompt",
				prompt: "run the job",
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
			// Escalations A1a: ownerless jobs resolve at use time; the fixture
			// resolver passes owners through unchanged.
			effectiveOwner: (owner) => owner,
			harness: opened.harness,
			storage: opened.storage,
			registry: opened.registry,
			models: opened.models as Models,
			defaultModel: opened.defaultModel,
			now: () => now,
			defaultTz: "UTC",
			gatewayLoaded: false,
		};
		const result = await fireJob(deps, "nightly", fireKey, now, BACKGROUND_CONTEXT);
		expect(result).toMatchObject({
			outcome: "running",
			conversationId: conversation.id as number,
		});
		const settled = await waitForEntry(
			opened,
			conversation.id as number,
			`job:${fireKey}`,
		);
		expect(await authorOf(opened, conversation.id as number, settled.entry!)).toBe(
			"alice",
		);
	});

	test("block answer records the answering user", { timeout: 20_000 }, async () => {
		const server = await bootServer();
		const { app, opened, faux } = server;
		const conversationId = await createConversation(app, "alice");
		// Alice's run shows a ranking block with a turn-starting submit.
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("show_blocks", {
						title: "Ranking",
						tree: RANKING_TREE as unknown as JsonObject,
						data: RANKING_DATA,
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("shown"),
			fauxAssistantMessage("order used"),
		]);
		const conversation = await opened.harness.conversation(
			conversationId as ConversationId,
			BACKGROUND_CONTEXT,
		);
		const shown = await conversation!.submit(
			{ type: "input", content: "show the block" },
			BACKGROUND_CONTEXT,
		);
		await shown.wait(BACKGROUND_CONTEXT);
		const page = await conversation!.entries(
			{},
			100,
			undefined,
			BACKGROUND_CONTEXT,
		);
		const blockEntry = page.items.find(
			(entry) => entry.kind === "sigrun.blocks",
		);
		expect(blockEntry).toBeDefined();
		// Alice shares the conversation household-write so bob may act.
		const shared = await app.inject({
			method: "PATCH",
			url: `/v1/conversations/${conversationId}/meta`,
			payload: { sharing: { scope: "household", level: "write" } },
			headers: { "x-sigrun-user": "alice", "content-type": "application/json" },
		});
		expect(shared.statusCode).toBe(200);
		// Bob answers the block (the form's submit, turn default true).
		const answer = await app.inject({
			method: "POST",
			url: `/v1/conversations/${conversationId}/blocks/${blockEntry!.id}/actions`,
			payload: { action: "useOrder", payload: { values: {} }, actionId: "act-1" },
			headers: { "x-sigrun-user": "bob", "content-type": "application/json" },
		});
		expect(answer.statusCode).toBe(200);
		const settled = await waitForEntry(
			opened,
			conversationId,
			"blocks:act-1",
		);
		expect(await authorOf(opened, conversationId, settled.entry!)).toBe("bob");
	});

	// -------------------------------------------------------------------
	// The read side
	// -------------------------------------------------------------------

	test("authorOfSubmission reads bySubmission from a DocumentReader", { timeout: 20_000 }, async () => {
		const server = await bootServer([fauxAssistantMessage("read side")]);
		const id = await createConversation(server.app, "alice");
		const record = await submitHttp(server.app, id, "hello", "alice");
		// The bare DocumentReader surface a tool's ToolExecutionApi extends.
		expect(
			await authorOfSubmission(
				server.opened.harness,
				id as ConversationId,
				record.id as SubmissionId,
				BACKGROUND_CONTEXT,
			),
		).toBe("alice");
	});

	test("missing requestId is generated with the sigrun: prefix", { timeout: 20_000 }, async () => {
		const server = await bootServer([fauxAssistantMessage("gen id")]);
		const id = await createConversation(server.app, "alice");
		const record = await submitHttp(server.app, id, "hello", "alice");
		expect(record.requestId).toMatch(/^sigrun:[0-9a-f-]{36}$/);
	});

	test("entries before attribution read as unattributed", { timeout: 20_000 }, async () => {
		const server = await bootServer([fauxAssistantMessage("raw answer")]);
		const conversation = await server.opened.harness.createConversation(
			{ ownership: { kind: "ownerless" }, agent: { model: server.opened.defaultModel } },
			BACKGROUND_CONTEXT,
		);
		// A raw admission: no submitOp, no recordAuthor — the entry maps to
		// undefined (present key, absent author: fail closed, never guess).
		const submission = await conversation.submit(
			{ type: "input", content: "raw input" },
			BACKGROUND_CONTEXT,
		);
		const settled = await submission.wait(BACKGROUND_CONTEXT);
		const authors = await authorsOfEntries(
			server.opened.harness,
			conversation.id,
			BACKGROUND_CONTEXT,
		);
		// `settled.entry` is EntryId | undefined on the record type but
		// always placed once settled (the wait helper's guarantee).
		expect(authors.has(settled.entry!)).toBe(true);
		expect(authors.get(settled.entry!)).toBeUndefined();
	});
});

/** The §8.5 ranking block with a "Use this order" submit (turn default). */
const RANKING_TREE: Tree = {
	v: 1,
	root: {
		type: "section",
		title: "Ranking",
		children: [
			{
				type: "collection",
				id: "ranking",
				items: { $: "/cards" },
				display: "list",
				numbered: true,
				reorder: { within: true },
				onMove: "reorderCards",
				item: { title: { $: "./title" } },
			},
			{
				type: "form",
				id: "use-order",
				bind: "/order",
				mode: "submit",
				onSubmit: "useOrder",
				submitLabel: "Use this order",
				children: [],
			},
		],
	},
};

const RANKING_DATA: JsonObject = {
	cards: [
		{ id: "c1", title: "Arabesque" },
		{ id: "c2", title: "Gymnopédie" },
	],
};
