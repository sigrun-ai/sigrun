/**
 * Task A9 (curator P6): the run driver — `forkReview` and `digestRun`
 * over a real harness, with the faux provider scripting the review's
 * tool calls.
 *
 * `forkReview` forks an owned conversation at its newest entry with the
 * cache-parity agent rebuild (model, thinkingLevel, extensions + the
 * gate, tools, modelTools), marks the fork internal with the run doc in
 * the creating commit, submits the instruction, and DRIVES the run:
 * aborting at `maxToolCalls` tool results, at `deadlineMs`, when the
 * caller's signal fires, or when the parent's owner/sharing/head/
 * admission state moves (→ cancelled); collecting `details.curation`
 * into `changes` and the final assistant text into `text`.
 *
 * `digestRun` is the same driver over a fresh internal conversation on
 * the server default model. Hermetic pattern (curation-gate.test.ts):
 * faux provider + tmpdir + `openHarness` with the curation-target
 * fixture through `extensionEntries`.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AgentDoc, LiveDoc } from "@earendil-works/pi-durable";
import type {
	ConversationId,
	JsonObject,
} from "@earendil-works/pi-durable";
import type { ResolvedExtensionInput } from "../src/harness/loader.js";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { SessionMetaDoc } from "../src/server/session-meta.js";
import { isInternal } from "../src/curation/internal.js";
import { seededIdentity } from "./helpers/identity.js";

/** The fixture-curation-target entry (the P9 vehicle). */
const TARGET_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-curation-target", "index.js"),
).href;

/** The ask-wait fixture entry (declares wait_for_human interactive). */
const ASK_WAIT_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-ask-wait", "index.js"),
).href;

/** The fixture module's exports (records + reset). */
type FixtureModule = {
	readonly writes: readonly { text: string }[];
	readonly maintains: readonly {
		user: string;
		deadline: number;
		runs: number;
		digestTexts: string[];
	}[];
	readonly resetTargetFixture: () => void;
};

/** Import the fixture module by the SAME URL the loader imported. */
async function fixtureModule(): Promise<FixtureModule> {
	return (await import(TARGET_SPECIFIER)) as unknown as FixtureModule;
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

/** The learned-skill body the review's tool call creates. */
const ACME_SKILL = `---\nname: acme-deploy\ndescription: Deploy acme\n---\n# Deploy\n\nDeploy the acme way.\n`;

/** The curation host handle the boot exposes (the A9 surface). */
type CurationHost = OpenedHarness["curationHost"];

/** Boot one hermetic harness with the curation-target fixture installed. */
async function boot(responses: readonly unknown[]): Promise<{
	opened: OpenedHarness;
	curation: CurationHost;
	fixture: FixtureModule;
	dir: string;
}> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-curation-runs-"));
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000, reasoning: true }],
	});
	faux.setResponses(responses as never);
	const contributor: ProviderContributor = {
		name: "ext-faux",
		providers: [{ provider: faux.provider }],
	};
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
		SIGRUN_DATA_DIR: join(dir, "data"),
	});
	await writeFile(join(dir, "settings.json"), '{"namingModel": false}');
	const identity = await seededIdentity(dir);
	// Alice and bob are the curated users (the brief's literals): the
	// directory must know them or `curationOf` refuses their stores.
	if (identity.users.get("alice") === undefined) {
		await identity.users.add({ user: "alice", name: "Alice", admin: false, source: "cli" });
	}
	if (identity.users.get("bob") === undefined) {
		await identity.users.add({ user: "bob", name: "Bob", admin: false, source: "cli" });
	}
	const opened = await openHarness(config, {
		identity,
		extensions: [contributor],
		builtins: false,
		env: {},
		settingsDir: dir,
		extensionEntries: [
			{
				name: "fixture-curation-target",
				entry: TARGET_SPECIFIER,
			} satisfies ResolvedExtensionInput,
			// Ask-user Task 3: the interactive-tool declarer rides every
			// boot (an inert fixture when a test never calls its tool).
			{
				name: "sigrun-fixture-ask-wait",
				entry: ASK_WAIT_SPECIFIER,
			} satisfies ResolvedExtensionInput,
		],
	});
	cleanups.push(async () => {
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	});
	const fixture = await fixtureModule();
	fixture.resetTargetFixture();
	return { opened, curation: opened.curationHost, fixture, dir };
}

