/**
 * Knowledge Task 12: the whole-system end-to-end — core's published-hook
 * registry and curation C5 read tools + review requests, the curator
 * worktree build (with the wantsReview consultation) loaded through the
 * built-in replacement rule (src/harness/builtins.ts), the recall
 * worktree build (published hooks recall.index/remove/search + the
 * auto-recall injection), and the knowledge worktree build (research
 * flag, curation target, knowledge_find/knowledge_record, recall
 * mirroring), all through ONE real server.
 *
 * The scenario (the plan's verbatim chain):
 *
 *  1. alice's conversation calls the fake research tool `acme/search`
 *     (knowledge's default research globs match `*​/search*`) and the
 *     model answers — FEWER than 10 model calls, so the curator's
 *     threshold never fires: the review happens because the knowledge
 *     target's `wantsReview` answers true (the research flag);
 *  2. the review fork calls `knowledge_find` (the target's read tool —
 *     never wrapped) then `knowledge_record` (the target's write tool —
 *     wrapped outside a run, real inside one), which applies the
 *     record, reports `details.curation`, and mirrors the entity into
 *     recall through `recall.index`;
 *  3. the curator reports the review: one core notice whose title
 *     carries the `recorded …` summary (notices' `Learned:` prefix);
 *  4. alice's NEW conversation's next request gets the entity's card in
 *     its auto-recall block with a `d:` handle (the injected user
 *     message the faux provider sees);
 *  5. `undoReview` (the notice action, the view's Undo) runs the
 *     target's undo: the entity is archived and `recall.remove` removes
 *     it — a fresh recall.search returns no `d:`-handle hits.
 *
 * The test's `acme/search` research tool is the fixture extension
 * `test/fixtures/fixture-research` (no network): a real extension of
 * package "acme-research" so the tool name itself matches the research
 * globs.
 *
 * Async discipline mirrors curation-e2e: loop 1 enqueues and the review
 * completes on the per-user queue outside the settle handler, so the
 * suite waits on OBSERVABLE EFFECTS with bounded waits (the notice pile,
 * the recall search, the faux provider's captured requests), never on
 * internals.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type FauxProviderHandle,
} from "@earendil-works/pi-ai/providers/faux";
import type { FastifyInstance } from "fastify";
import type { JsonObject } from "@earendil-works/pi-durable";
import { loadConfig, type SigrunConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { createServer } from "../src/server/index.js";
import { seededIdentity } from "./helpers/identity.js";

/**
 * The three real worktree builds, loaded by file path (the plan's Task
 * 12 rule). Each is a pathToFileURL of the entry's dist/index.js — the
 * same-URL module identity the curation-e2e memory entry established.
 * The curator entry's package name (@sigrun/ext-curator) matches the
 * built-in specifier, so the replacement rule swaps the built-in
 * curator for THIS build.
 */
const CURATOR_ENTRY = pathToFileURL(
	join(
		import.meta.dirname,
		"..",
		"..",
		"sigrun-ext-curator-knowledge",
		"dist",
		"index.js",
	),
).href;
const RECALL_ENTRY = pathToFileURL(
	join(
		import.meta.dirname,
		"..",
		"..",
		"sigrun-recall-knowledge",
		"dist",
		"index.js",
	),
).href;
const KNOWLEDGE_ENTRY = pathToFileURL(
	join(import.meta.dirname, "..", "..", "sigrun-knowledge", "dist", "index.js"),
).href;
const RESEARCH_ENTRY = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-research", "index.js"),
).href;

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) {
		try {
			await teardown();
		} catch (error) {
			console.error("knowledge-e2e teardown failed", error);
		}
	}
}, 180_000);

interface TestServer {
	readonly app: FastifyInstance;
	readonly opened: OpenedHarness;
	readonly config: SigrunConfig;
	readonly faux: FauxProviderHandle;
	readonly dir: string;
	readonly tokens: Readonly<Record<"alice" | "bob", string>>;
}

/**
 * One real server: the harness + the faux provider + the Fastify app,
 * with the three knowledge-plan builds as the configured extension list
 * and built-ins on (the curator slot replaced by the worktree build).
 */
