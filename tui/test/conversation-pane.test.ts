/**
 * The restyled conversation pane (task C2): turns from B1's `groupTurns`
 * — user turns carry the accent `▎` bar on every line, assistant prose is
 * plain markdown, activity collapses to one dim `▸ Thinking · N tools`
 * line that unfolds into thinking + `✓ tool  preview` rows. Turns are
 * focusable (`›` gutter marker on the focused turn's first line),
 * foldable (`toggleFold`), and carry the copy/id accessors the C3 action
 * layer drives (`textOf`, `entryIdOf`, `lineRangeOf`). `[tool]` /
 * `[thinking]` tags are gone. Structure assertions: rendered-line
 * content, not pixels.
 */

import { describe, expect, test } from "vitest";
import { ConversationPane } from "../src/ui/conversation-pane.js";
import type { ConversationViewWire } from "../src/api.js";

function view(id: number, entries: unknown[]): ConversationViewWire {
	return {
		conversation: { id },
		entries,
		docs: {},
		steer: { busy: false, queued: 0 },
	} as unknown as ConversationViewWire;
}

/**
 * The fixture: a user prompt, an assistant turn with thinking + one
 * successful `bash ls /` call, then a second user prompt. Mirrors a
 * root-filesystem inspection run.
 */
function rootFilesystemEntries(): unknown[] {
	return [
		{
			id: 1,
			kind: "pi.user",
			model: [{ role: "user", content: "what is in the root filesystem?" }],
		},
		{
			id: 2,
			kind: "pi.assistant",
			model: [
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "I should list the directory" },
						{
							type: "toolCall",
							id: "call-1",
							name: "bash",
							arguments: { command: "ls /" },
						},
					],
				},
			],
		},
		{
			id: 3,
			kind: "pi.tool-result",
			model: [
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "bash",
					content: [{ type: "text", text: "bin  etc  usr" }],
				},
			],
		},
		{
			id: 4,
			kind: "pi.assistant",
			model: [
				{
					role: "assistant",
					content: [{ type: "text", text: "The root holds bin, etc and usr." }],
				},
			],
		},
		{
			id: 5,
			kind: "pi.user",
			model: [{ role: "user", content: "thanks" }],
		},
	];
}

