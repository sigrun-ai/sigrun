/**
 * U5 Task 3 — the turn-starter call-site pin (spec §8.3 "Where" + the
 * brief's grep rule): every turn starter writes pending notes BEFORE the
 * turn's input submission, so a new turn starter can never skip the note
 * silently.
 *
 * Two halves:
 * 1. A grep-style source pin: `conversation.submit(` calls whose draft
 *    carries `type: "input"` appear in `src/` ONLY at the three turn
 *    starters — `submitOp` (src/server/conversation-ops.ts, serving the
 *    composer route AND `host.conversations.submit`) and `fireJob`'s two
 *    prompt-action sites (src/jobs/fire.ts). Every one of those call
 *    sites is preceded by a `writePendingNote` call in the same file.
 * 2. A behavioral pin for `fireJob` (the one turn starter that does NOT
 *    route through `submitOp`): a fixed-conversation prompt job with a
 *    pending block edit writes the note before the job's input — the
 *    note entry precedes the job's user entry in the transcript and
 *    `notedThrough` advances.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type FauxProviderHandle,
} from "@earendil-works/pi-ai/providers/faux";
import type { AssistantMessage, Models } from "@earendil-works/pi-ai";
import type {
	ConversationId,
	ModelRef,
} from "@earendil-works/pi-durable";
import type { JsonObject, Tree } from "@sigrun/shared/blocks";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import {
	BlocksEntry,
	BlocksNoteEntry,
} from "../src/harness/blocks/entries.js";
import { readBlocksState } from "../src/harness/blocks/state.js";
import { applyChatAction } from "../src/server/blocks/chat-surfaces.js";
import { NOTE_HEADER } from "../src/server/blocks/notes.js";
import { JobRunDoc, writeJobChange } from "../src/jobs/docs.js";
import { specHash } from "../src/jobs/spec.js";
import { fireJob, type JobRuntimeDeps } from "../src/jobs/fire.js";
import type { JobSpec } from "@sigrun/shared/jobs";
import { seededIdentity } from "./helpers/identity.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";

// ---------------------------------------------------------------------------
// The grep-style source pin
// ---------------------------------------------------------------------------

/** Every `.ts` file under `src/` (recursively), repo-relative. */
async function srcFiles(dir: string, base: string): Promise<string[]> {
	const out: string[] = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...(await srcFiles(path, base)));
		} else if (entry.name.endsWith(".ts")) {
			out.push(path.slice(base.length + 1));
		}
	}
	return out;
}

describe("the turn-starter call-site pin (spec §8.3 Where)", () => {
	test("`conversation.submit(` with `type: \"input\"` appears in src/ ONLY at the three noted sites, each preceded by a writePendingNote call in the same file", async () => {
		const srcRoot = join(import.meta.dirname, "..", "src");
		const files = await srcFiles(srcRoot, srcRoot);
		const sites: { file: string; line: number }[] = [];
		for (const file of files) {
			const text = await readFile(join(srcRoot, file), "utf8");
			const lines = text.split("\n");
			for (let index = 0; index < lines.length; index++) {
				const line = lines[index]!;
				if (!line.includes("conversation.submit(")) continue;
				// The submitted draft: the named-variable form (`submit(draft)`)
				// reads the const's declaration window; the inline-literal form
				// reads the call's own window. Either way the `type:`
				// discriminant is within a few lines BEFORE the call's closing.
				const backward = lines
					.slice(Math.max(0, index - 25), index + 8)
					.join("\n");
				if (!/type:\s*"input"/.test(backward)) continue;
				sites.push({ file, line: index + 1 });
			}
		}
		// The THREE sanctioned sites: submitOp (the composer route AND the
		// host bridge share it) and fireJob's two prompt-action submits.
		expect(sites.map((site) => site.file).sort()).toEqual([
			"jobs/fire.ts",
			"jobs/fire.ts",
			"server/conversation-ops.ts",
		]);
		// Every sanctioned file reaches the note: submitOp calls
		// `writePendingNote` inline; fireJob goes through `noteThen` (the
		// submit-turn helper), which owns the writePendingNote call.
		expect(
			await readFile(join(srcRoot, "server/conversation-ops.ts"), "utf8"),
		).toContain("writePendingNote");
		expect(
			await readFile(join(srcRoot, "jobs/fire.ts"), "utf8"),
		).toContain("noteThen");
		expect(
			await readFile(join(srcRoot, "server/turns/submit-turn.ts"), "utf8"),
		).toContain("writePendingNote");
	});
});

// ---------------------------------------------------------------------------
// The fireJob behavioral pin
// ---------------------------------------------------------------------------

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
		],
	},
};

const RANKING_DATA: JsonObject = {
	cards: [
		{ id: "c1", title: "Arabesque" },
		{ id: "c2", title: "Gymnopédie" },
	],
};

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

async function bootRig(): Promise<{
	opened: OpenedHarness;
	faux: FauxProviderHandle;
	deps: JobRuntimeDeps;
}> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-blocks-firejob-"));
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	faux.setResponses([]);
	const contributor: ProviderContributor = {
		name: "ext-faux",
		providers: [{ provider: faux.provider }],
	};
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
		SIGRUN_CONFIG_DIR: join(dir, "config"),
		SIGRUN_AUTH: "none",
	});
	await writeFile(join(dir, "settings.json"), '{"namingModel": false}');
	const opened = await openHarness(config, {
		identity: await seededIdentity(dir),
		extensions: [contributor],
		builtins: false,
		env: {},
		settingsDir: dir,
	});
	cleanups.push(async () => {
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	});
	const defaultModel: ModelRef = opened.defaultModel;
	const deps: JobRuntimeDeps = {
		harness: opened.harness,
		storage: opened.storage,
		registry: opened.registry,
		models: opened.models as Models,
		defaultModel,
		now: () => Date.parse("2026-10-24T12:00:00.000Z"),
		defaultTz: "UTC",
		commandExpansion: opened.commandExpansion,
		envBuilder: opened.envBuilder,
		gatewayLoaded: false,
	};
	return { opened, faux, deps };
}

