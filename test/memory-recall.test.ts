/**
 * Memory/core contract honesty (release-readiness spec 2 §7): the
 * fixture-memory extension follows the CURRENT per-conversation recall
 * contract — no module-global recall source, no retired `submit`
 * pass-through, no retired "No conversation bound" behavior — and the
 * conversation id the recall tool scopes by is the SAME conversation the
 * settled event captured, across two conversations.
 *
 * The two-id assertion is deliberately built from TWO INDEPENDENT
 * records: the fixture records the SETTLED EVENT's `conversationId`
 * (delivered through runSettled) and, separately, the
 * `ToolExecutionApi.conversationId` the recall tool receives on each
 * call. `MemoryEventApi` intentionally carries no conversation id, so
 * neither record can be derived from the other — a wiring that settled
 * conversation A but served the tool conversation B fails here.
 *
 * Hermetic pattern (memory-seam.test.ts): faux provider + tmpdir +
 * `openHarness` — real node:sqlite storage, real run loop, no network.
 * The test imports the fixture module through the same file:// URL the
 * loader imported, so both hold ONE module instance.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";

/** The fixture-memory entry, imported by specifier (current per-conversation contract). */
const MEMORY_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-memory", "index.js"),
).href;

/** The fixture module's exports (the two independent id records + reset). */
type FixtureModule = {
	readonly settledConversationIds: number[];
	readonly recallToolConversationIds: number[];
	readonly resetMemoryFixture: () => void;
};

/** Import the fixture module by the SAME URL the loader imported. */
async function fixtureModule(): Promise<FixtureModule> {
	return (await import(MEMORY_SPECIFIER)) as unknown as FixtureModule;
}

const dirs: string[] = [];
const closes: Array<() => Promise<void>> = [];

afterAll(async () => {
	for (const close of closes.splice(0)) await close();
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

interface Boot {
	opened: OpenedHarness;
	faux: ReturnType<typeof fauxProvider>;
	fixture: FixtureModule;
}

/** Boot one hermetic harness with fixture-memory installed. */
async function bootMemory(): Promise<Boot> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-memory-recall-"));
	dirs.push(dir);
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
	// Auto-naming off: the namer would consume scripted responses.
	await writeFile(join(dir, "settings.json"), '{"namingModel": false}');
	const opened = await openHarness(config, {
		extensions: [contributor],
		// Hermetic: this suite's subject is the fixture's contract, not the
		// built-in surface.
		builtins: false,
		env: {},
		extensionSpecifiers: [MEMORY_SPECIFIER],
		settingsDir: dir,
	});
	closes.push(() => opened.harness.close(BACKGROUND_CONTEXT));
	const fixture = await fixtureModule();
	fixture.resetMemoryFixture();
	return { opened, faux, fixture };
}

/** One conversation whose scripted responses drive a recall tool call. */
async function conversationWithRecall(
	opened: OpenedHarness,
	faux: ReturnType<typeof fauxProvider>,
	marker: string,
): Promise<{ id: ConversationId; recallText: string }> {
	// Turn 1: plain answer (settles the conversation; runSettled binds its
	// transcript as that conversation's recall source).
	faux.setResponses([fauxAssistantMessage("first answer")]);
	const conversation = await opened.harness.createConversation(
		{ ownership: { kind: "ownerless" }, agent: { model: opened.defaultModel } },
		BACKGROUND_CONTEXT,
	);
	const first = await conversation.submit(
		{ type: "input", content: marker },
		BACKGROUND_CONTEXT,
	);
	const firstRecord = await first.wait(BACKGROUND_CONTEXT);
	expect(firstRecord.status).toBe("done");

	// Turn 2: the model calls memory_recall, then answers. The tool result
	// entry carries the recall text the model saw.
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("memory_recall", { query: marker })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("recall done"),
	]);
	const second = await conversation.submit(
		{ type: "input", content: "what do you remember?" },
		BACKGROUND_CONTEXT,
	);
	const secondRecord = await second.wait(BACKGROUND_CONTEXT);
	expect(secondRecord.status).toBe("done");

	const view = await conversation.context(BACKGROUND_CONTEXT);
	const toolText = view.messages
		.filter((message) => message.role === "toolResult")
		.map((message) =>
			message.role === "toolResult"
				? message.content
						.map((block) => (block.type === "text" ? block.text : ""))
						.join("")
				: "",
		)
		.join("\n");
	return { id: conversation.id, recallText: toolText };
}