describe("ConversationPane (C2 turn rendering)", () => {
	test("turns() groups entries into user + assistant turns", () => {
		const pane = new ConversationPane();
		pane.showView(view(1, rootFilesystemEntries()));
		const turns = pane.turns();
		expect(turns.map((turn) => turn.kind)).toEqual([
			"user",
			"assistant",
			"user",
		]);
	});

	test("renders the collapsed activity line; no [tool]/[thinking] tags", () => {
		const pane = new ConversationPane();
		pane.showView(view(1, rootFilesystemEntries()));
		const lines = pane.render(80).join("\n");
		expect(lines).toContain("▸ Thinking · 1 tool");
		expect(lines).not.toContain("[tool]");
		expect(lines).not.toContain("[thinking]");
		// The user prompt renders with the accent bar on every line.
		expect(lines).toContain("▎ what is in the root filesystem?");
		// Assistant prose renders plainly (no bar).
		expect(lines).toContain("The root holds bin, etc and usr.");
	});

	test("toggleFold opens the activity: thinking + ✓ tool rows", () => {
		const pane = new ConversationPane();
		pane.showView(view(1, rootFilesystemEntries()));
		pane.toggleFold(1);
		const lines = pane.render(80).join("\n");
		expect(lines).toContain("▾ Thinking · 1 tool");
		expect(lines).toContain("I should list the directory");
		expect(lines).toContain("✓ bash  ls /");
		// Folding again collapses back.
		pane.toggleFold(1);
		const closed = pane.render(80).join("\n");
		expect(closed).toContain("▸ Thinking · 1 tool");
		expect(closed).not.toContain("✓ bash");
	});

	test("a tool-only aborted turn collapses to ▸ 1 tool with a · no-result row", () => {
		const pane = new ConversationPane();
		pane.showView(
			view(1, [
				{
					id: 1,
					kind: "pi.user",
					model: [{ role: "user", content: "run it" }],
				},
				{
					id: 2,
					kind: "pi.assistant",
					model: [
						{
							role: "assistant",
							content: [
								{
									type: "toolCall",
									id: "call-x",
									name: "bash",
									arguments: { command: "make test" },
								},
							],
						},
					],
				},
				// Aborted mid-run: no pi.tool-result ever lands.
			]),
		);
		const lines = pane.render(80).join("\n");
		expect(lines).toContain("▸ 1 tool");
		pane.toggleFold(1);
		const open = pane.render(80).join("\n");
		expect(open).toContain("· bash  make test");
	});

	test("a tool with an error result renders ✗", () => {
		const pane = new ConversationPane();
		pane.showView(
			view(1, [
				{
					id: 1,
					kind: "pi.assistant",
					model: [
						{
							role: "assistant",
							content: [
								{
									type: "toolCall",
									id: "call-e",
									name: "bash",
									arguments: { command: "false" },
								},
							],
						},
					],
				},
				{
					id: 2,
					kind: "pi.tool-result",
					model: [
						{
							role: "toolResult",
							toolCallId: "call-e",
							toolName: "bash",
							isError: true,
							content: [{ type: "text", text: "exit 1" }],
						},
					],
				},
			]),
		);
		pane.toggleFold(0);
		expect(pane.render(80).join("\n")).toContain("✗ bash  false");
	});

	test("setFocus(0) composes › and the ▎ bar on a focused user turn's first line", () => {
		const pane = new ConversationPane();
		pane.showView(view(1, rootFilesystemEntries()));
		expect(pane.focusIndex).toBeUndefined();
		pane.setFocus(0);
		expect(pane.focusIndex).toBe(0);
		const lines = pane.render(80);
		const first = lines.find((line) => line.includes("what is in the root"));
		expect(first).toBeDefined();
		// The focus gutter and the user bar are independent chrome: the
		// focused user turn's first line carries BOTH (the bar must not be
		// lost to the focus branch).
		expect(first?.startsWith("›")).toBe(true);
		expect(first).toContain("▎");
		// Clearing focus removes the marker.
		pane.setFocus(undefined);
		const after = pane.render(80).join("\n");
		expect(after).not.toContain("›");
	});

	test("lineRangeOf orders turns (1 after 0) and covers rendered lines", () => {
		const pane = new ConversationPane();
		pane.showView(view(1, rootFilesystemEntries()));
		pane.render(80);
		const first = pane.lineRangeOf(0);
		const second = pane.lineRangeOf(1);
		expect(first).toBeDefined();
		expect(second).toBeDefined();
		expect(second!.start).toBeGreaterThanOrEqual(first!.end);
		expect(pane.lineRangeOf(99)).toBeUndefined();
	});

	test("textOf returns the markdown source; entryIdOf the wire id", () => {
		const pane = new ConversationPane();
		pane.showView(view(1, rootFilesystemEntries()));
		expect(pane.textOf(0)).toBe("what is in the root filesystem?");
		expect(pane.textOf(1)).toBe("The root holds bin, etc and usr.");
		expect(pane.entryIdOf(0)).toBe(1);
		expect(pane.entryIdOf(1)).toBe(4); // assistant lastEntryId
	});

	test("pi.compaction renders the centred divider", () => {
		const pane = new ConversationPane();
		pane.showView(
			view(1, [{ id: 1, kind: "pi.compaction", data: { reason: "threshold" } }]),
		);
		expect(pane.render(80).join("\n")).toContain("── context compacted ──");
	});

	test("the focused turn's first line carries the surface2 background", () => {
		// Non-plain theme: the surface2 bg span wraps the first line only.
		const pane = new ConversationPane({
			theme: {
				fg: () => (s) => s,
				bg: (token) => (s) => (token === "surface2" ? `<bg>${s}</bg>` : s),
				bold: (s) => s,
				dim: (s) => s,
				italic: (s) => s,
			},
		});
		pane.showView(view(1, rootFilesystemEntries()));
		pane.setFocus(0);
		const lines = pane.render(80);
		expect(lines[0]).toContain("<bg>");
		expect(lines[1] ?? "").not.toContain("<bg>");
	});
});