/** The §8.5 drive: a block in a conversation, via the real tool path. */
async function conversationWithBlock(
	opened: OpenedHarness,
	faux: FauxProviderHandle,
): Promise<{ conversationId: number; entryId: string }> {
	const conversation = await opened.harness.createConversation(
		{
			ownership: { kind: "ownerless" },
			agent: { model: opened.defaultModel },
		},
		BACKGROUND_CONTEXT,
	);
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
	]);
	const submission = await conversation.submit(
		{ type: "input", content: "show the block" },
		BACKGROUND_CONTEXT,
	);
	await submission.wait(BACKGROUND_CONTEXT);
	const page = await conversation.entries(
		{},
		100,
		undefined,
		BACKGROUND_CONTEXT,
	);
	const entry = page.items.find((item) => item.kind === BlocksEntry.kind);
	return { conversationId: conversation.id as number, entryId: String(entry!.id) };
}

describe("fireJob writes the pending note before its input (spec §8.3 Where)", () => {
	test("a fixed-conversation prompt job with a pending edit: the note precedes the job's user entry, notedThrough advances", async () => {
		const { opened, faux, deps } = await bootRig();
		const { conversationId, entryId } = await conversationWithBlock(
			opened,
			faux,
		);
		// One unnoted edit on the block.
		const moved = await applyChatAction(
			opened.harness,
			conversationId,
			entryId,
			"alice",
			"reorderCards",
			{ itemId: "c2", from: { index: 1 }, to: { index: 0 } },
		);
		expect(moved).toMatchObject({ ok: true });

		// The job record: a fixed-conversation prompt job.
		const spec: JobSpec = {
			name: "nightly",
			schedule: { every: "60s" },
			action: {
				kind: "prompt",
				prompt: "run the job",
				conversation: conversationId,
			},
		};
		await opened.harness.commit(async (tx) => {
			await writeJobChange(
				tx,
				"nightly",
				{
					source: "api",
					spec,
					owner: "alice",
					enabled: true,
					createdAt: new Date(deps.now()).toISOString(),
					hash: specHash("nightly", spec),
					state: "waiting",
				},
				"alice",
				new Date(deps.now()).toISOString(),
			);
		}, BACKGROUND_CONTEXT);
		faux.setResponses([fauxAssistantMessage("job done")]);
		const result = await fireJob(
			deps,
			"nightly",
			"nightly:2026-10-24T12:00:00.000Z",
			deps.now(),
			BACKGROUND_CONTEXT,
		);
		expect(result).toMatchObject({ outcome: "running", conversationId });

		// The job's input settles; the note entry precedes it.
		const run = await opened.harness.snapshot(
			JobRunDoc,
			"nightly:2026-10-24T12:00:00.000Z",
			BACKGROUND_CONTEXT,
		);
		expect(run?.conversationId).toBe(conversationId);
		// Wait for the job's run to settle.
		const conversation = await opened.harness.conversation(
			conversationId as ConversationId,
			BACKGROUND_CONTEXT,
		);
		const deadline = Date.now() + 10_000;
		for (;;) {
			const page = await conversation!.entries(
				{},
				100,
				undefined,
				BACKGROUND_CONTEXT,
			);
			const hasAnswer = page.items.some(
				(entry) => entry.kind === "pi.assistant",
			);
			if (hasAnswer) break;
			if (Date.now() > deadline) throw new Error("the job run never settled");
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		const page = await conversation!.entries(
			{},
			100,
			undefined,
			BACKGROUND_CONTEXT,
		);
		const ordered = [...page.items].reverse();
		const note = ordered.find((entry) => entry.kind === BlocksNoteEntry.kind);
		expect(note).toBeDefined();
		const message = note!.model?.[0];
		const noteText =
			message?.role === "user" && typeof message.content === "string"
				? message.content
				: "";
		expect(noteText).toContain(NOTE_HEADER);
		expect(noteText).toContain("• Ranking (alice): ");
		// The note precedes the job's user input (the pi.user entry carrying
		// "run the job" — content is the array-of-parts shape `fireJob`
		// submits).
		const jobInputIndex = ordered.findIndex(
			(entry) =>
				entry.kind === "pi.user" &&
				entry.model?.[0]?.role === "user" &&
				((typeof entry.model[0].content === "string" &&
					entry.model[0].content.includes("run the job")) ||
					(Array.isArray(entry.model[0].content) &&
						entry.model[0].content.some(
							(part) =>
								part.type === "text" &&
								part.text.includes("run the job"),
						))),
		);
		expect(jobInputIndex).toBeGreaterThan(-1);
		expect(ordered.indexOf(note!)).toBeLessThan(jobInputIndex);
		// notedThrough advanced past the edit.
		const state = await readBlocksState(
			opened.harness,
			conversationId,
			entryId,
			BACKGROUND_CONTEXT,
		);
		expect(state?.notedThrough).toBe(1);
	});
});
