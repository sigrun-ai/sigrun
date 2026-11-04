/**
 * Task D1: the end-to-end curator path — core + the curator BUILT-IN +
 * @sigrun/memory-markdown as a CONFIGURED extension (the token-method
 * boot from sharing.test.ts, with `builtins: true` so the curator
 * extension loads as a real built-in), one real server, the faux
 * provider scripting EVERY model turn (the parent's answers, the
 * review's tool calls, the review's final text — namingModel off).
 *
 * The seven scenarios are the observable OUTCOMES (the B suites tested
 * the internals; this file drives the whole stack through HTTP and the
 * filesystem only):
 *
 *  1. the memory target registers as `<slug>:memory` — the slug from
 *     `GET /v1/extensions`;
 *  2. a conversation call to `memory_write` becomes a HINT and writes
 *     nothing (the transcript's own tool result is the hint contract
 *     text); the same settle's fork review then writes USER.md
 *     (OWNER-ONLY conversation — the fork-review path. A mixed
 *     conversation digests nothing today: the digests step's per-entry
 *     attribution path is dead against current core, whose structural
 *     view does not mount `sigrun.authors` — ruled fail-closed in the
 *     task ledger, so a mixed-conversation digest write is known-noop
 *     and deliberately not tested here);
 *  3. alice runs 10 model calls → a fork review creates `acme-deploy`
 *     and a USER.md entry → ONE core notice → undo from the curator
 *     VIEW reverts both;
 *  4. bob's conversations never show alice's skill or memory, before
 *     or after;
 *  5. the fork never appears in alice's conversation list or event
 *     stream (internal runs are invisible, P5);
 *  6. after a curator write, alice's OTHER open conversation gets ONE
 *     `pi.system` tail patch on its next request, and its FIRST system
 *     entry (the baseline) is unchanged (the cache-parity contract);
 *  7. `skill_manage` called by bob in alice's write-shared
 *     conversation leaves no hint (P9's owner-authored gate).
 *
 * Async discipline: loop 1 enqueues; the review completes on the
 * per-user queue OUTSIDE the settle handler. The seam is observable
 * effects with bounded waits (`waitFor` below, 20 s deadline): the
 * skill file on disk, the ambient record, the memory file. The faux
 * responses are consumed strictly in order, so each test scripts
 * exactly the turns its conversations produce and waits for each async
 * phase before driving the next.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import http from "node:http";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { FastifyInstance } from "fastify";
import type {
	ConversationId,
	EntryRecord,
	JsonObject,
} from "@earendil-works/pi-durable";
import { SystemEntry, ToolResultEntry } from "@earendil-works/pi-durable";
import { loadConfig, type SigrunConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import {
	HINT_NOT_RECORDED_TEXT,
	HINT_NOTED_TEXT,
	HintsDoc,
} from "../src/curation/wrap.js";
import { createServer } from "../src/server/index.js";
import { seededIdentity } from "./helpers/identity.js";

/**
 * memory-markdown's entry through the symlinked dev dependency
 * (`node_modules/@sigrun/memory-markdown` → the curation worktree). A
 * file:// URL, not a bare specifier, so the test's dynamic import (if
 * any) lands the exact module instance the LOADER imports (same-URL
 * module identity — the curation-host pattern), never vitest's own
 * resolution.
 */
const MEMORY_ENTRY = pathToFileURL(
	join(
		import.meta.dirname,
		"..",
		"node_modules",
		"@sigrun",
		"memory-markdown",
		"dist",
		"index.js",
	),
).href;

/** The learned-skill body the review's `skill_manage` call creates. */
const ACME_SKILL =
	"---\nname: acme-deploy\ndescription: Deploy acme\n---\n# Deploy\n\nDeploy the acme way.\n";

/** The USER.md entry the review's `memory_write` call adds. */
const USER_ENTRY = "Prefers blue/green deploys.";

/** memory-markdown's per-user dir under the server's data root. */
const memoryUserDir = (dir: string, user: string): string =>
	join(dir, "data", "sigrun-memory", "users", user);

/** The learned-skill file path under the per-user skills root. */
const skillPath = (dir: string, user: string, name: string): string =>
	join(dir, "data", "users", user, "skills", name, "SKILL.md");