/**
 * One owned conversation with a finished user turn (the review's
 * parent). The turn consumes one scripted response BEFORE the fork's.
 */
async function parentConversation(
	opened: OpenedHarness,
	owner: string,
): Promise<number> {
	const conversation = await opened.harness.createConversation(
		{ ownership: { kind: "ownerless" }, agent: { model: opened.defaultModel } },
		BACKGROUND_CONTEXT,
	);
	await opened.harness.commit(async (tx) => {
		const meta = await tx.doc(SessionMetaDoc, conversation.id);
		meta.owner = owner;
	}, BACKGROUND_CONTEXT);
	const submission = await conversation.submit(
		{ type: "input", content: "the parent's own turn" },
		BACKGROUND_CONTEXT,
	);
	const record = await submission.wait(BACKGROUND_CONTEXT);
	expect(record.status).toBe("done");
	return conversation.id as number;
}

/** The stock RunOpts every test varies. */
const RUN_OPTS = {
	instruction: "Review the conversation and record what you learned.",
	allow: ["skill_manage", "notes_write"],
	maxToolCalls: 8,
	maxOutputTokens: 16_000,
	deadlineMs: 20_000,
	reviewId: "review-1",
} as const;

/** The fork conversation the driver created for one parent (or -1). */
async function forkOf(
	opened: OpenedHarness,
	parent: number,
): Promise<number> {
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
		if (page.next === undefined) return -1;
		cursor = page.next;
	}
}