async function bootServer(
	responses: readonly (AssistantMessage | ((ctx: { messages: Message[] }) => AssistantMessage))[],
): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-knowledge-e2e-"));
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000, reasoning: true }],
	});
	faux.setResponses([...responses]);
	const contributor: ProviderContributor = {
		name: "ext-faux",
		providers: [{ provider: faux.provider }],
	};
	const env = {
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
		SIGRUN_CONFIG_DIR: join(dir, "config"),
		SIGRUN_DATA_DIR: join(dir, "data"),
		SIGRUN_STATE_DIR: join(dir, "state"),
		SIGRUN_CACHE_DIR: join(dir, "cache"),
		SIGRUN_AUTH: "token",
	};
	const config = loadConfig(env);
	await writeFile(
		join(dir, "settings.json"),
		JSON.stringify({ namingModel: false }),
		"utf8",
	);
	const identity = await seededIdentity(dir);
	await identity.users.add({ user: "alice", name: "Alice", admin: false, source: "cli" });
	await identity.users.add({ user: "bob", name: "Bob", admin: false, source: "cli" });
	const opened = await openHarness(config, {
		identity,
		extensions: [contributor],
		builtins: true,
		env,
		settingsDir: dir,
		extensionSpecifiers: [
			RECALL_ENTRY,
			KNOWLEDGE_ENTRY,
			CURATOR_ENTRY,
			RESEARCH_ENTRY,
		],
	});
	const mint = async (user: string): Promise<string> =>
		(await opened.identity.tokens.create("e2e", user)).token;
	const tokens = { alice: await mint("alice"), bob: await mint("bob") };
	const app = await createServer(opened, config);
	cleanups.push(async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	});
	return { app, opened, config, faux, dir, tokens };
}

function auth(tokens: Readonly<Record<string, string>>, user: string) {
	return { authorization: `Bearer ${tokens[user]}` };
}

function authJson(tokens: Readonly<Record<string, string>>, user: string) {
	return { ...auth(tokens, user), "content-type": "application/json" };
}

async function createConversation(server: TestServer, user: string): Promise<number> {
	const response = await server.app.inject({
		method: "POST",
		url: "/v1/conversations",
		headers: auth(server.tokens, user),
	});
	expect(response.statusCode).toBe(201);
	return response.json().id as number;
}

async function submit(
	server: TestServer,
	id: number,
	input: string,
	user: string,
): Promise<{ status: string }> {
	const response = await server.app.inject({
		method: "POST",
		url: `/v1/conversations/${id}/submissions?waitMs=10000`,
		payload: { input },
		headers: authJson(server.tokens, user),
	});
	expect(response.statusCode).toBe(202);
	return response.json().submission as { status: string };
}