test("settled-event and tool-api conversation ids match across two conversations; recall is per-conversation", async () => {
	const { opened, faux, fixture } = await bootMemory();

	// Conversation A settles, then recalls: its own marker answers.
	const a = await conversationWithRecall(opened, faux, "alpha-marker-A");
	// Conversation B settles LAST — with a module-global recall source B's
	// transcript would answer A's recall (the retired leak). Here each
	// conversation recalls its OWN transcript.
	const b = await conversationWithRecall(opened, faux, "beta-marker-B");

	// Two settled runs per conversation (turn 1 + turn 2), so the event
	// record holds both ids; the tool record holds exactly the two recall
	// calls, one per conversation.
	expect(fixture.recallToolConversationIds).toHaveLength(2);
	// The INDEPENDENT records agree: every recall tool call's api id is a
	// conversation that actually settled (and vice versa — the two tool
	// calls name exactly the two settled conversations).
	expect(new Set(fixture.recallToolConversationIds)).toEqual(
		new Set(fixture.settledConversationIds),
	);
	expect(fixture.recallToolConversationIds).toEqual([a.id, b.id]);
	expect(new Set(fixture.settledConversationIds)).toEqual(new Set([a.id, b.id]));

	// Per-conversation recall: A's recall found A's marker, NOT B's — even
	// though B settled last.
	expect(a.recallText).toContain("alpha-marker-A");
	expect(a.recallText).not.toContain("beta-marker-B");
	expect(b.recallText).toContain("beta-marker-B");
	expect(b.recallText).not.toContain("alpha-marker-A");
});

test("recall in a conversation that never settled answers No matches found (no retired 'No conversation bound' error)", async () => {
	const { opened, faux, fixture } = await bootMemory();

	// One conversation settles so a global source WOULD have content.
	const settled = await conversationWithRecall(opened, faux, "gamma-marker-C");
	expect(settled.recallText).toContain("gamma-marker-C");

	// A second conversation whose FIRST turn calls recall before any settle:
	// no source exists for it — the current contract answers "No matches
	// found." (a successful empty result), never the retired
	// "No conversation bound" isError, and never the settled conversation's
	// history.
	faux.setResponses([
		fauxAssistantMessage(
			[fauxToolCall("memory_recall", { query: "gamma-marker-C" })],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("done"),
	]);
	const fresh = await opened.harness.createConversation(
		{ ownership: { kind: "ownerless" }, agent: { model: opened.defaultModel } },
		BACKGROUND_CONTEXT,
	);
	const submission = await fresh.submit(
		{ type: "input", content: "search before settling" },
		BACKGROUND_CONTEXT,
	);
	const record = await submission.wait(BACKGROUND_CONTEXT);
	expect(record.status).toBe("done");

	const view = await fresh.context(BACKGROUND_CONTEXT);
	const toolResults = view.messages.filter(
		(message) => message.role === "toolResult",
	);
	expect(toolResults).toHaveLength(1);
	const result = toolResults[0];
	if (result === undefined || result.role !== "toolResult") {
		throw new Error("expected one tool result");
	}
	const text = result.content
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("");
	expect(text).toBe("No matches found.");
	expect(text).not.toContain("No conversation bound");
	expect(text).not.toContain("gamma-marker-C");
	expect(result.isError).not.toBe(true);

	// The fresh conversation's own settle (turn 1) is recorded, so its id
	// now appears in the event record too — but the recall above happened
	// BEFORE that settle, proving the empty answer was the no-source path.
	await vi.waitFor(
		() => expect(fixture.settledConversationIds).toContain(fresh.id),
		{ timeout: 5_000, interval: 100 },
	);
});