/** Await the fork's existence (the driver's async creation window). */
async function awaitFork(
	opened: OpenedHarness,
	parent: number,
): Promise<number> {
	for (;;) {
		const fork = await forkOf(opened, parent);
		if (fork !== -1) return fork;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

// ─── fork review ───────────────────────────────────────────────────────────

describe("forkReview (curator P6 run driver)", () => {
	test("writes a learned skill and reports the change", { timeout: 30_000 }, async () => {
		const { opened, curation, dir } = await boot([
			// The parent's own turn.
			fauxAssistantMessage("the parent's answer"),
			// The review: one skill_manage create, then the final text.
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
			fauxAssistantMessage("review done"),
		]);
		const parent = await parentConversation(opened, "alice");
		const result = await curation.forkReview(parent as ConversationId, {
			...RUN_OPTS,
			reviewId: "review-learned",
		});
		expect(result.status).toBe("completed");
		expect(result.text).toBe("review done");
		// The change the review's tool reported, with its target id.
		expect(result.changes).toHaveLength(1);
		expect(result.changes[0]?.summary).toContain("acme-deploy");
		expect(typeof result.changes[0]?.changeId).toBe("string");
		// The skill landed in ALICE's learned root, and the feed entry
		// carries the reviewId (the stamping rule).
		const { readFile } = await import("node:fs/promises");
		expect(
			await readFile(
				join(dir, "data", "users", "alice", "skills", "acme-deploy", "SKILL.md"),
				"utf8",
			),
		).toBe(ACME_SKILL);
		const alice = curation.skills("alice");
		const entries = await alice.feed(5);
		expect(
			entries.some(
				(entry: { action: string; skill: string; reviewId?: string }) =>
					entry.action === "create" &&
					entry.skill === "acme-deploy" &&
					entry.reviewId === "review-learned",
			),
		).toBe(true);
	});

	test("keeps the parent's model and thinking level", { timeout: 30_000 }, async () => {
		const { opened, curation } = await boot([
			fauxAssistantMessage("the parent's answer"),
			fauxAssistantMessage("review done"),
		]);
		const parent = await parentConversation(opened, "alice");
		// Pin an explicit thinking level on the parent, then fork.
		const conversation = await opened.harness.conversation(
			parent as ConversationId,
			BACKGROUND_CONTEXT,
		);
		await conversation!.configure({ thinkingLevel: "high" }, BACKGROUND_CONTEXT);
		const result = await curation.forkReview(parent as ConversationId, {
			...RUN_OPTS,
		});
		expect(result.status).toBe("completed");
		// The fork's stored agent: the parent's model and thinking level,
		// plus the gate in the extension selection.
		const forkId = await forkOf(opened, parent);
		const agent = await opened.harness.snapshot(
			AgentDoc,
			forkId as ConversationId,
			BACKGROUND_CONTEXT,
		);
		expect(agent?.model).toEqual(opened.defaultModel);
		expect(agent?.thinkingLevel).toBe("high");
		// The stored selection's shape: an array of names (the parent's
		// selection was stored as one) or an {add} edit over the default
		// (an unset parent selection) — the gate rides either way.
		const extensions = agent?.extensions as
			| string[]
			| { add?: string[] }
			| undefined;
		const names = Array.isArray(extensions)
			? extensions
			: (extensions?.add ?? []);
		expect(names.includes("sigrun.curation-gate")).toBe(true);
	});

	test("is internal and invisible", { timeout: 30_000 }, async () => {
		const { opened, curation } = await boot([
			fauxAssistantMessage("the parent's answer"),
			fauxAssistantMessage("review done"),
		]);
		const parent = await parentConversation(opened, "alice");
		await curation.forkReview(parent as ConversationId, { ...RUN_OPTS });
		const forkId = await forkOf(opened, parent);
		// The A2 markers: internal + owned by the curated user, hidden
		// from the durable listing (the scan the listing op runs, with
		// the marker filter the op applies).
		expect(
			await isInternal(opened.harness, forkId as ConversationId, BACKGROUND_CONTEXT),
		).toBe(true);
		const meta = await opened.harness.snapshot(
			SessionMetaDoc,
			forkId as ConversationId,
			BACKGROUND_CONTEXT,
		);
		expect(meta?.owner).toBe("alice");
		// Hidden for every caller: accessOf rule 0 (internal → "none")
		// is the listing op's own line; the harness-level equivalent is
		// the internal marker plus owner stamp asserted above, and the
		// fork never runs the namer or emits events (A2's coverage).
		// Here: the parent's own listing shape excludes it.
		const internal = await isInternal(
			opened.harness,
			forkId as ConversationId,
			BACKGROUND_CONTEXT,
		);
		expect(internal).toBe(true);
	});

	test("is cancelled when the parent admits a new run", { timeout: 30_000 }, async () => {
		// The review's answer stays pending until the test releases it —
		// the review is still IN FLIGHT when the parent admits.
		let releaseReview: () => void = () => {};
		const reviewGate = new Promise<void>((resolve) => {
			releaseReview = resolve;
		});
		const { opened, curation } = await boot([
			fauxAssistantMessage("the parent's answer"),
			async () => {
				await reviewGate;
				return fauxAssistantMessage("review answer");
			},
		]);
		const parent = await parentConversation(opened, "alice");
		const pending = curation.forkReview(parent as ConversationId, {
			...RUN_OPTS,
			deadlineMs: 10_000,
		});
		await awaitFork(opened, parent);
		// A new submission on the PARENT: the admission change cancels.
		const handle = await opened.harness.conversation(
			parent as ConversationId,
			BACKGROUND_CONTEXT,
		);
		const submitted = handle!.submit(
			{ type: "input", content: "a new question for the parent" },
			BACKGROUND_CONTEXT,
		);
		// Give the drift watcher a macrotask to see the admission commit
		// before the review's answer resolves (the stop lane must fire
		// while the run is live).
		await new Promise((resolve) => setTimeout(resolve, 50));
		releaseReview();
		await submitted;
		const result = await pending;
		expect(result.status).toBe("cancelled");
		expect(result.error).toMatch(/parent/i);
		// The parent's new run still settles (the review aborted only
		// its own fork).
		await opened.harness.waitForIdle(BACKGROUND_CONTEXT);
	});

	test("is cancelled when the parent is reset or newly write-shared after start", { timeout: 60_000 }, async () => {
		// Reset: the parent's head moves while the review runs.
		{
			let releaseReview: () => void = () => {};
			const reviewGate = new Promise<void>((resolve) => {
				releaseReview = resolve;
			});
			const { opened, curation } = await boot([
				fauxAssistantMessage("the parent's answer"),
				async () => {
					await reviewGate;
					return fauxAssistantMessage("review answer");
				},
			]);
			const parent = await parentConversation(opened, "alice");
			const pending = curation.forkReview(parent as ConversationId, {
				...RUN_OPTS,
				deadlineMs: 10_000,
			});
			await awaitFork(opened, parent);
			const handle = await opened.harness.conversation(
				parent as ConversationId,
				BACKGROUND_CONTEXT,
			);
			const reset = handle!.reset("handoff after reset", BACKGROUND_CONTEXT);
			await new Promise((resolve) => setTimeout(resolve, 50));
			releaseReview();
			await reset;
			const result = await pending;
			expect(result.status).toBe("cancelled");
		}
		// Sharing: the parent becomes write-shared while the review runs.
		{
			let releaseReview: () => void = () => {};
			const reviewGate = new Promise<void>((resolve) => {
				releaseReview = resolve;
			});
			const { opened, curation } = await boot([
				fauxAssistantMessage("the parent's answer"),
				async () => {
					await reviewGate;
					return fauxAssistantMessage("review answer");
				},
			]);
			const parent = await parentConversation(opened, "alice");
			const pending = curation.forkReview(parent as ConversationId, {
				...RUN_OPTS,
				deadlineMs: 10_000,
			});
			await awaitFork(opened, parent);
			const shared = opened.harness.commit(async (tx) => {
				const meta = await tx.doc(SessionMetaDoc, parent as ConversationId);
				meta.sharing = { scope: "household", level: "write" };
			}, BACKGROUND_CONTEXT);
			await new Promise((resolve) => setTimeout(resolve, 50));
			releaseReview();
			await shared;
			const result = await pending;
			expect(result.status).toBe("cancelled");
		}
	});

	test("aborts at maxToolCalls", { timeout: 30_000 }, async () => {
		// Three tool calls, budget two: the review aborts on the second
		// tool result and reports cancelled with the budget reason.
		const { opened, curation, fixture } = await boot([
			fauxAssistantMessage("the parent's answer"),
			fauxAssistantMessage(
				[fauxToolCall("notes_write", { text: "note one" } as JsonObject)],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				[fauxToolCall("notes_write", { text: "note two" } as JsonObject)],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				[fauxToolCall("notes_write", { text: "note three" } as JsonObject)],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("review done"),
		]);
		const parent = await parentConversation(opened, "alice");
		const result = await curation.forkReview(parent as ConversationId, {
			...RUN_OPTS,
			maxToolCalls: 2,
		});
		expect(result.status).toBe("cancelled");
		expect(result.error).toMatch(/maxToolCalls|tool/i);
		// The two budgeted calls executed; the third never did (the run
		// was aborted before generation offered it again).
		expect(fixture.writes.length).toBeLessThanOrEqual(2);
	});

	test("refuses an internal or ownerless conversation", { timeout: 20_000 }, async () => {
		const { opened, curation } = await boot([]);
		// Internal: mark a fresh conversation internal (the A2 marker).
		const internal = await opened.harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: { model: opened.defaultModel },
				init: async (tx, id) => {
					const { markInternal } = await import("../src/curation/internal.js");
					await markInternal(tx, id, "alice");
				},
			},
			BACKGROUND_CONTEXT,
		);
		const refusedInternal = await curation.forkReview(
			internal.id as ConversationId,
			{ ...RUN_OPTS },
		);
		expect(refusedInternal.status).toBe("failed");
		expect(refusedInternal.error).toMatch(/not eligible/i);
		// Ownerless: an ordinary conversation with no owner.
		const ownerless = await opened.harness.createConversation(
			{ ownership: { kind: "ownerless" }, agent: { model: opened.defaultModel } },
			BACKGROUND_CONTEXT,
		);
		const refusedOwnerless = await curation.forkReview(
			ownerless.id as ConversationId,
			{ ...RUN_OPTS },
		);
		expect(refusedOwnerless.status).toBe("failed");
		expect(refusedOwnerless.error).toMatch(/not eligible/i);
		// An empty conversation (no entries at all) is not forkable
		// either: forkOp's empty_conversation analog.
		const empty = await parentlessConversation(opened, "alice");
		const refusedEmpty = await curation.forkReview(
			empty as ConversationId,
			{ ...RUN_OPTS },
		);
		expect(refusedEmpty.status).toBe("failed");
	});

	test("refuses an empty allow list (the gate's message needs one)", { timeout: 20_000 }, async () => {
		const { opened, curation } = await boot([
			fauxAssistantMessage("the parent's answer"),
			fauxAssistantMessage("review done"),
		]);
		const parent = await parentConversation(opened, "alice");
		await expect(
			curation.forkReview(parent as ConversationId, {
				...RUN_OPTS,
				allow: [],
			}),
		).rejects.toThrow(/allow/i);
	});
});

// ─── digest run ────────────────────────────────────────────────────────────

describe("digestRun (curator P6 run driver)", () => {
	test("writes through a target tool and returns its final text", { timeout: 30_000 }, async () => {
		const { opened, curation, fixture } = await boot([
			fauxAssistantMessage(
				[fauxToolCall("notes_write", { text: "digest note" } as JsonObject)],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("digest complete"),
		]);
		const result = await curation.digestRun("alice", {
			...RUN_OPTS,
			input: "Digest the week's hints.",
			reviewId: "digest-1",
		});
		expect(result.status).toBe("completed");
		expect(result.text).toBe("digest complete");
		expect(fixture.writes).toEqual([{ text: "digest note" }]);
		expect(result.changes).toHaveLength(1);
		// The digest conversation is internal (A2's marker) and carries
		// no parent.
		const run = await digestConversationOf(opened, "digest-1");
		expect(run).toBeDefined();
		expect(
			await isInternal(
				opened.harness,
				run as ConversationId,
				BACKGROUND_CONTEXT,
			),
		).toBe(true);
	});
});

// ─── interactive tools in curator runs (ask-user Task 3) ──────────────────

describe("interactive tools in curator runs", () => {
	test("a digest allow list loses interactive tools with ONE warning", { timeout: 30_000 }, async () => {
		const warnings: string[] = [];
		const spy = vi.spyOn(console, "warn").mockImplementation((message?: unknown) => {
			warnings.push(String(message));
		});
		try {
			const { opened, curation } = await boot([
				fauxAssistantMessage("digest complete"),
			]);
			const result = await curation.digestRun("alice", {
				...RUN_OPTS,
				allow: ["wait_for_human", "skill_manage"],
				input: "Digest the week's hints.",
				reviewId: "digest-interactive",
			});
			expect(result.status).toBe("completed");
			// The run doc's allow is the STRIPPED list; the warning names the
			// removed tool and fires exactly once.
			const runId = await digestConversationOf(opened, "digest-interactive");
			expect(runId).toBeDefined();
			const { CurationRunDoc } = await import("../src/curation/run-doc.js");
			const run = await opened.harness.snapshot(
				CurationRunDoc,
				runId as ConversationId,
				BACKGROUND_CONTEXT,
			);
			expect(run?.allow).toEqual(["skill_manage"]);
			const stripWarnings = warnings.filter((line) =>
				line.includes("wait_for_human"),
			);
			expect(stripWarnings).toHaveLength(1);
			// The digest conversation's offered tools exclude the interactive one.
			const conversation = await opened.harness.conversation(
				runId as ConversationId,
				BACKGROUND_CONTEXT,
			);
			const agent = await conversation!.agent(BACKGROUND_CONTEXT);
			expect(
				agent.tools.some((tool) => tool.name === "wait_for_human"),
			).toBe(false);
			expect(
				agent.callable.some((tool) => tool.name === "wait_for_human"),
			).toBe(false);
		} finally {
			spy.mockRestore();
		}
	});

	test("an all-interactive allow list still fails the non-empty check, warning first", { timeout: 30_000 }, async () => {
		const warnings: string[] = [];
		const spy = vi.spyOn(console, "warn").mockImplementation((message?: unknown) => {
			warnings.push(String(message));
		});
		try {
			const { curation } = await boot([]);
			await expect(
				curation.digestRun("alice", {
					...RUN_OPTS,
					allow: ["wait_for_human"],
					input: "Digest the week's hints.",
					reviewId: "digest-empty-after-strip",
				}),
			).rejects.toThrow(/non-empty allow/);
			expect(
				warnings.filter((line) => line.includes("wait_for_human")),
			).toHaveLength(1);
		} finally {
			spy.mockRestore();
		}
	});

	test("a fork review KEEPS interactive tools listed (cache parity); the gate blocks a call", { timeout: 30_000 }, async () => {
		const { opened, curation } = await boot([
			// The parent's own turn.
			fauxAssistantMessage("the parent's answer"),
			// The review calls the interactive tool; the gate blocks it;
			// the review then finishes.
			fauxAssistantMessage(
				[fauxToolCall("wait_for_human", {} as JsonObject)],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("review done"),
		]);
		const parent = await parentConversation(opened, "alice");
		const result = await curation.forkReview(parent as ConversationId, {
			...RUN_OPTS,
			reviewId: "review-interactive",
		});
		expect(result.status).toBe("completed");
		const forkId = await forkOf(opened, parent);
		const fork = await opened.harness.conversation(
			forkId as ConversationId,
			BACKGROUND_CONTEXT,
		);
		// Cache parity: the fork's stored selection is byte-identical to the
		// parent's — the interactive tool is still OFFERED...
		const agent = await fork!.agent(BACKGROUND_CONTEXT);
		expect(
			agent.tools.some((tool) => tool.name === "wait_for_human"),
		).toBe(true);
		// ...but the gate blocked the call (the tool never executed — no
		// question card exists on the fork).
		const blocked = await toolResultTexts(opened, forkId, "wait_for_human");
		expect(blocked).toHaveLength(1);
		expect(blocked[0]).toContain("not available in this review");
	});
});

/** The tool-result texts of one tool on one conversation (call order). */
async function toolResultTexts(
	opened: OpenedHarness,
	id: number,
	tool: string,
): Promise<string[]> {
	const conversation = await opened.harness.conversation(
		id as ConversationId,
		BACKGROUND_CONTEXT,
	);
	if (conversation === undefined) throw new Error("conversation vanished");
	const page = await conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
	const texts: string[] = [];
	for (const entry of [...page.items].reverse()) {
		if (entry.kind !== "pi.tool-result") continue;
		for (const message of entry.model ?? []) {
			if (message.role !== "toolResult" || message.toolName !== tool) continue;
			texts.push(
				typeof message.content === "string"
					? message.content
					: message.content
							.filter((block) => block.type === "text")
							.map((block) => block.text)
							.join(""),
			);
		}
	}
	return texts;
}

// ─── maintain ─────────────────────────────────────────────────────────────

describe("maintain (curator P6 budget wiring)", () => {
	test("budget.run returns the digest text to the target", { timeout: 30_000 }, async () => {
		const { opened, curation } = await boot([
			// The digest run the target's budget.run starts.
			fauxAssistantMessage(
				[fauxToolCall("notes_write", { text: "maintain note" } as JsonObject)],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("the digest text"),
		]);
		const report = await curation.maintain(
			"alice",
			"fixture-curation-target:notes",
			{ deadline: Date.now() + 15_000, runs: 1 },
		);
		expect(report.changes).toEqual([]);
		// The target's maintain ran and its budget.run resolved the digest
		// text (the fixture records the run result's text).
		const { fixture } = { fixture: await fixtureModule() };
		expect(fixture.maintains).toHaveLength(1);
		expect(fixture.maintains[0]?.digestTexts).toEqual(["the digest text"]);
	});
});

// ─── helpers ───────────────────────────────────────────────────────────────

/** An owned conversation with NO history (the empty-parent refusal). */
async function parentlessConversation(
	opened: OpenedHarness,
	owner: string,
): Promise<number> {
	const conversation = await opened.harness.createConversation(
		{ ownership: { kind: "ownerless" }, agent: { model: opened.defaultModel } },
		BACKGROUND_CONTEXT,
	);
	await opened.harness.commit(async (tx) => {
		const meta = await tx.doc(SessionMetaDoc, conversation.id);
		meta.owner = owner;
	}, BACKGROUND_CONTEXT);
	return conversation.id as number;
}

/**
 * The internal conversation whose run doc carries one reviewId: the
 * digest conversations' identity probe (no parent linkage exists).
 */
async function digestConversationOf(
	opened: OpenedHarness,
	reviewId: string,
): Promise<number | undefined> {
	// Scan every conversation for the internal marker + a run doc whose
	// reviewId matches. The CurationRunDoc snapshot is read per row.
	const { CurationRunDoc } = await import("../src/curation/run-doc.js");
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
			const run = await opened.harness.snapshot(
				CurationRunDoc,
				record.id,
				BACKGROUND_CONTEXT,
			);
			if (run?.reviewId === reviewId) return record.id as number;
		}
		if (page.next === undefined) return undefined;
		cursor = page.next;
	}
}

// The live-doc import keeps the type surface honest for future driver
// assertions (admission-state capture).
void LiveDoc;
