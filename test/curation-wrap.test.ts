/**
 * Task A8 (curator P9): hints by wrapping — the interception that turns
 * an owner's own curation-tool call outside a curator run into a review
 * hint instead of a write.
 *
 * The wrap is REGISTRATION-time, not selection-time: the loader rewrites
 * the registration of every listed curation tool before
 * `registry.install`, so the interception travels with the tool into
 * every conversation, whatever its extension selection. Inside a curator
 * run (`sigrun.curation.run` present) the original executes untouched;
 * outside one, a MUTATING call never executes — it appends to the
 * `sigrun.curation.hints` doc when the current run's inputs are ALL the
 * owner's, and answers "Not recorded…" otherwise. `skill_manage`'s read
 * actions (list/view) pass through to the original.
 *
 * Hermetic pattern (curation-targets.test.ts): faux provider + tmpdir +
 * `openHarness` with `builtins: false`, loading the curation-target
 * fixture through `extensionEntries`. The fixture records writes
 * module-side; the live run's inputs and their authors are fabricated
 * through the same docs the real admission path writes (`pi.live`'s run
 * inputs + `sigrun.authors` bySubmission), and the tool is driven
 * through a `ToolExecutionApi` fake whose `snapshot`/`commit` delegate
 * to the real harness.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
	LiveDoc,
	type ConversationId,
	type SubmissionId,
	type TaskId,
	type ToolExecutionApi,
	type ToolRegistration,
	type Tx,
} from "@earendil-works/pi-durable";
import type { ResolvedExtensionInput } from "../src/harness/loader.js";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { AuthorsDoc, recordAuthor } from "../src/curation/attribution.js";
import { HintsDoc, takeHints, wrapCurationTool } from "../src/curation/wrap.js";
import { SessionMetaDoc } from "../src/server/session-meta.js";
import { seededIdentity } from "./helpers/identity.js";

/** The fixture-curation-target entry (the P9 vehicle). */
const TARGET_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-curation-target", "index.js"),
).href;

/** The fixture module's exports (records + the factory). */
type FixtureModule = {
	readonly writes: readonly { text: string }[];
	readonly directs: readonly { text: string }[];
	readonly resetTargetFixture: () => void;
	readonly default: () => {
		readonly extension: {
			readonly name: string;
			readonly tools?: readonly ToolRegistration[];
		};
	};
};

/** Import the fixture module by the SAME URL the loader imported. */
async function fixtureModule(): Promise<FixtureModule> {
	return (await import(TARGET_SPECIFIER)) as unknown as FixtureModule;
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

/** Boot one hermetic harness with the curation-target fixture installed. */
async function boot(): Promise<{
	opened: OpenedHarness;
	fixture: FixtureModule;
}> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-curation-wrap-"));
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
		SIGRUN_WORKSPACE_PATH: dir,
	});
	const opened = await openHarness(config, {
		identity: await seededIdentity(dir),
		extensions: [contributor],
		builtins: false,
		env: {},
		extensionEntries: [
			{
				name: "fixture-curation-target",
				entry: TARGET_SPECIFIER,
			} satisfies ResolvedExtensionInput,
		],
	});
	cleanups.push(async () => {
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	});
	const fixture = await fixtureModule();
	fixture.resetTargetFixture();
	return { opened, fixture };
}

/**
 * A `ToolExecutionApi` whose document surface is REAL: `snapshot` and
 * `commit` delegate to the harness (the hint append reads and writes the
 * actual conversation docs), while `output` captures streamed text.
 */
function toolApi(opened: OpenedHarness, conversationId: number) {
	const chunks: string[] = [];
	const api = {
		conversationId,
		env: undefined,
		output: (chunk: string | Uint8Array) => {
			chunks.push(
				typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
			);
		},
		snapshot: (token: never, id: never, ctx: never) =>
			opened.harness.snapshot(token, id, ctx),
		commit: async (change: (tx: Tx) => unknown, ctx: never) => {
			const conversation = await opened.harness.conversation(
				conversationId as ConversationId,
				BACKGROUND_CONTEXT,
			);
			if (conversation === undefined) throw new Error("conversation vanished");
			return conversation.commit(change as (tx: Tx) => unknown, ctx as never);
		},
	} as unknown as ToolExecutionApi;
	return { api, chunks };
}

/** The registry's installed `notes_write` (the WRAPPED registration). */
function registryTool(opened: OpenedHarness, name: string): ToolRegistration {
	const entry = opened.registry
		.snapshot()
		.tools()
		.find((candidate) => candidate.tool.name === name);
	if (entry === undefined) throw new Error(`tool ${name} not installed`);
	return entry.tool;
}

