/**
 * Task B1 (UI refresh): turn grouping over the pi-durable entry wire.
 *
 * `@sigrun/shared/turns` folds a flat entry list into renderable turns:
 * consecutive `pi.assistant` + `pi.tool-result` entries form ONE
 * assistant turn; `pi.user` is its own turn; everything else (compaction
 * records, summaries) is an `other` turn and also ends the assistant
 * run. The entry/message/block types are deliberately loose so both
 * clients' wire types fit structurally — the passthrough test pins that.
 *
 * Fixtures are synthetic (tests own their literals).
 */

import { describe, expect, it } from "vitest";
import {
	activityLabel,
	attachmentNames,
	BLOCKS_ANSWER_KIND,
	BLOCKS_KIND,
	BLOCKS_NOTE_KIND,
	CONTEXT_MARK_KIND,
	entryAttachments,
	EXPANDED_USER_KIND,
	expandedUserEntry,
	groupTurns,
	isUserInput,
	previewArgument,
	toolPreview,
	typedText,
	unattachedText,
	USER_INPUT_KINDS,
	USER_KIND,
	type ContextMarkData,
	type ToolCall,
	type TurnBlock,
	type TurnEntry,
} from "@sigrun/shared/turns";

/** Synthetic attachment record used across the helpers' tests: a
 *  workspace-delivered markdown upload covering model part 0. */
const attachedNotes = {
	path: "uploads/7/notes.md",
	name: "notes.md",
	mime: "text/markdown",
	bytes: 512,
	delivery: "workspace",
	parts: [0],
} as const;

const userEntry = (id: number, text: string): TurnEntry => ({
	id,
	kind: "pi.user",
	model: [{ role: "user", content: [{ type: "text", text }] }],
});

const assistantEntry = (id: number, blocks: readonly TurnBlock[]): TurnEntry => ({
	id,
	kind: "pi.assistant",
	model: [{ role: "assistant", content: blocks }],
});

const toolResultEntry = (
	id: number,
	toolCallId: string,
	isError = false,
): TurnEntry => ({
	id,
	kind: "pi.tool-result",
	model: [
		{
			role: "toolResult",
			content: [{ type: "toolResult", text: "…" }],
			toolCallId,
			toolName: "bash",
			isError,
		},
	],
});

const asAssistant = (turn: ReturnType<typeof groupTurns>[number]) => {
	if (turn.kind !== "assistant") throw new Error(`expected assistant turn`);
	return turn;
};