const cleanups: Array<() => Promise<void>> = [];
// The suite boots several real servers; each close waits on the harness.
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) { try { await teardown(); } catch {} }
}, 180_000);

/** One real server: harness + faux provider + Fastify app. */
interface TestServer {
	readonly app: FastifyInstance;
	readonly opened: OpenedHarness;
	readonly config: SigrunConfig;
	readonly dir: string;
	/** Tokens for the two users (the token method's credentials). */
	readonly tokens: Readonly<Record<"alice" | "bob", string>>;
	/** The loopback port (0 = never listened — inject-only servers). */
	readonly port: number;
}

/** Boot one real server with the curator built-in + memory-markdown. */
async function bootServer(
	responses: readonly AssistantMessage[],
	options?: { readonly listen?: boolean },
): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-curation-e2e-"));
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
		// State + cache stay in the tmpdir too: the curator's per-user
		// state (cursors, notices) and the extension cache otherwise land
		// on the HOST defaults under the real home — cross-test pollution
		// the way the sharing suite pins every root.
		SIGRUN_STATE_DIR: join(dir, "state"),
		SIGRUN_CACHE_DIR: join(dir, "cache"),
		SIGRUN_AUTH: "token",
	};
	const config = loadConfig(env);
	// Naming off: the naming model would otherwise consume scripted
	// responses (every other suite's rule).
	await writeFile(
		join(dir, "settings.json"),
		JSON.stringify({ namingModel: false }),
		"utf8",
	);
	const identity = await seededIdentity(dir);
	// alice and bob are the curated users (the brief's literals).
	await identity.users.add({ user: "alice", name: "Alice", admin: false, source: "cli" });
	await identity.users.add({ user: "bob", name: "Bob", admin: false, source: "cli" });
	const opened = await openHarness(config, {
		identity,
		extensions: [contributor],
		// The curator built-in LOADS (the stack under test).
		builtins: true,
		env,
		settingsDir: dir,
		// memory-markdown as a CONFIGURED extension (the hermetic stand-in
		// for the settings.json `extensions` list — the boot seam every
		// extra-specifier test uses).
		extensionSpecifiers: [MEMORY_ENTRY],
	});
	const mint = async (user: string): Promise<string> =>
		(await opened.identity.tokens.create("e2e", user)).token;
	const tokens = { alice: await mint("alice"), bob: await mint("bob") };
	const app = await createServer(opened, config);
	let port = 0;
	if (options?.listen === true) {
		await app.listen({ port: 0, host: "127.0.0.1" });
		const address = app.server.address();
		if (address === null || typeof address === "string") {
			throw new Error("listen did not bind a port");
		}
		port = address.port;
	}
	cleanups.push(async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	});
	return { app, opened, config, dir, tokens, port };
}

/** Bearer headers for one user's token. */
function auth(tokens: Readonly<Record<string, string>>, user: string) {
	return { authorization: `Bearer ${tokens[user]}` };
}

/** Bearer + JSON headers for a body-carrying request. */
function authJson(tokens: Readonly<Record<string, string>>, user: string) {
	return { ...auth(tokens, user), "content-type": "application/json" };
}

/** Create one ordinary conversation over HTTP as `user`. */
async function createConversation(server: TestServer, user: string): Promise<number> {
	const response = await server.app.inject({
		method: "POST",
		url: "/v1/conversations",
		headers: auth(server.tokens, user),
	});
	expect(response.statusCode).toBe(201);
	return response.json().id as number;
}

/** Submit one input over HTTP as `user`; waits for the settled record. */
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

/**
 * Await an observable effect (bounded): polls `probe` every 50 ms until
 * it returns non-undefined, 20 s deadline. The async-review seam — the
 * per-user queue lives inside the extension, so the suite waits on
 * effects (file existence, the notice pile), never internals.
 */
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