/** The text of a tool execution result. */
function outputText(result: { output?: { type: string; text?: string }[] }): string {
	return (result.output ?? [])
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

/** The conversation's recorded hints. */
async function hintsOf(
	opened: OpenedHarness,
	id: number,
): Promise<readonly unknown[]> {
	return (await opened.harness.snapshot(HintsDoc, id as ConversationId, BACKGROUND_CONTEXT))?.hints ?? [];
}

interface ConversationOptions {
	/** The session-meta owner stamp (absent = ownerless). */
	readonly owner?: string;
	/** The exact extension selection (absent = the installed default). */
	readonly extensions?: readonly string[];
}

/** One conversation with its owner stamped, plus a fabricated live run. */
async function liveConversation(
	opened: OpenedHarness,
	options: ConversationOptions,
): Promise<number> {
	const conversation = await opened.harness.createConversation(
		{
			ownership: { kind: "ownerless" },
			agent: {
				model: opened.defaultModel,
				...(options.extensions === undefined
					? {}
					: { extensions: options.extensions.map((name) => ({ name })) }),
			},
			init: async (tx, id) => {
				if (options.owner !== undefined) {
					const meta = await tx.doc(SessionMetaDoc, id);
					meta.owner = options.owner;
				}
			},
		},
		BACKGROUND_CONTEXT,
	);
	return conversation.id as number;
}

/**
 * Fabricate the live-run state the wrapper reads: `pi.live`'s run
 * carrying `inputs` as its input submission ids. This is the doc state a
 * real generation writes while busy (the tool call executes inside it).
 */
async function liveRunOf(
	opened: OpenedHarness,
	id: number,
	inputs: readonly number[],
): Promise<void> {
	await opened.harness.commit(async (tx) => {
		const live = await tx.doc(LiveDoc, id as ConversationId);
		live.run = {
			taskId: 1 as TaskId,
			inputs: inputs.map((input) => input as SubmissionId),
		};
	}, BACKGROUND_CONTEXT);
}

/** Record `user` as the author of one submission (the P1 doc shape). */
async function authored(
	opened: OpenedHarness,
	id: number,
	submission: number,
	user: string | undefined,
): Promise<void> {
	const conversation = await opened.harness.conversation(
		id as ConversationId,
		BACKGROUND_CONTEXT,
	);
	if (conversation === undefined) throw new Error("conversation vanished");
	await recordAuthor(
		conversation,
		{ submissionId: submission as SubmissionId },
		user,
		BACKGROUND_CONTEXT,
	);
}

// ─── The seven wrap scenarios ──────────────────────────────────────────────

describe("curation-tool wrapping (curator P9)", () => {
	test("owner-driven call becomes a hint and does not execute", { timeout: 20_000 }, async () => {
		const { opened, fixture } = await boot();
		const id = await liveConversation(opened, { owner: "alice" });
		await liveRunOf(opened, id, [1]);
		await authored(opened, id, 1, "alice");
		const { api } = toolApi(opened, id);
		const result = await registryTool(opened, "notes_write").execute(
			{ text: "deploy lesson" },
			api,
			BACKGROUND_CONTEXT,
		);
		expect(outputText(result)).toBe(
			"Noted. The curator will review this after your reply.",
		);
		// The original NEVER executed — no write record.
		expect(fixture.writes).toEqual([]);
		// The hint landed in the doc, verbatim args.
		const hints = await hintsOf(opened, id);
		expect(hints).toHaveLength(1);
		expect(hints[0]).toMatchObject({
			tool: "notes_write",
			args: { text: "deploy lesson" },
		});
	});

	test("bob's call in alice's write-shared conversation leaves no hint and says not recorded", { timeout: 20_000 }, async () => {
		const { opened, fixture } = await boot();
		const id = await liveConversation(opened, { owner: "alice" });
		// Alice shares household-write; bob's input is the run's input.
		await opened.harness.commit(async (tx) => {
			const meta = await tx.doc(SessionMetaDoc, id as ConversationId);
			meta.sharing = { scope: "household", level: "write" };
		}, BACKGROUND_CONTEXT);
		await liveRunOf(opened, id, [1]);
		await authored(opened, id, 1, "bob");
		const { api } = toolApi(opened, id);
		const result = await registryTool(opened, "notes_write").execute(
			{ text: "bob's lesson" },
			api,
			BACKGROUND_CONTEXT,
		);
		expect(outputText(result)).toBe(
			"Not recorded: this is only learned from the owner's own messages.",
		);
		expect(fixture.writes).toEqual([]);
		expect(await hintsOf(opened, id)).toEqual([]);
	});

	test("unattributed run and ownerless conversation leave no hint", { timeout: 20_000 }, async () => {
		const { opened, fixture } = await boot();
		// Unattributed: an input submission with NO author record.
		const unattributed = await liveConversation(opened, { owner: "alice" });
		await liveRunOf(opened, unattributed, [1]);
		const { api: apiA } = toolApi(opened, unattributed);
		const unattributedResult = await registryTool(opened, "notes_write").execute(
			{ text: "anonymous" },
			apiA,
			BACKGROUND_CONTEXT,
		);
		expect(outputText(unattributedResult)).toBe(
			"Not recorded: this is only learned from the owner's own messages.",
		);
		// Ownerless: an attributed input but no owner to match.
		const ownerless = await liveConversation(opened, {});
		await liveRunOf(opened, ownerless, [1]);
		await authored(opened, ownerless, 1, "alice");
		const { api: apiB } = toolApi(opened, ownerless);
		const ownerlessResult = await registryTool(opened, "notes_write").execute(
			{ text: "no owner" },
			apiB,
			BACKGROUND_CONTEXT,
		);
		expect(outputText(ownerlessResult)).toBe(
			"Not recorded: this is only learned from the owner's own messages.",
		);
		expect(fixture.writes).toEqual([]);
		expect(await hintsOf(opened, unattributed)).toEqual([]);
		expect(await hintsOf(opened, ownerless)).toEqual([]);
	});

	test("a run whose author record is not yet written fails closed", { timeout: 20_000 }, async () => {
		const { opened, fixture } = await boot();
		const id = await liveConversation(opened, { owner: "alice" });
		await liveRunOf(opened, id, [1]);
		// Record the author, then delete the entry before the call — the
		// pre-write window a tool call can land in.
		await authored(opened, id, 1, "alice");
		await opened.harness.commit(async (tx) => {
			const doc = await tx.doc(AuthorsDoc, id as ConversationId);
			doc.bySubmission = {};
		}, BACKGROUND_CONTEXT);
		const { api } = toolApi(opened, id);
		const result = await registryTool(opened, "notes_write").execute(
			{ text: "racing" },
			api,
			BACKGROUND_CONTEXT,
		);
		expect(outputText(result)).toBe(
			"Not recorded: this is only learned from the owner's own messages.",
		);
		expect(fixture.writes).toEqual([]);
		expect(await hintsOf(opened, id)).toEqual([]);
	});

	test("the wrapped tool's name, description and schema are byte-identical to the original", { timeout: 20_000 }, async () => {
		const { opened, fixture } = await boot();
		const { extension } = fixture.default();
		const original = extension.tools?.find((tool) => tool.name === "notes_write");
		if (original === undefined) throw new Error("fixture carries no notes_write");
		const wrapped = registryTool(opened, "notes_write");
		expect(wrapped.name).toBe(original.name);
		expect(wrapped.description).toBe(original.description);
		// Byte-identical: the SAME schema object travels through the wrap.
		expect(wrapped.parameters).toBe(original.parameters);
		// The unlisted direct tool is the ORIGINAL object, untouched.
		const directOriginal = extension.tools?.find(
			(tool) => tool.name === "notes_direct",
		);
		expect(registryTool(opened, "notes_direct")).toBe(directOriginal);
	});

	test("wrapping holds in a conversation whose exact extension selection omits every core extension", { timeout: 20_000 }, async () => {
		const { opened, fixture } = await boot();
		// Exact selection: ONLY the fixture extension — no sigrun.skills, no
		// core extension at all. The wrap lives in the registration, so the
		// resolved agent's notes_write is still the wrapper.
		const id = await liveConversation(opened, {
			owner: "alice",
			extensions: ["fixture-curation-target"],
		});
		await liveRunOf(opened, id, [1]);
		await authored(opened, id, 1, "alice");
		const conversation = await opened.harness.conversation(
			id as ConversationId,
			BACKGROUND_CONTEXT,
		);
		const agent = await conversation!.agent(BACKGROUND_CONTEXT);
		expect(
			agent.extensions.map((extension) => extension.name),
		).toEqual(["fixture-curation-target"]);
		const resolved = agent.tools.find((tool) => tool.name === "notes_write");
		if (resolved === undefined) throw new Error("notes_write not resolvable");
		const { api } = toolApi(opened, id);
		const result = await resolved.execute(
			{ text: "still wrapped" },
			api,
			BACKGROUND_CONTEXT,
		);
		expect(outputText(result)).toBe(
			"Noted. The curator will review this after your reply.",
		);
		expect(fixture.writes).toEqual([]);
		expect(await hintsOf(opened, id)).toHaveLength(1);
	});

	test("an unlisted tool (notes_direct) is never wrapped and writes normally", { timeout: 20_000 }, async () => {
		const { opened, fixture } = await boot();
		const id = await liveConversation(opened, { owner: "alice" });
		await liveRunOf(opened, id, [1]);
		await authored(opened, id, 1, "alice");
		const { api } = toolApi(opened, id);
		const result = await registryTool(opened, "notes_direct").execute(
			{ text: "direct note" },
			api,
			BACKGROUND_CONTEXT,
		);
		expect(outputText(result)).toBe("direct: direct note");
		expect(fixture.directs).toEqual([{ text: "direct note" }]);
		// No hint was recorded — the direct path is the extension's own.
		expect(await hintsOf(opened, id)).toEqual([]);
	});

	test("takeHints reads and clears in one commit", { timeout: 20_000 }, async () => {
		const { opened } = await boot();
		const id = await liveConversation(opened, { owner: "alice" });
		await liveRunOf(opened, id, [1, 2]);
		await authored(opened, id, 1, "alice");
		await authored(opened, id, 2, "alice");
		const { api } = toolApi(opened, id);
		const tool = registryTool(opened, "notes_write");
		await tool.execute({ text: "one" }, api, BACKGROUND_CONTEXT);
		await tool.execute({ text: "two" }, api, BACKGROUND_CONTEXT);
		expect(await hintsOf(opened, id)).toHaveLength(2);
		// Host-side take: the hints come out once, then the doc is empty.
		const conversation = await opened.harness.conversation(
			id as ConversationId,
			BACKGROUND_CONTEXT,
		);
		const taken = await takeHints(conversation!, BACKGROUND_CONTEXT);
		expect(taken.map((hint) => (hint.args as { text: string }).text)).toEqual([
			"one",
			"two",
		]);
		expect(await takeHints(conversation!, BACKGROUND_CONTEXT)).toEqual([]);
		expect(await hintsOf(opened, id)).toEqual([]);
	});

	test("skill_manage's read actions pass through to the original; mutating ones do not", { timeout: 20_000 }, async () => {
		const calls: string[] = [];
		const tool = wrapCurationTool({
			name: "skill_manage",
			description: "d",
			parameters: { type: "object" } as never,
			async execute(args: { action: string }, _api: unknown, _ctx: unknown) {
				calls.push(args.action);
				return {};
			},
		} as unknown as ToolRegistration);
		// A read outside a run PASSES THROUGH (an empty api suffices — the
		// wrapper reads nothing for a pass-through call).
		const none = {} as ToolExecutionApi;
		await tool.execute({ action: "list" } as never, none, BACKGROUND_CONTEXT);
		await tool.execute(
			{ action: "view", name: "acme-deploy" } as never,
			none,
			BACKGROUND_CONTEXT,
		);
		expect(calls).toEqual(["list", "view"]);
		// A mutating call is intercepted — never executed, no hint (no live
		// run), the not-recorded answer.
		const result = await tool.execute(
			{ action: "create", name: "acme-deploy" } as never,
			none,
			BACKGROUND_CONTEXT,
		);
		expect(calls).toEqual(["list", "view"]);
		expect(outputText(result)).toBe(
			"Not recorded: this is only learned from the owner's own messages.",
		);
	});

	test("wrapCurationTool preserves the registration fields it does not own", () => {
		// A bare registration: the wrapper must carry every extra field
		// (replay, executionMode, …) through untouched.
		const calls: string[] = [];
		const tool: ToolRegistration = {
			name: "notes_write",
			description: "d",
			parameters: { type: "object" } as never,
			replay: "safe",
			executionMode: "sequential",
			async execute() {
				calls.push("original");
				return {};
			},
		};
		const wrapped = wrapCurationTool(tool);
		expect(wrapped.replay).toBe("safe");
		expect(wrapped.executionMode).toBe("sequential");
		void wrapped.execute(
			{} as never,
			{} as unknown as ToolExecutionApi,
			BACKGROUND_CONTEXT,
		);
		// No curator run, no live run: the call is answered, never executed.
		expect(calls).toEqual([]);
	});
});