describe("groupTurns", () => {
	it("folds a root-filesystem run into a user turn and one assistant turn", () => {
		const turns = groupTurns([
			userEntry(1, "What is at the filesystem root?"),
			assistantEntry(2, [
				{ type: "thinking", thinking: "List the root directory first." },
				{
					type: "toolCall",
					id: "call-root",
					name: "bash",
					arguments: { command: "ls /" },
				},
			]),
			toolResultEntry(3, "call-root"),
			assistantEntry(4, [{ type: "text", text: "The root has `bin` and `etc`." }]),
		]);
		expect(turns.map((turn) => turn.kind)).toEqual(["user", "assistant"]);
		const assistant = asAssistant(turns[1]!);
		expect(assistant.entries.map((entry) => entry.id)).toEqual([2, 3, 4]);
		expect(assistant.lastEntryId).toBe(4);
		expect(assistant.thinking).toEqual(["List the root directory first."]);
		expect(assistant.text).toBe("The root has `bin` and `etc`.");
		expect(assistant.tools).toEqual([
			{
				callId: "call-root",
				name: "bash",
				preview: "ls /",
				resultEntryId: 3,
				isError: false,
			},
		]);
		expect(activityLabel(assistant)).toBe("Thinking · 1 tool");
	});

	it("keeps an aborted tool-only turn: no result, no text, count-only label", () => {
		const turns = groupTurns([
			userEntry(1, "Read my notes"),
			assistantEntry(2, [
				{
					type: "toolCall",
					id: "call-read",
					name: "read",
					arguments: { path: "notes/todo.txt" },
				},
			]),
		]);
		expect(turns.map((turn) => turn.kind)).toEqual(["user", "assistant"]);
		const assistant = asAssistant(turns[1]!);
		expect(assistant.tools).toEqual([
			{
				callId: "call-read",
				name: "read",
				preview: "notes/todo.txt",
				resultEntryId: undefined,
				isError: false,
			},
		]);
		expect(assistant.text).toBe("");
		expect(activityLabel(assistant)).toBe("1 tool");
	});

	it("a compaction entry is an `other` turn that separates two assistant runs", () => {
		const compaction: TurnEntry = { id: 3, kind: "pi.compacted" };
		const turns = groupTurns([
			userEntry(1, "First question"),
			assistantEntry(2, [{ type: "text", text: "First answer." }]),
			compaction,
			userEntry(4, "Second question"),
			assistantEntry(5, [{ type: "text", text: "Second answer." }]),
		]);
		expect(turns.map((turn) => turn.kind)).toEqual([
			"user",
			"assistant",
			"other",
			"user",
			"assistant",
		]);
		const other = turns[2]!;
		if (other.kind !== "other") throw new Error("expected other turn");
		expect(other.entry).toBe(compaction); // the entry itself, not a copy
		// The runs stayed separate — the compaction ended the first one.
		expect(asAssistant(turns[1]!).text).toBe("First answer.");
		expect(asAssistant(turns[4]!).text).toBe("Second answer.");
	});

	it("joins the turn's text blocks with blank lines", () => {
		const turns = groupTurns([
			userEntry(1, "Explain"),
			assistantEntry(2, [{ type: "text", text: "First paragraph." }]),
			toolResultEntry(3, "call-unmatched"), // no toolCall block → ignored
			assistantEntry(4, [
				{ type: "text", text: "Second paragraph." },
				{ type: "text", text: "Third." },
			]),
		]);
		expect(asAssistant(turns[1]!).text).toBe(
			"First paragraph.\n\nSecond paragraph.\n\nThird.",
		);
	});

	it("marks a failed tool result on its call", () => {
		const turns = groupTurns([
			assistantEntry(1, [
				{
					type: "toolCall",
					id: "call-bad",
					name: "bash",
					arguments: { command: "make check" },
				},
			]),
			toolResultEntry(2, "call-bad", true),
		]);
		const tool = asAssistant(turns[0]!).tools[0]!;
		expect(tool.isError).toBe(true);
		expect(tool.resultEntryId).toBe(2);
	});

	it("passes richer wire entries through structurally, unmodified", () => {
		const wire = {
			id: 1,
			kind: "pi.user",
			model: [{ role: "user", content: "hello" }],
			conversationId: 42,
			byTaskId: 7,
		};
		const turns = groupTurns([wire]);
		expect(turns[0]).toEqual({ kind: "user", entry: wire });
	});

	// Task 2c: an expanded input is placed as ONE entry — kind
	// `sigrun.user.expanded` with `data {typed, command}` and the EXPANDED
	// text on `model` (pi-durable's `entry` REPLACES the `pi.user` kind) —
	// so the grouping, not the renderers, must recognise it as a user turn.
	it("groups a sigrun.user.expanded entry as a USER turn exposing typed and expanded text", () => {
		const expanded = {
			id: 1,
			kind: EXPANDED_USER_KIND,
			data: { typed: "/review concurrency", command: "review" },
			model: [
				{
					role: "user",
					content: [{ type: "text", text: "Review with focus: concurrency" }],
				},
			],
		};
		const turns = groupTurns([expanded]);
		expect(turns.map((turn) => turn.kind)).toEqual(["user"]);
		const turn = turns[0]!;
		if (turn.kind !== "user") throw new Error("expected a user turn");
		// The entry passes through whole — both texts stay reachable.
		expect(turn.entry).toBe(expanded);
		expect(expandedUserEntry(turn.entry)).toEqual({
			typed: "/review concurrency",
			command: "review",
		});
		expect(turn.entry.model?.[0]?.content).toEqual([
				{ type: "text", text: "Review with focus: concurrency" },
			]);
	});

	// U5 Task 4 (spec §8.2/§8.3): the chat-blocks kinds. The fixture mirrors
	// the entry order a REAL `show_blocks` run produces (recorded from
	// test/blocks-chat-tools.test.ts: pi.user → pi.system → pi.assistant with
	// the toolCall → sigrun.blocks → pi.tool-result → pi.assistant text).
	it("folds a show_blocks run into one assistant turn whose timeline is blocks, note, text, with tools empty", () => {
		const turns = groupTurns([
			userEntry(1, "show the ranking"),
			{ id: 2, kind: "pi.system" },
			assistantEntry(3, [
				{
					type: "toolCall",
					id: "call-blocks",
					name: "show_blocks",
					arguments: { title: "Ranking" },
				},
			]),
			{
				id: 4,
				kind: BLOCKS_KIND,
				data: {
					title: "Ranking",
					tree: { v: 1, root: { type: "markdown", text: "…" } },
					data: {},
				},
			},
			toolResultEntry(5, "call-blocks"),
			{
				id: 6,
				kind: BLOCKS_NOTE_KIND,
				model: [
					{
						role: "user",
						content: [
							{ type: "text", text: "UI changes: Ranking (alice): moved c2" },
						],
					},
				],
				data: { advance: [{ entryId: "4", through: 1 }] },
			},
			assistantEntry(7, [{ type: "text", text: "Here is the ranking." }]),
		]);
		// pi.system is an `other` turn (the boot record), then one user and
		// ONE assistant turn — the blocks + note entries ride the pending
		// turn (a boundary note mid-run must never split it).
		expect(turns.map((turn) => turn.kind)).toEqual([
			"user",
			"other",
			"assistant",
		]);
		const assistant = asAssistant(turns[2]!);
		expect(assistant.entries.map((entry) => entry.id)).toEqual([3, 4, 5, 6, 7]);
		// The show_blocks call is left OUT of tools (the activity line never
		// counts it) but its result still joins: the tool is not counted, yet
		// a later real tool call on the same turn still matches its result.
		expect(assistant.tools).toEqual([]);
		expect(
			assistant.timeline.map((event) =>
				event.kind === "blocks" || event.kind === "note"
					? `${event.kind}:${event.entryId}`
					: event.kind,
			),
		).toEqual(["blocks:4", "note:6", "text"]);
		expect(assistant.text).toBe("Here is the ranking.");
	});

	it("a sigrun.blocks entry trailing a settled run still rides the assistant turn", () => {
		// groupTurns has no turn-boundary signal: a blocks entry arriving
		// after the run's last text is inside the still-pending assistant
		// turn (the note-at-a-boundary rule's flip side — the grouping
		// errs toward keeping the run's artifacts together).
		const turns = groupTurns([
			userEntry(1, "hi"),
			assistantEntry(2, [{ type: "text", text: "hello" }]),
			{
				id: 3,
				kind: BLOCKS_KIND,
				data: { title: "T", tree: { v: 1, root: { type: "markdown", text: "x" } }, data: {} },
			},
		]);
		expect(turns.map((turn) => turn.kind)).toEqual(["user", "assistant"]);
		expect(
			asAssistant(turns[1]!).timeline.map((event) =>
				event.kind === "blocks" ? `blocks:${event.entryId}` : event.kind,
			),
		).toEqual(["text", "blocks:3"]);
	});

	it("a sigrun.blocks entry with NO pending run starts an assistant turn", () => {
		// A blocks/note entry is a run artifact, never a standalone record:
		// with no pending turn (e.g. after a compaction flush) it opens an
		// empty assistant turn whose timeline still renders the block row —
		// an `other` turn would print "unsupported entry kind".
		const turns = groupTurns([
			userEntry(1, "hi"),
			{
				id: 2,
				kind: BLOCKS_KIND,
				data: { title: "T", tree: { v: 1, root: { type: "markdown", text: "x" } }, data: {} },
			},
		]);
		expect(turns.map((turn) => turn.kind)).toEqual(["user", "assistant"]);
		expect(
			asAssistant(turns[1]!).timeline.map((event) =>
				event.kind === "blocks" ? `blocks:${event.entryId}` : event.kind,
			),
		).toEqual(["blocks:2"]);
	});

	it("a note entry after a compaction flush renders as a note, not unsupported", () => {
		// Auto-compaction lands at run end; the next turn's note is written
		// AFTER the pi.compaction entry — the compaction flushed the pending
		// turn, so the note must open a fresh assistant turn.
		const turns = groupTurns([
			userEntry(1, "hi"),
			assistantEntry(2, [{ type: "text", text: "hello" }]),
			{ id: 3, kind: "pi.compaction" },
			{
				id: 4,
				kind: BLOCKS_NOTE_KIND,
				model: [
					{
						role: "user",
						content: [{ type: "text", text: "UI changes: T (alice): moved c1" }],
					},
				],
				data: { advance: [{ entryId: "2", through: 1 }] },
			},
		]);
		expect(turns.map((turn) => turn.kind)).toEqual([
			"user",
			"assistant",
			"other",
			"assistant",
		]);
		expect(
			asAssistant(turns[3]!).timeline.map((event) =>
				event.kind === "note" ? `note:${event.entryId}` : event.kind,
			),
		).toEqual(["note:4"]);
	});

	it("a mark renders before the entry it names", () => {
		const mark: TurnEntry = {
			id: 5,
			kind: CONTEXT_MARK_KIND,
			data: { at: 3, label: "New sitting · Garden" } satisfies ContextMarkData,
		};
		const turns = groupTurns([
			userEntry(1, "First question"),
			assistantEntry(2, [{ type: "text", text: "First answer." }]),
			userEntry(3, "Second question"),
			assistantEntry(4, [{ type: "text", text: "Second answer." }]),
			mark,
		]);
		expect(turns.map((turn) => turn.kind)).toEqual([
			"user",
			"assistant",
			"mark",
			"user",
			"assistant",
		]);
		const markTurn = turns[2]!;
		if (markTurn.kind !== "mark") throw new Error("expected a mark turn");
		expect(markTurn.entry).toBe(mark);
		expect(markTurn.label).toBe("New sitting · Garden");
	});

	it("the latest mark for the same entry wins", () => {
		const turns = groupTurns([
			userEntry(1, "First question"),
			assistantEntry(2, [{ type: "text", text: "First answer." }]),
			userEntry(3, "Second question"),
			{
				id: 4,
				kind: CONTEXT_MARK_KIND,
				data: { at: 3, label: "First mark" } satisfies ContextMarkData,
			},
			{
				id: 5,
				kind: CONTEXT_MARK_KIND,
				data: { at: 3, label: "Second mark" } satisfies ContextMarkData,
			},
		]);
		expect(turns.map((turn) => turn.kind)).toEqual([
			"user",
			"assistant",
			"mark",
			"user",
		]);
		const markTurn = turns[2]!;
		if (markTurn.kind !== "mark") throw new Error("expected a mark turn");
		expect(markTurn.label).toBe("Second mark");
	});

	it("a mark naming an absent entry is dropped", () => {
		const turns = groupTurns([
			userEntry(1, "First question"),
			assistantEntry(2, [{ type: "text", text: "First answer." }]),
			{
				id: 3,
				kind: CONTEXT_MARK_KIND,
				data: { at: 99, label: "Absent mark" } satisfies ContextMarkData,
			},
		]);
		expect(turns.map((turn) => turn.kind)).toEqual([
			"user",
			"assistant",
		]);
	});

	it("a malformed mark payload is dropped", () => {
		const turns = groupTurns([
			userEntry(1, "First question"),
			assistantEntry(2, [{ type: "text", text: "First answer." }]),
			{
				id: 3,
				kind: CONTEXT_MARK_KIND,
				data: { at: "not-a-number", label: "Bad at" },
			},
			{
				id: 4,
				kind: CONTEXT_MARK_KIND,
				data: { at: 2, label: "" },
			},
			{
				id: 5,
				kind: CONTEXT_MARK_KIND,
				data: { at: 2, label: " \t\n " },
			},
			{
				id: 6,
				kind: CONTEXT_MARK_KIND,
				data: { at: 2 },
			},
		]);
		expect(turns.map((turn) => turn.kind)).toEqual([
			"user",
			"assistant",
		]);
	});

	it("a mark naming a blocks entry splits the run into its own assistant turn", () => {
		const turns = groupTurns([
			userEntry(1, "show the ranking"),
			assistantEntry(2, [
				{
					type: "toolCall",
					id: "call-blocks",
					name: "show_blocks",
					arguments: { title: "Ranking" },
				},
			]),
			{
				id: 3,
				kind: BLOCKS_KIND,
				data: {
					title: "Ranking",
					tree: { v: 1, root: { type: "markdown", text: "…" } },
					data: {},
				},
			},
			toolResultEntry(4, "call-blocks"),
			{
				id: 5,
				kind: CONTEXT_MARK_KIND,
				data: { at: 3, label: "After blocks" } satisfies ContextMarkData,
			},
			assistantEntry(6, [{ type: "text", text: "Here is the ranking." }]),
		]);
		expect(turns.map((turn) => turn.kind)).toEqual([
			"user",
			"assistant",
			"mark",
			"assistant",
		]);
		const markTurn = turns[2]!;
		if (markTurn.kind !== "mark") throw new Error("expected a mark turn");
		expect(markTurn.label).toBe("After blocks");
	});

	it("a sigrun.blocks.answer entry is a USER turn (like the expanded kind)", () => {
		const turns = groupTurns([
			userEntry(1, "show the ranking"),
			assistantEntry(2, [{ type: "text", text: "Here." }]),
			{
				id: 3,
				kind: BLOCKS_ANSWER_KIND,
				data: { entryId: "4", action: "submitRanking", payload: null, state: {} },
				model: [
					{
						role: "user",
						content: [{ type: "text", text: "Submitted 'Ranking': …" }],
					},
				],
			},
			assistantEntry(4, [{ type: "text", text: "Thanks!" }]),
		]);
		expect(turns.map((turn) => turn.kind)).toEqual([
			"user",
			"assistant",
			"user",
			"assistant",
		]);
	});

	it("a show_blocks call leaves the turn's tools alone even beside real tools", () => {
		const turns = groupTurns([
			userEntry(1, "show and list"),
			assistantEntry(2, [
				{
					type: "toolCall",
					id: "call-blocks",
					name: "show_blocks",
					arguments: { title: "Ranking" },
				},
				{
					type: "toolCall",
					id: "call-bash",
					name: "bash",
					arguments: { command: "ls /" },
				},
			]),
			toolResultEntry(3, "call-blocks"),
			toolResultEntry(4, "call-bash"),
			assistantEntry(5, [{ type: "text", text: "done" }]),
		]);
		const assistant = asAssistant(turns[1]!);
		expect(assistant.tools.map((tool) => tool.name)).toEqual(["bash"]);
		expect(
			assistant.timeline.map((event) =>
				event.kind === "tool" ? `tool:${event.tool.name}` : event.kind,
			),
		).toEqual(["tool:bash", "text"]);
	});

	it("an expanded user entry ends the assistant run like a pi.user entry", () => {
		const turns = groupTurns([
			userEntry(1, "First question"),
			assistantEntry(2, [{ type: "text", text: "First answer." }]),
			{
				id: 3,
				kind: EXPANDED_USER_KIND,
				data: { typed: "/skill:greet hej", command: "skill:greet" },
				model: [
					{
						role: "user",
						content: [{ type: "text", text: "<skill name=\"greet\">…</skill>" }],
					},
				],
			},
			assistantEntry(4, [{ type: "text", text: "Second answer." }]),
		]);
		expect(turns.map((turn) => turn.kind)).toEqual([
			"user",
			"assistant",
			"user",
			"assistant",
		]);
		expect(asAssistant(turns[1]!).text).toBe("First answer.");
		expect(asAssistant(turns[3]!).text).toBe("Second answer.");
	});
});