/** Read a file's text, or undefined when absent. */
async function readFileOrUndefined(path: string): Promise<string | undefined> {
	const { readFile } = await import("node:fs/promises");
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/** A conversation's entries, oldest first (fork-aware). */
async function entriesOf(
	opened: OpenedHarness,
	id: number,
): Promise<readonly EntryRecord[]> {
	const conversation = await opened.harness.conversation(
		id as ConversationId,
		BACKGROUND_CONTEXT,
	);
	if (conversation === undefined) throw new Error(`conversation ${id} gone`);
	const page = await conversation.entries(
		{ order: "ascending" },
		1000,
		undefined,
		BACKGROUND_CONTEXT,
	);
	return page.items;
}

/** Plain text across one entry's model contributions. */
function entryText(entry: EntryRecord): string {
	return (entry.model ?? [])
		.flatMap((message) =>
			typeof message.content === "string"
				? [message.content]
				: ((message.content ?? []) as { type: string; text?: string }[]).map(
						(block) => (block.type === "text" ? block.text ?? "" : ""),
					),
		)
		.join("");
}

/** The joined text of a conversation's tool-result entries. */
async function toolResultText(
	opened: OpenedHarness,
	id: number,
): Promise<string> {
	const results = (await entriesOf(opened, id)).filter((entry) =>
		ToolResultEntry.is(entry),
	);
	return results.map(entryText).join("\n");
}

/** The `pi.system` entries of one conversation, oldest first. */
async function systemEntriesOf(
	opened: OpenedHarness,
	id: number,
): Promise<readonly EntryRecord[]> {
	return (await entriesOf(opened, id)).filter((entry) =>
		SystemEntry.is(entry),
	);
}

/** The review fork of one parent (storage scan by parent linkage). */
async function forkOf(
	opened: OpenedHarness,
	parent: number,
): Promise<number | undefined> {
	let cursor: Awaited<
		ReturnType<typeof opened.storage.scanConversations>
	>["next"];
	for (;;) {
		const page = await opened.storage.scanConversations(
			{ order: "descending" },
			50,
			cursor,
			BACKGROUND_CONTEXT,
		);
		for (const record of page.items) {
			if ((record.parent?.conversationId as unknown as number) === parent) {
				return record.id as number;
			}
		}
		if (page.next === undefined) return undefined;
		cursor = page.next;
	}
}

/** The curator view's data document, rendered as `user`. */
async function viewData(
	server: TestServer,
	user: string,
): Promise<{
	reviews: { id: string; entries: unknown[] }[];
}> {
	const response = await server.app.inject({
		method: "GET",
		url: "/v1/ext/curator/surfaces/curator",
		headers: auth(server.tokens, user),
	});
	expect(response.statusCode).toBe(200);
	return response.json().data as never;
}

// Learned-skill rows come from the core Skills view: tabs+skills Task 13
// removed the skills section from the curator view (management moved to
// `core/skills`), so the cross-user isolation checks re-pointed here —
// the assertions are unchanged, only the surface that owns the data.
async function skillsViewData(
	server: TestServer,
	user: string,
): Promise<{
	skills: { name: string; group?: string }[];
}> {
	const response = await server.app.inject({
		method: "GET",
		url: "/v1/ext/core/surfaces/skills",
		headers: auth(server.tokens, user),
	});
	expect(response.statusCode).toBe(200);
	return response.json().data as never;
}

// ─── the scenarios ─────────────────────────────────────────────────────────

describe("the end-to-end curator path (curator built-in + memory-markdown)", () => {
	test("the memory target registers as <slug>:memory", { timeout: 30_000 }, async () => {
		const server = await bootServer([]);
		const response = await server.app.inject({
			method: "GET",
			url: "/v1/extensions",
			headers: auth(server.tokens, "alice"),
		});
		expect(response.statusCode).toBe(200);
		const rows = response.json().extensions as {
			name: string;
			status: string;
		}[];
		// memory-markdown's declared `sigrun.memory` sanitizes to the slug.
		const memory = rows.find((row) => row.name === "sigrun-memory");
		expect(memory?.status).toBe("ok");
		// The curator built-in loaded too (the stack under test).
		expect(rows.find((row) => row.name === "curator")?.status).toBe("ok");
		// The qualified target id derives from the SAME slug the inventory
		// reports: `<slug>:memory`.
		const served =
			await server.app.hostBridge.curation.targets("alice");
		const target = served.find((entry) => entry.id.endsWith(":memory"));
		expect(target?.id).toBe(`${memory!.name}:memory`);
		expect(target?.tools).toEqual(["memory_write"]);
	});

	test("a memory_write call becomes a hint; the settle's review writes USER.md", { timeout: 60_000 }, async () => {
		const server = await bootServer([
			// Turn 1's model answer: the memory_write CALL — the wrap
			// intercepts it outside a curator run.
			fauxAssistantMessage(
				[
					fauxToolCall("memory_write", {
						file: "user",
						ops: [{ op: "add", text: USER_ENTRY }],
					} as JsonObject),
				],
				{ stopReason: "toolUse" },
			),
			// Turn 1's final text.
			fauxAssistantMessage("the first answer"),
			// The review: one memory_write (INSIDE the run — executes), then
			// its final text.
			fauxAssistantMessage(
				[
					fauxToolCall("memory_write", {
						file: "user",
						ops: [{ op: "add", text: USER_ENTRY }],
					} as JsonObject),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("review done"),
		]);
		const { app, opened, dir } = server;
		const userPath = join(memoryUserDir(dir, "alice"), "USER.md");
		const id = await createConversation(server, "alice");
		// Turn 1: the conversation's own memory_write call never executed —
		// its tool result is the hint contract text (the wrap's answer),
		// proof in the transcript itself, race-free against the async
		// review.
		const record = await submit(
			server,
			id,
			"remember that I prefer blue/green deploys",
			"alice",
		);
		expect(record.status).toBe("done");
		expect(await toolResultText(opened, id)).toContain(HINT_NOTED_TEXT);
		// The settle's review (hints always trigger) writes USER.md through
		// the real target.
		const written = await waitFor(
			() => readFileOrUndefined(userPath),
			"USER.md after the review",
		);
		expect(written).toContain(USER_ENTRY);
		// The hints doc is drained (the review consumed the hint).
		const hints = await opened.harness.snapshot(
			HintsDoc,
			id as ConversationId,
			BACKGROUND_CONTEXT,
		);
		expect(hints?.hints).toEqual([]);
		void app;
	});

	test("10 model calls → the review creates the skill + a USER.md entry → one notice → undo reverts both", { timeout: 90_000 }, async () => {
		const server = await bootServer([
			// The 10 threshold turns' answers.
			...Array.from({ length: 10 }, (_, index) =>
				fauxAssistantMessage(`answer ${index + 1}`),
			),
			// The review: skill_manage create, memory_write, final text.
			fauxAssistantMessage(
				[
					fauxToolCall("skill_manage", {
						action: "create",
						name: "acme-deploy",
						content: ACME_SKILL,
						reason: "deploy lesson",
					} as JsonObject),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				[
					fauxToolCall("memory_write", {
						file: "user",
						ops: [{ op: "add", text: USER_ENTRY }],
					} as JsonObject),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("review done"),
		]);
		const { app, dir } = server;
		const id = await createConversation(server, "alice");
		for (let turn = 1; turn <= 10; turn += 1) {
			const record = await submit(server, id, `turn ${turn}`, "alice");
			expect(record.status).toBe("done");
		}
		// The review (threshold 10) created the skill and the memory entry.
		const skill = skillPath(dir, "alice", "acme-deploy");
		await waitFor(() => readFileOrUndefined(skill), "the skill file");
		expect(
			await waitFor(
				() =>
					readFileOrUndefined(join(memoryUserDir(dir, "alice"), "USER.md")),
				"USER.md",
			),
		).toContain(USER_ENTRY);
		// ONE core notice for alice, on that conversation (Task 9: the
		// curator posts a per-user notice and retired its ambient record).
		const notice = await waitFor(async () => {
			const response = await app.inject({
				method: "GET",
				url: "/v1/notices",
				headers: auth(server.tokens, "alice"),
			});
			expect(response.statusCode).toBe(200);
			const rows = response.json().notices as {
				key?: string;
				owner: string;
				conversationId?: number;
				title: string;
			}[];
			return rows.find(
				(row) => row.owner === "curator" && row.conversationId === id,
			);
		}, "the curator notice");
		expect(notice?.title).toContain("Learned:");
		expect(notice?.key).toMatch(/^review:/);
		// The view groups the review's two changes under one review id...
		const before = await viewData(server, "alice");
		expect(
			(await skillsViewData(server, "alice")).skills.map((row) => row.name),
		).toContain("acme-deploy");
		// The feed groups CORE-store changes; the memory target's change
		// is a target-owned changeId reverted through undoReview's
		// tool-result walk (not a feed row) — so one review can show as a
		// one-entry group here while still reverting both below.
		const group = before.reviews.find(
			(review) => review.entries.length >= 1,
		);
		expect(group).toBeDefined();
		// ...and the view's undo action reverts BOTH: the learned skill and
		// the memory entry.
		const undo = await app.inject({
			method: "POST",
			url: "/v1/ext/curator/surfaces/curator/actions",
			payload: { action: "undoReview", payload: { itemId: group!.id } },
			headers: authJson(server.tokens, "alice"),
		});
		expect(undo.statusCode).toBe(200);
		expect(undo.json().ok).toBe(true);
		expect(String(undo.json().toast)).toContain("Undid");
		expect(await readFileOrUndefined(skill)).toBeUndefined();
		// The memory target's undo restores the file's previous (empty)
		// state — an empty USER.md, not a deleted one.
		const restoredMemory = await readFileOrUndefined(
			join(memoryUserDir(dir, "alice"), "USER.md"),
		);
		expect(restoredMemory === undefined || restoredMemory === "").toBe(true);
		// The core Skills view lists ARCHIVED learned skills too, as
		// Deleted-group rows — the undone create shows as deleted, not
		// absent.
		const undone = (await skillsViewData(server, "alice")).skills.find(
			(row) => row.name === "acme-deploy",
		);
		expect(undone?.group).toBe("deleted");
	});

	test("bob never sees alice's skill or memory, before or after", { timeout: 60_000 }, async () => {
		const server = await bootServer([
			// Bob's own turn (settles before anything alice does).
			fauxAssistantMessage("bob's answer"),
			// Alice's hint turn: a skill_manage call that becomes a hint...
			fauxAssistantMessage(
				[
					fauxToolCall("skill_manage", {
						action: "create",
						name: "acme-deploy",
						content: ACME_SKILL,
					} as JsonObject),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("ok"),
			// ...and the settle's review, which creates both files:
			// the skill (round 1) and the memory entry (round 2).
			fauxAssistantMessage(
				[
					fauxToolCall("skill_manage", {
						action: "create",
						name: "acme-deploy",
						content: ACME_SKILL,
					} as JsonObject),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				[
					fauxToolCall("memory_write", {
						file: "user",
						ops: [{ op: "add", text: USER_ENTRY }],
					} as JsonObject),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("review done"),
		]);
		// BEFORE: bob's own conversation settles; his skills view is empty.
		const bobs = await createConversation(server, "bob");
		await submit(server, bobs, "bob's turn", "bob");
		expect((await skillsViewData(server, "bob")).skills).toEqual([]);
		// Alice's hint drives the review that writes her skill + memory.
		const id = await createConversation(server, "alice");
		await submit(server, id, "learn the deploy lesson", "alice");
		await waitFor(
			() => readFileOrUndefined(skillPath(dir2(server), "alice", "acme-deploy")),
			"alice's skill file",
		);
		// The skill file lands on the review's first tool call; the
		// memory_write is the second — wait for it (scenario 1's rule).
		await waitFor(
			() =>
				readFileOrUndefined(
					join(memoryUserDir(dir2(server), "alice"), "USER.md"),
				),
			"alice's USER.md",
		);
		// AFTER: bob's skills view still shows none of it, his memory dir
		// holds nothing of alice's — and the control: alice's views have it.
		const bobsAfter = await skillsViewData(server, "bob");
		expect(bobsAfter.skills.map((row) => row.name)).not.toContain(
			"acme-deploy",
		);
		expect((await viewData(server, "bob")).reviews).toEqual([]);
		expect(
			await readFileOrUndefined(
				join(memoryUserDir(dir2(server), "bob"), "USER.md"),
			),
		).toBeUndefined();
		expect(
			(await skillsViewData(server, "alice")).skills.map((row) => row.name),
		).toContain("acme-deploy");
	});

	test("the fork never appears in alice's list or event stream", { timeout: 90_000 }, async () => {
		const server = await bootServer(
			[
				...Array.from({ length: 10 }, (_, index) =>
					fauxAssistantMessage(`answer ${index + 1}`),
				),
				// The review: no tool calls, no changes — but the fork exists.
				fauxAssistantMessage("review done"),
			],
			{ listen: true },
		);
		const { app, opened, port } = server;
		// The event stream opens BEFORE anything happens.
		const connection = new EventsConnection(port, {
			authorization: `Bearer ${server.tokens.alice}`,
		});
		await connection.open();
		const id = await createConversation(server, "alice");
		for (let turn = 1; turn <= 10; turn += 1) {
			await submit(server, id, `turn ${turn}`, "alice");
		}
		// The fork exists in the durable store (the parent-linkage scan).
		const fork = await waitFor(() => forkOf(opened, id), "the review fork");
		// Let any notice-bearing events drain.
		await new Promise((resolve) => setTimeout(resolve, 500));
		// The list: alice sees her conversation, never the fork. The
		// no-header caller is refused under the token method (401), so
		// both "who can see it" checks go through identified principals:
		// alice herself, and bob (a non-owner — the fork is not shared).
		for (const user of ["alice", "bob"]) {
			const list = await app.inject({
				method: "GET",
				url: "/v1/conversations",
				headers: auth(server.tokens, user),
			});
			expect(list.statusCode).toBe(200);
			const ids = (list.json().conversations as { id: number }[]).map(
				(row) => row.id,
			);
			if (user === "alice") expect(ids).toContain(id);
			expect(ids).not.toContain(fork);
		}
		// The event stream: no frame ever named the fork. Control: the
		// ordinary conversation's frames did arrive.
		expect(connection.forConversation(fork)).toHaveLength(0);
		expect(connection.forConversation(id).length).toBeGreaterThan(0);
		connection.close();
	});

	test("a curator write costs alice's other conversation ONE pi.system tail patch, baseline unchanged", { timeout: 90_000 }, async () => {
		const server = await bootServer([
			// Conversation A's first turn (lands its baseline system entry).
			fauxAssistantMessage("conversation A's first answer"),
			// Conversation B: the 10 threshold turns...
			...Array.from({ length: 10 }, (_, index) =>
				fauxAssistantMessage(`B answer ${index + 1}`),
			),
			// ...and the review's memory write (the curator write).
			fauxAssistantMessage(
				[
					fauxToolCall("memory_write", {
						file: "user",
						ops: [{ op: "add", text: USER_ENTRY }],
					} as JsonObject),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("review done"),
			// Conversation A's next turn (after the curator write).
			fauxAssistantMessage("conversation A's next answer"),
		]);
		const { opened, dir } = server;
		// Conversation A: one turn FIRST (its baseline lands).
		const a = await createConversation(server, "alice");
		await submit(server, a, "conversation A's first turn", "alice");
		const before = await systemEntriesOf(opened, a);
		expect(before.length).toBeGreaterThanOrEqual(1);
		const baseline = before[0];
		expect(JSON.stringify(baseline.model ?? [])).toContain(
			"No long-term memories yet.",
		);
		// Conversation B: 10 turns → the review writes USER.md (the
		// curator write that changes the long-term-memory section).
		const b = await createConversation(server, "alice");
		for (let turn = 1; turn <= 10; turn += 1) {
			await submit(server, b, `B turn ${turn}`, "alice");
		}
		expect(
			await waitFor(
				() =>
					readFileOrUndefined(join(memoryUserDir(dir, "alice"), "USER.md")),
				"USER.md (the curator write)",
			),
		).toContain(USER_ENTRY);
		// Conversation A's NEXT request: exactly ONE new pi.system entry —
		// a tail patch — and the baseline entry is unchanged.
		await submit(server, a, "conversation A's next turn", "alice");
		const after = await systemEntriesOf(opened, a);
		expect(after.length - before.length).toBe(1);
		expect(after[0].id).toBe(baseline.id);
		expect(after[0].model).toEqual(baseline.model);
		// The patch carries the new section value (and only the delta).
		const patch = after[after.length - 1].model?.[0] as {
			sections?: Record<string, string>;
		};
		expect(Object.keys(patch.sections ?? {})).toEqual(["long-term-memory"]);
		expect(patch.sections?.["long-term-memory"]).toContain("USER PROFILE");
	});

	test("skill_manage called by bob in alice's write-shared conversation leaves no hint", { timeout: 60_000 }, async () => {
		const server = await bootServer([
			// Bob's model turn: a skill_manage call (intercepted).
			fauxAssistantMessage(
				[
					fauxToolCall("skill_manage", {
						action: "create",
						name: "bobs-attempt",
						content: ACME_SKILL,
					} as JsonObject),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		const { app, opened, dir } = server;
		// Alice's conversation, shared household-write; bob submits.
		const id = await createConversation(server, "alice");
		const share = await app.inject({
			method: "PATCH",
			url: `/v1/conversations/${id}/meta`,
			payload: { sharing: { scope: "household", level: "write" } },
			headers: authJson(server.tokens, "alice"),
		});
		expect(share.statusCode).toBe(200);
		const record = await submit(
			server,
			id,
			"bob drives alice's conversation",
			"bob",
		);
		expect(record.status).toBe("done");
		// The call was answered with the not-recorded contract text (the
		// transcript's own tool result), no hint was recorded, and no skill
		// file exists for either user.
		expect(await toolResultText(opened, id)).toContain(
			HINT_NOT_RECORDED_TEXT,
		);
		const hints = await opened.harness.snapshot(
			HintsDoc,
			id as ConversationId,
			BACKGROUND_CONTEXT,
		);
		expect(hints?.hints ?? []).toEqual([]);
		expect(
			await readFileOrUndefined(skillPath(dir, "alice", "bobs-attempt")),
		).toBeUndefined();
	});
});

/** The boot dir (scenario 4's path builder — kept off the server shape). */
function dir2(server: TestServer): string {
	return server.dir;
}

// ─── the SSE collector (curation-internal.test.ts's shape) ─────────────────

/** One parsed SSE frame from a loopback /v1/events connection. */
interface HostFrame {
	readonly event: string;
	readonly data: { conversationId?: number };
}

/** Collect every frame a loopback /v1/events connection sees. */
class EventsConnection {
	private readonly events: HostFrame[] = [];
	private buffer = "";
	#request: http.ClientRequest | undefined;

	constructor(
		private readonly port: number,
		private readonly headers: Record<string, string>,
	) {}

	/** Open the stream; resolves once headers arrived (subscription live). */
	open(): Promise<void> {
		return new Promise((resolve, reject) => {
			const request = http.get({
				host: "127.0.0.1",
				port: this.port,
				path: "/v1/events",
				headers: this.headers,
				agent: false,
			});
			this.#request = request;
			request.on("error", (error) => reject(error));
			request.on("response", (incoming) => {
				incoming.setEncoding("utf8");
				incoming.on("data", (chunk: string) => {
					this.buffer += chunk;
					this.drain();
				});
				incoming.on("error", () => {});
				resolve();
			});
		});
	}

	private drain(): void {
		for (;;) {
			const boundary = this.buffer.indexOf("\n\n");
			if (boundary === -1) return;
			const frame = this.buffer.slice(0, boundary);
			this.buffer = this.buffer.slice(boundary + 2);
			let event = "";
			let data = "";
			for (const line of frame.split("\n")) {
				if (line.startsWith(":")) continue;
				if (line.startsWith("event:")) event = line.slice(6).trim();
				else if (line.startsWith("data:")) data += line.slice(5).trim();
			}
			if (data === "") continue;
			this.events.push({
				event,
				data: JSON.parse(data) as HostFrame["data"],
			});
		}
	}

	/** Every frame naming one conversation. */
	forConversation(id: number): readonly HostFrame[] {
		return this.events.filter((frame) => frame.data.conversationId === id);
	}

	/** Destroy the socket — the SSE request otherwise never ends. */
	close(): void {
		this.#request?.destroy();
	}
}