/** Await an observable effect (bounded): poll until non-undefined. */
async function waitFor<T>(
	probe: () => Promise<T | undefined>,
	label: string,
): Promise<T> {
	const deadline = Date.now() + 20_000;
	for (;;) {
		const found = await probe();
		if (found !== undefined) return found;
		if (Date.now() > deadline) {
			throw new Error(`timed out waiting for ${label}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

/**
 * recall.search through the knowledge extension's seam host (the
 * extension-to-extension call path — the registry attributes the call to
 * the caller; the seam host's surface awaits the registry-ready
 * deferred). The assertion narrows to `d:`-handle hits because the
 * parent conversation's own transcript capture also matches the query
 * (r: handles) — the card is the doc hit.
 */
async function recallSearch(
	server: TestServer,
	query: string,
): Promise<{ hits: { handle: string; title: string; snippet: string }[] }> {
	const host = server.opened.seamHosts.get("knowledge");
	expect(host).toBeDefined();
	const result = await host!.publishedHooks.call(
		"recall.search",
		{ query, kinds: ["doc"] },
		{ user: "alice" },
	);
	if (result.status !== "ok") {
		throw new Error(`recall.search did not answer ok: ${JSON.stringify(result)}`);
	}
	return result.value as never;
}

describe("the whole knowledge plan (research → review → record → recall)", () => {
	test(
		"alice's research settle reviews via wantsReview, records knowledge, injects it in a new conversation, and undo removes it",
		{ timeout: 90_000 },
		async () => {
			// The scripted model, in strict order:
			//  1-2. alice's conversation: the acme/search call, then the answer.
			//  3-5. the review fork: knowledge_find, knowledge_record, final text.
			//  6.   the NEW conversation's turn (its request carries the block —
			//      the factory asserts it and returns the final answer).
			//  7.   bob's negative-control conversation (a plain answer).
			const RECORD_ARGS: JsonObject = {
				inquiry: { question: "a vet for Biscuit's knee" },
				types: [
					{
						name: "vet clinic",
						description: "A veterinary clinic.",
						fields: [
							{ name: "phone", type: "string", identity: true },
							{ name: "exam fee", type: "money", horizonDays: 30 },
						],
					},
				],
				entities: [
					{
						type: "vet clinic",
						name: "Northside",
						keys: { phone: "555-0142" },
						fields: {
							"exam fee": {
								value: { amount: 80, currency: "CAD" },
								source: "r:1",
								observedAt: "2026-11-01",
							},
						},
						role: "candidate",
					},
				],
			};

			let injectedBlock: string | undefined;
			const server = await bootServer([
				fauxAssistantMessage(
					[fauxToolCall("acme/search", { query: "northside vet exam fee" })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Northside charges 80 CAD for an exam."),
				// The review: knowledge_find first (de-duplicate), then record.
				fauxAssistantMessage(
					[fauxToolCall("knowledge_find", { queries: [{ text: "Northside" }] } as JsonObject)],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(
					[fauxToolCall("knowledge_record", RECORD_ARGS)],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("review done"),
				// The NEW conversation's request: the faux factory captures the
				// injected auto-recall block and answers.
				(context) => {
					const messages = (context as { messages: Message[] }).messages;
					const newest = messages.findLast((message) => message.role === "user");
					const parts =
						typeof newest?.content === "string"
							? [{ type: "text", text: newest.content }]
							: ((newest?.content ?? []) as { type: string; text?: string }[]);
					const block = parts.find((part) =>
						part.text?.includes("Recalled from past conversations"),
					)?.text;
					injectedBlock = block;
					return fauxAssistantMessage("I already know: Northside.");
				},
				// Bob's negative-control turn: a plain answer, no tools.
				fauxAssistantMessage("Just chatting back."),
			]);
			const { app } = server;

			// The inventory: all three extensions loaded, and the curator is
			// the WORKTREE build (the built-in row reports replaced).
			const inventory = await app.inject({
				method: "GET",
				url: "/v1/extensions",
				headers: auth(server.tokens, "alice"),
			});
			expect(inventory.statusCode).toBe(200);
			const rows = inventory.json().extensions as {
				name: string;
				status: string;
			}[];
			expect(rows.find((row) => row.name === "recall")?.status).toBe("ok");
			expect(rows.find((row) => row.name === "knowledge")?.status).toBe("ok");
			expect(rows.find((row) => row.name === "curator")?.status).toBe("ok");

			// The knowledge curation target is served for alice with its
			// declared read tool.
			const targets = await app.hostBridge.curation.targets("alice");
			const knowledge = targets.find((entry) => entry.id.endsWith(":knowledge"));
			expect(knowledge?.tools).toEqual(["knowledge_record"]);
			expect(knowledge?.readTools).toEqual(["knowledge_find"]);

			// 1. alice's research conversation: the acme/search call (the
			//    fixture answers it) then the model's answer — two model
			//    calls, below the threshold. The settle enqueues the review
			//    because the knowledge target's wantsReview answers true.
			const first = await createConversation(server, "alice");
			const settled = await submit(
				server,
				first,
				"northside research please",
				"alice",
			);
			expect(settled.status).toBe("done");
			// The review must have fired via wantsReview, NOT the threshold:
			// the parent's model-call count stays below the curator's
			// threshold (10) — two calls (the tool call + the answer).
			expect(
				await server.app.hostBridge.curation.modelCallsSince(
					first as never,
				),
				// Two calls (the tool call + the answer) — the exact count pins
				// the below-threshold premise; < 10 alone would stay green if
				// the curator's default threshold ever dropped to ≤ 2.
			).toBe(2);

			// 3. the curator reports: ONE core notice for alice on this
			//    conversation, titled with the record's `recorded …` summary.
			const notice = await waitFor(async () => {
				const response = await app.inject({
					method: "GET",
					url: "/v1/notices",
					headers: auth(server.tokens, "alice"),
				});
				expect(response.statusCode).toBe(200);
				const pile = response.json().notices as {
					key?: string;
					owner: string;
					conversationId?: number;
					title: string;
				}[];
				return pile.find(
					(row) => row.owner === "curator" && row.conversationId === first,
				);
			}, "the curator notice for the research review");
			expect(notice.key).toMatch(/^review:/);
			expect(notice.title).toContain("Learned: recorded");
			// The summary names the inquiry (applyRecord's shape:
			// `recorded <inquiry>: N <types>`).
			expect(notice.title).toContain("Biscuit");

			// The record is IN recall now: a doc hit with a d: handle.
			const before = await waitFor(async () => {
				const result = await recallSearch(server, "Northside");
				return result.hits.find((hit) => hit.handle.startsWith("d:"));
			}, "the knowledge card in recall.search");
			expect(before.title).toContain("Northside");

			// 4. alice's NEW conversation: the next request's newest user
			//    message carries the auto-recall block citing the card.
			const second = await createConversation(server, "alice");
			const again = await submit(
				server,
				second,
				"Northside?",
				"alice",
			);
			expect(again.status).toBe("done");
			expect(injectedBlock).toBeDefined();

			// Negative control: bob's below-threshold conversation with no
			// research tool call never produces a curator notice — if a
			// threshold bug fired reviews anyway, bob's settle would post
			// one (the scripted response order would also derail).
			const control = await createConversation(server, "bob");
			const controlSettled = await submit(
				server,
				control,
				"just a chat",
				"bob",
			);
			expect(controlSettled.status).toBe("done");
			// Poll for the same window the positive control waits (20 s cap,
			// the settled-notice grace in between), asserting the absence
			// HELD over time rather than at one instant.
			const graceOver = Date.now() + 2_000;
			let bobPile: { owner: string; conversationId?: number }[] = [];
			while (Date.now() < graceOver) {
				const controlNotices = await app.inject({
					method: "GET",
					url: "/v1/notices",
					headers: auth(server.tokens, "bob"),
				});
				expect(controlNotices.statusCode).toBe(200);
				bobPile = controlNotices.json().notices as {
					owner: string;
					conversationId?: number;
				}[];
				expect(
					bobPile.filter(
						(row) => row.owner === "curator" && row.conversationId === control,
					),
				).toEqual([]);
				await new Promise((resolve) => setTimeout(resolve, 250));
			}
			expect(injectedBlock).toContain("Northside");
			expect(injectedBlock).toMatch(/\bd:\d+/);

			// 5. undoReview through the notice action (payload {reviewId} —
			//    the notice key is `review:<reviewId>`).
			const notices = await app.inject({
				method: "GET",
				url: "/v1/notices",
				headers: auth(server.tokens, "alice"),
			});
			const row = (notices.json().notices as { id: string; key?: string }[]).find(
				(entry) => entry.key === notice.key,
			);
			expect(row).toBeDefined();
			const undo = await app.inject({
				method: "POST",
				url: `/v1/notices/${row!.id}/actions/undo`,
				payload: {},
				headers: authJson(server.tokens, "alice"),
			});
			expect(undo.statusCode).toBe(200);
			expect(undo.json().ok).toBe(true);
			expect(String(undo.json().message ?? undo.json().toast)).toContain("Undid");

			// The undo removed the card from recall search.
			await waitFor(async () => {
				const result = await recallSearch(server, "Northside");
				return result.hits.some((hit) => hit.handle.startsWith("d:"))
					? undefined
					: true;
			}, "the knowledge card gone from recall.search after undo");
		},
	);
});