describe("expandedUserEntry", () => {
	it("narrows only the expanded kind with a non-empty string typed", () => {
		expect(expandedUserEntry({ kind: "pi.user", data: { typed: "/x" } })).toBeUndefined();
		expect(expandedUserEntry({ kind: EXPANDED_USER_KIND })).toBeUndefined();
		expect(
			expandedUserEntry({ kind: EXPANDED_USER_KIND, data: { typed: "" } }),
		).toBeUndefined();
		expect(
			expandedUserEntry({ kind: EXPANDED_USER_KIND, data: { typed: "/review x" } }),
		).toEqual({ typed: "/review x" });
	});
});

describe("toolPreview", () => {
	it("shows the bash command", () => {
		expect(toolPreview("bash", { command: "git status" })).toBe("git status");
	});

	it("shows the path for the file tools", () => {
		expect(toolPreview("read", { path: "src/index.ts" })).toBe("src/index.ts");
		expect(toolPreview("write", { path: "out.txt", content: "x" })).toBe(
			"out.txt",
		);
		expect(toolPreview("edit", { path: "a.ts" })).toBe("a.ts");
		expect(toolPreview("ls", { path: "src/" })).toBe("src/");
		expect(toolPreview("find", { path: ".", pattern: "*.ts" })).toBe(".");
	});

	it("shows the grep pattern", () => {
		expect(toolPreview("grep", { pattern: "TODO" })).toBe("TODO");
	});

	it("falls back to the first string-valued argument for other tools", () => {
		expect(
			toolPreview("webfetch", { url: "https://example.invalid", mode: "raw" }),
		).toBe("https://example.invalid");
		expect(toolPreview("mystery", { count: 3, label: "build" })).toBe("build");
	});

	it('returns "" when nothing fits', () => {
		expect(toolPreview("bash", {})).toBe("");
		expect(toolPreview("mystery", { count: 2 })).toBe("");
		expect(toolPreview("read", undefined)).toBe("");
	});

	it("keeps only the first line", () => {
		expect(toolPreview("bash", { command: "echo one\necho two" })).toBe(
			"echo one",
		);
	});

	it("truncates to 80 characters with an ellipsis", () => {
		const shown = toolPreview("bash", { command: "x".repeat(120) });
		expect(shown).toBe(`${"x".repeat(80)}…`);
		expect(shown.length).toBe(81);
		// Exactly 80 is not truncated.
		expect(toolPreview("bash", { command: "y".repeat(80) })).toBe(
			"y".repeat(80),
		);
	});
});

describe("previewArgument", () => {
	it("returns the full argument the preview truncates (no line or length cut)", () => {
		const multiLine = "echo one\necho two";
		expect(previewArgument("bash", { command: multiLine })).toBe(multiLine);
		const long = `git commit -m ${"x".repeat(200)}`;
		expect(previewArgument("bash", { command: long })).toBe(long);
	});

	it("selects the same argument as the preview (name key, then first string)", () => {
		expect(previewArgument("read", { path: "src/index.ts" })).toBe(
			"src/index.ts",
		);
		expect(previewArgument("grep", { pattern: "TODO", path: "src" })).toBe(
			"TODO",
		);
		expect(
			previewArgument("webfetch", { url: "https://example.invalid", mode: "raw" }),
		).toBe("https://example.invalid");
	});

	it("returns undefined when nothing fits", () => {
		expect(previewArgument("bash", {})).toBeUndefined();
		expect(previewArgument("mystery", { count: 2 })).toBeUndefined();
		expect(previewArgument("read", undefined)).toBeUndefined();
	});
});

describe("input kinds and attachment helpers", () => {
	it("USER_INPUT_KINDS pins the three user-input entry kinds", () => {
		expect([...USER_INPUT_KINDS].sort()).toEqual(
			["pi.user", "sigrun.user", "sigrun.user.expanded"].sort(),
		);
	});

	it("isUserInput is true for the three user-input kinds", () => {
		expect(isUserInput({ kind: "pi.user" })).toBe(true);
		expect(isUserInput({ kind: USER_KIND })).toBe(true);
		expect(isUserInput({ kind: EXPANDED_USER_KIND })).toBe(true);
	});

	it("isUserInput is false for non-user-input kinds", () => {
		expect(isUserInput({ kind: BLOCKS_ANSWER_KIND })).toBe(false);
		expect(isUserInput({ kind: "pi.assistant" })).toBe(false);
		expect(isUserInput({ kind: "pi.tool-result" })).toBe(false);
		expect(isUserInput({ kind: "pi.compaction" })).toBe(false);
	});

	it("entryAttachments returns the records of a sigrun.user entry", () => {
		const entry = {
			kind: USER_KIND,
			data: { attachments: [attachedNotes] },
		};
		expect(entryAttachments(entry)).toEqual([attachedNotes]);
	});

	it("entryAttachments is [] for pi.user and unrelated kinds", () => {
		expect(entryAttachments({ kind: "pi.user" })).toEqual([]);
		expect(entryAttachments({ kind: "pi.assistant" })).toEqual([]);
		expect(entryAttachments({ kind: USER_KIND })).toEqual([]);
		expect(
			entryAttachments({ kind: USER_KIND, data: {} }),
		).toEqual([]);
	});

	it("entryAttachments reads sigrun.user.expanded data too", () => {
		const entry = {
			kind: EXPANDED_USER_KIND,
			data: { typed: "/x", attachments: [attachedNotes] },
		};
		expect(entryAttachments(entry)).toEqual([attachedNotes]);
	});

	it("entryAttachments drops malformed items", () => {
		const entry = {
			kind: USER_KIND,
			data: {
				attachments: [
					attachedNotes,
					// Missing parts — dropped.
					{
						path: "uploads/7/broken.md",
						name: "broken.md",
						mime: null,
						bytes: null,
						delivery: "workspace",
					},
					// Non-object — dropped.
					"junk",
				],
			},
		};
		expect(entryAttachments(entry)).toEqual([attachedNotes]);
	});

	it("typedText of a sigrun.user entry excludes attachment parts", () => {
		const entry = {
			kind: USER_KIND,
			model: [
				{
					role: "user",
					content: [
						{ type: "text", text: "[Attached: uploads/7/notes.md]" },
						{ type: "text", text: "what's in here?" },
					],
				},
			],
			data: { attachments: [attachedNotes] },
		};
		expect(typedText(entry)).toBe("what's in here?");
	});

	it("typedText of an attachments-only entry is the empty string", () => {
		const entry = {
			kind: USER_KIND,
			model: [
				{
					role: "user",
					content: [{ type: "text", text: "[Attached: uploads/7/notes.md]" }],
				},
			],
			data: { attachments: [attachedNotes] },
		};
		expect(typedText(entry)).toBe("");
	});

	it("typedText of an expanded entry is data.typed", () => {
		const entry = {
			kind: EXPANDED_USER_KIND,
			data: { typed: "/skill:greet hej", attachments: [attachedNotes] },
			model: [
				{
					role: "user",
					content: [
						{ type: "text", text: "[Attached: uploads/7/notes.md]" },
						{ type: "text", text: "<skill name=\"greet\">…</skill>" },
					],
				},
			],
		};
		expect(typedText(entry)).toBe("/skill:greet hej");
	});

	it("typedText of an expanded entry with empty or missing typed yields an empty string", () => {
		const model = [
			{
				role: "user",
				content: [{ type: "text", text: "<skill name=\"greet\">body</skill>" }],
			},
		];
		expect(
			typedText({ kind: EXPANDED_USER_KIND, data: { typed: "" }, model }),
		).toBe("");
		expect(typedText({ kind: EXPANDED_USER_KIND, data: {}, model })).toBe("");
		expect(typedText({ kind: EXPANDED_USER_KIND, model })).toBe("");
	});

	it.each([
		["unknown delivery", { delivery: "carrier-pigeon" }],
		["wrong-typed mime", { mime: 42 }],
		["wrong-typed bytes", { bytes: "512" }],
		["non-numeric parts element", { parts: ["0"] }],
	])("entryAttachments drops a record with %s", (_label, patch) => {
		const entry = {
			kind: USER_KIND,
			data: { attachments: [{ ...attachedNotes, ...patch }] },
		};
		expect(entryAttachments(entry)).toEqual([]);
	});

	it("entryAttachments passes through an error on a valid record", () => {
		const failed = {
			...attachedNotes,
			delivery: "error",
			error: "workspace upload refused",
		};
		const entry = {
			kind: USER_KIND,
			data: { attachments: [failed] },
		};
		expect(entryAttachments(entry)).toEqual([failed]);
	});

	it("typedText of a pi.user joins every text part with the joiner", () => {
		const entry = {
			kind: "pi.user",
			model: [
				{
					role: "user",
					content: [
						{ type: "text", text: "first part" },
						{ type: "text", text: "second part" },
					],
				},
			],
		};
		expect(typedText(entry)).toBe("first part\n\nsecond part");
		expect(unattachedText(entry, " / ")).toBe("first part / second part");
	});

	it("unattachedText of an expanded entry is the admitted text minus attachment parts", () => {
		const entry = {
			kind: EXPANDED_USER_KIND,
			data: { typed: "/x", attachments: [attachedNotes] },
			model: [
				{
					role: "user",
					content: [
						{ type: "text", text: "[Attached: uploads/7/notes.md]" },
						{ type: "text", text: "admitted text" },
					],
				},
			],
		};
		expect(unattachedText(entry)).toBe("admitted text");
	});

	it("unattachedText returns string content as-is", () => {
		const entry = {
			kind: "pi.user",
			model: [{ role: "user", content: "plain string body" }],
		};
		expect(unattachedText(entry)).toBe("plain string body");
	});

	it("attachmentNames joins the attachment names with the joiner", () => {
		const second = {
			...attachedNotes,
			path: "uploads/7/plan.md",
			name: "plan.md",
			parts: [1],
		};
		const entry = {
			kind: USER_KIND,
			data: { attachments: [attachedNotes, second] },
		};
		expect(attachmentNames(entry)).toBe("notes.md, plan.md");
		expect(attachmentNames(entry, " ")).toBe("notes.md plan.md");
		expect(attachmentNames({ kind: "pi.user" })).toBe("");
	});

	it("groupTurns puts a sigrun.user entry in a user turn", () => {
		const turns = groupTurns([
			assistantEntry(1, [{ type: "text", text: "Earlier answer." }]),
			{
				id: 2,
				kind: USER_KIND,
				model: [
					{
						role: "user",
						content: [
							{ type: "text", text: "[Attached: uploads/7/notes.md]" },
							{ type: "text", text: "what's in here?" },
						],
					},
				],
				data: { attachments: [attachedNotes] },
			},
		]);
		expect(turns.map((turn) => turn.kind)).toEqual(["assistant", "user"]);
		expect(turns[1]).toMatchObject({ kind: "user", entry: { id: 2 } });
	});
});

describe("activityLabel", () => {
	const call = (callId: string): ToolCall => ({
		callId,
		name: "bash",
		preview: "",
		isError: false,
	});

	it("is empty for a turn with neither thinking nor tools", () => {
		expect(activityLabel({ thinking: [], tools: [] })).toBe("");
	});

	it("counts tools without a plural on one", () => {
		expect(activityLabel({ thinking: [], tools: [call("a")] })).toBe("1 tool");
		expect(
			activityLabel({ thinking: [], tools: [call("a"), call("b"), call("c")] }),
		).toBe("3 tools");
	});

	it("prefixes thinking, joined with a middle dot", () => {
		expect(activityLabel({ thinking: ["hmm"], tools: [] })).toBe("Thinking");
		expect(activityLabel({ thinking: ["hmm", "ah"], tools: [call("a")] })).toBe(
			"Thinking · 1 tool",
		);
	});
});
