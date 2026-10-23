/**
 * The `form` block and fields (UI-blocks U2 Task 5, spec §5.6/§6.2/
 * §9.1): TUI terms for U1 Task 5's field behaviors — submit validation
 * and server field errors; live under `/view/` writes locally (through
 * ctx.setView); live elsewhere dispatches after 300 ms; inline clears
 * on success; `choice` values per §5.6 with `preview` below the options
 * and `allowOther` as a final "Type something" row; `secret` masked and
 * write-only with its status; `file` checks accept/maxBytes, reads the
 * file and dispatches onUpload; `list` add/remove/reorder; `longtext`
 * with `syntax: code` opens the $EDITOR seam. The interaction stepper
 * steps one section at a time with a review step, submitting once.
 * Review Focus 4: the focused field survives a data update.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import type {
	ChoiceField,
	FormBlock,
	JsonValue,
} from "@sigrun/shared/blocks";
import { plainTuiTheme } from "../src/theme.js";
import type { BlockCtx } from "../src/blocks/render.js";
import { renderBlock } from "../src/blocks/render.js";
import type { FormComponent } from "../src/blocks/form/form.js";
import { LIVE_DEBOUNCE_MS } from "../src/blocks/form/form.js";

interface Captured {
	action: { type: string; name?: string; turn?: boolean };
	payload: JsonValue;
}

function makeCtx(
	data: Record<string, JsonValue>,
	opts: {
		unicode?: boolean;
		access?: "read" | "write";
		serverErrors?: Readonly<Record<string, string>>;
	} = {},
): {
	ctx: BlockCtx;
	captured: Captured[];
	viewWrites: { path: string; value: JsonValue }[];
	uploads: { field: string; name: string; bytes: Uint8Array }[];
} {
	const captured: Captured[] = [];
	const viewWrites: { path: string; value: JsonValue }[] = [];
	const uploads: { field: string; name: string; bytes: Uint8Array }[] = [];
	const ctx: BlockCtx = {
		data,
		theme: plainTuiTheme(),
		locale: "en-CA",
		timeZone: "UTC",
		access: opts.access ?? "write",
		unicode: opts.unicode ?? true,
		dispatch: (action, payload) => {
			captured.push({ action, payload });
		},
		view: { values: {} },
		setView: (path, value) => {
			viewWrites.push({ path, value });
		},
		serverErrors: opts.serverErrors,
		uploadBytes: (field, name, bytes) => {
			uploads.push({ field, name, bytes });
		},
	};
	return { ctx, captured, viewWrites, uploads };
}

function formOf(
	block: FormBlock,
	ctx: BlockCtx,
	opts: { interaction?: boolean } = {},
): FormComponent {
	return renderBlock(block, ctx, { interaction: opts.interaction }) as unknown as FormComponent;
}

const ENTER = "\r";
const DOWN = "\x1b[B";
const UP = "\x1b[A";
const TAB = "\t";

function textForm(): FormBlock {
	return {
		type: "form",
		bind: "/prefs",
		mode: "submit",
		onSubmit: "savePrefs",
		submitLabel: "Save",
		children: [
			{ type: "text", name: "nick", label: "Nickname", required: true },
			{ type: "number", name: "quota", label: "Quota", min: 1, max: 10 },
		],
	};
}

describe("submit mode (§5.6)", () => {
	test("typing edits the field; Enter on the submit row dispatches the values", () => {
		const { ctx, captured } = makeCtx({ prefs: { nick: "" } });
		const form = formOf(textForm(), ctx);
		form.handleInput("a");
		form.handleInput("c"); // nick = "ac"
		form.handleInput(ENTER); // move to quota
		form.handleInput("5"); // quota = 5
		form.handleInput(ENTER); // move to the submit row
		form.handleInput(ENTER); // submit
		expect(captured).toHaveLength(1);
		expect(captured[0]?.action).toEqual({ type: "submit", name: "savePrefs" });
		expect(captured[0]?.payload).toEqual({ values: { nick: "ac", quota: 5 } });
	});

	test("a required field blocks the submit and shows the error", () => {
		const { ctx, captured } = makeCtx({ prefs: { nick: "" } });
		const form = formOf(textForm(), ctx);
		form.handleInput(ENTER); // quota
		form.handleInput(ENTER); // submit row
		form.handleInput(ENTER); // try to submit with nick empty
		expect(captured).toHaveLength(0);
		expect(form.render(100).join("\n")).toContain("Nickname is required");
	});

	test("number min/max validation runs before dispatch", () => {
		const { ctx, captured } = makeCtx({ prefs: { nick: "ok" } });
		const form = formOf(textForm(), ctx);
		form.handleInput(ENTER); // quota
		form.handleInput("9");
		form.handleInput("9"); // quota = 99, over max 10
		form.handleInput(ENTER);
		form.handleInput(ENTER); // submit
		expect(captured).toHaveLength(0);
		expect(form.render(100).join("\n")).toContain("Quota must be at most 10");
	});

	test("a server field error renders under the field", () => {
		const { ctx } = makeCtx(
			{ prefs: { nick: "x" } },
			{ serverErrors: { nick: "nickname is taken" } },
		);
		const form = formOf(textForm(), ctx);
		expect(form.render(100).join("\n")).toContain("nickname is taken");
	});

	test("access read renders no submit row", () => {
		const { ctx } = makeCtx({ prefs: {} }, { access: "read" });
		const form = formOf(textForm(), ctx);
		expect(form.render(100).join("\n")).not.toContain("[ Save ]");
	});

	test("labels sit beside fields at regular and above at compact", () => {
		const { ctx } = makeCtx({ prefs: {} });
		const form = formOf(textForm(), ctx);
		const regular = form.render(100);
		expect(regular[0]).toMatch(/^Nickname \*/);
		const compact = form.render(72);
		expect(compact[0]).toBe("Nickname *");
	});
});

describe("live mode (§5.6/§6.2)", () => {
	test("a /view/-bound live form writes through setView after 300 ms and never dispatches", () => {
		vi.useFakeTimers();
		try {
			const { ctx, captured, viewWrites } = makeCtx({});
			const block: FormBlock = {
				type: "form",
				bind: "/view/filter",
				mode: "live",
				children: [{ type: "text", name: "q", label: "Filter" }],
			};
			const form = formOf(block, ctx);
			form.handleInput("a");
			form.handleInput("c");
			vi.advanceTimersByTime(LIVE_DEBOUNCE_MS - 1);
			expect(viewWrites).toHaveLength(0);
			vi.advanceTimersByTime(1);
			expect(captured).toHaveLength(0);
			expect(viewWrites).toHaveLength(1);
			expect(viewWrites[0]?.path).toBe("filter");
			expect(viewWrites[0]?.value).toEqual({ q: "ac" });
		} finally {
			vi.useRealTimers();
		}
	});

	test("a live form bound elsewhere dispatches an edit after 300 ms", () => {
		vi.useFakeTimers();
		try {
			const { ctx, captured } = makeCtx({ prefs: {} });
			const block: FormBlock = {
				type: "form",
				bind: "/prefs",
				mode: "live",
				onSubmit: "savePrefs",
				children: [{ type: "text", name: "nick", label: "Nickname" }],
			};
			const form = formOf(block, ctx);
			form.handleInput("z");
			vi.advanceTimersByTime(LIVE_DEBOUNCE_MS);
			expect(captured).toHaveLength(1);
			expect(captured[0]?.action).toEqual({ type: "edit", name: "savePrefs" });
			expect(captured[0]?.payload).toEqual({ values: { nick: "z" } });
		} finally {
			vi.useRealTimers();
		}
	});

	test("the debounce coalesces rapid edits into one dispatch", () => {
		vi.useFakeTimers();
		try {
			const { ctx, captured } = makeCtx({ prefs: {} });
			const block: FormBlock = {
				type: "form",
				bind: "/prefs",
				mode: "live",
				onSubmit: "savePrefs",
				children: [{ type: "text", name: "nick", label: "Nickname" }],
			};
			const form = formOf(block, ctx);
			form.handleInput("a");
			vi.advanceTimersByTime(100);
			form.handleInput("b");
			vi.advanceTimersByTime(100);
			form.handleInput("c");
			vi.advanceTimersByTime(LIVE_DEBOUNCE_MS);
			expect(captured).toHaveLength(1);
			expect(captured[0]?.payload).toEqual({ values: { nick: "abc" } });
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("inline mode (§5.6)", () => {
	test("renders one row with the field and the submit label; Enter submits and clears", () => {
		const { ctx, captured } = makeCtx({});
		const block: FormBlock = {
			type: "form",
			bind: "/quick",
			mode: "inline",
			onSubmit: "quickAdd",
			submitLabel: "Add",
			children: [{ type: "text", name: "title", label: "Title" }],
		};
		const form = formOf(block, ctx);
		expect(form.render(100).join("\n")).toContain("[ Add ]");
		form.handleInput("n");
		form.handleInput("e");
		form.handleInput("w");
		form.handleInput(ENTER);
		expect(captured).toHaveLength(1);
		expect(captured[0]?.payload).toEqual({ values: { title: "new" } });
		expect(form.values.title).toBe("");
	});
});

function choiceField(): ChoiceField {
	return {
		type: "choice",
		name: "color",
		label: "Color",
		options: [
			{ id: "red", label: "Red", preview: "A warm color." },
			{ id: "blue", label: "Blue", description: "calm", recommended: true },
		],
	};
}

describe("choice (§5.6)", () => {
	test("single: Enter selects the id; the value is the id", () => {
		const { ctx } = makeCtx({});
		const form = formOf(
			{ type: "form", bind: "/x", mode: "submit", children: [choiceField()] },
			ctx,
		);
		form.handleInput(DOWN); // to the blue option
		form.handleInput(ENTER);
		expect(form.values.color).toBe("blue");
	});

	test("multi: the value is the ids in pick order", () => {
		const { ctx } = makeCtx({});
		const field: ChoiceField = { ...choiceField(), multi: true };
		const form = formOf({ type: "form", bind: "/p", mode: "submit", children: [field] }, ctx);
		form.handleInput(ENTER); // red
		form.handleInput(DOWN);
		form.handleInput(ENTER); // blue
		expect(form.values.color).toEqual(["red", "blue"]);
	});

	test("the preview renders BELOW the options while focused", () => {
		const { ctx } = makeCtx({});
		const form = formOf(
			{ type: "form", bind: "/x", mode: "submit", children: [choiceField()] },
			ctx,
		);
		const lines = form.render(100);
		const redAt = lines.findIndex((line) => line.includes("Red"));
		const previewAt = lines.findIndex((line) => line.includes("A warm color."));
		expect(redAt).toBeGreaterThanOrEqual(0);
		expect(previewAt).toBeGreaterThan(redAt);
	});

	test("allowOther: a final Type something row; single value is {other}", () => {
		const { ctx } = makeCtx({});
		const field: ChoiceField = { ...choiceField(), allowOther: {} };
		const form = formOf({ type: "form", bind: "/x", mode: "submit", children: [field] }, ctx);
		expect(form.render(100).some((line) => line.includes("Type something"))).toBe(true);
		form.handleInput(DOWN);
		form.handleInput(DOWN); // the other row
		form.handleInput("t");
		form.handleInput("e");
		form.handleInput("a");
		form.handleInput(ENTER);
		expect(form.values.color).toEqual({ other: "tea" });
	});

	test("allowOther multi: ids plus {other} as the last element", () => {
		const { ctx } = makeCtx({});
		const field: ChoiceField = { ...choiceField(), multi: true, allowOther: {} };
		const form = formOf({ type: "form", bind: "/x", mode: "submit", children: [field] }, ctx);
		form.handleInput(ENTER); // red
		form.handleInput(DOWN);
		form.handleInput(DOWN); // the other row
		form.handleInput("c");
		form.handleInput("h");
		form.handleInput("i");
		form.handleInput(ENTER);
		expect(form.values.color).toEqual(["red", { other: "chi" }]);
	});

	test("ASCII mode renders ASCII boxes", () => {
		const { ctx } = makeCtx({}, { unicode: false });
		const form = formOf(
			{ type: "form", bind: "/x", mode: "submit", children: [choiceField()] },
			ctx,
		);
		form.handleInput(ENTER); // pick red
		expect(form.render(100).join("\n")).toContain("(*) Red");
	});
});

function secretForm(): FormBlock {
	return {
		type: "form",
		bind: "/keys",
		mode: "submit",
		children: [{ type: "secret", name: "apiKey", label: "API key" }],
	};
}

describe("secret (§5.6)", () => {
	test("shows the bound status and never the value", () => {
		const { ctx } = makeCtx({ keys: { apiKey: "stored" } });
		const form = formOf(secretForm(), ctx);
		expect(form.render(100).join("\n")).toContain("set (stored)");
	});

	test("not set when the status is missing", () => {
		const { ctx } = makeCtx({ keys: {} });
		const form = formOf(secretForm(), ctx);
		expect(form.render(100).join("\n")).toContain("not set");
	});

	test("typed characters mask and the value submits what was typed", () => {
		const { ctx, captured } = makeCtx({ keys: { apiKey: "env" } });
		const form = formOf(secretForm(), ctx);
		expect(form.render(100).join("\n")).toContain("set (env)");
		form.handleInput("s");
		form.handleInput("3");
		form.handleInput("c");
		const text = form.render(100).join("\n");
		expect(text).toContain("•••");
		expect(text).not.toContain("s3c");
		form.handleInput(ENTER); // to the submit row
		form.handleInput(ENTER);
		expect(captured[0]?.payload).toEqual({ values: { apiKey: "s3c" } });
	});

	test("ASCII mode masks with *", () => {
		const { ctx } = makeCtx({ keys: {} }, { unicode: false });
		const form = formOf(secretForm(), ctx);
		form.handleInput("a");
		form.handleInput("b");
		expect(form.render(100).join("\n")).toContain("**");
	});
});

function writeFixture(name: string, content: string): string {
	const dir = mkdtempSync(join(tmpdir(), "sigrun-form-test-"));
	const path = join(dir, name);
	writeFileSync(path, content);
	return path;
}

describe("file (§5.6)", () => {
	test("Enter checks accept, dispatches onUpload and hands bytes to uploadBytes", () => {
		const { ctx, captured, uploads } = makeCtx({});
		const path = writeFixture("note.txt", "hello acme");
		const block: FormBlock = {
			type: "form",
			bind: "/docs",
			mode: "submit",
			children: [
				{ type: "file", name: "doc", label: "Doc", accept: ".txt", onUpload: "uploadDoc" },
			],
		};
		const form = formOf(block, ctx);
		for (const char of path) form.handleInput(char);
		form.handleInput(ENTER);
		expect(captured).toHaveLength(1);
		expect(captured[0]?.action).toEqual({ type: "submit", name: "uploadDoc", turn: false });
		const payload = captured[0]?.payload as { field: string; files: { name: string }[] };
		expect(payload.field).toBe("doc");
		expect(payload.files[0]?.name).toBe("note.txt");
		expect(uploads).toHaveLength(1);
		expect(new TextDecoder().decode(uploads[0]?.bytes)).toBe("hello acme");
	});

	test("an accept failure shows an error and dispatches nothing", () => {
		const { ctx, captured } = makeCtx({});
		const path = writeFixture("note.md", "hi");
		const block: FormBlock = {
			type: "form",
			bind: "/docs",
			mode: "submit",
			children: [
				{ type: "file", name: "doc", label: "Doc", accept: ".png", onUpload: "uploadDoc" },
			],
		};
		const form = formOf(block, ctx);
		for (const char of path) form.handleInput(char);
		form.handleInput(ENTER);
		expect(captured).toHaveLength(0);
		expect(form.render(100).join("\n")).toContain("not an accepted type");
	});

	test("a maxBytes failure shows an error and dispatches nothing", () => {
		const { ctx, captured } = makeCtx({});
		const path = writeFixture("big.txt", "0123456789");
		const block: FormBlock = {
			type: "form",
			bind: "/docs",
			mode: "submit",
			children: [
				{ type: "file", name: "doc", label: "Doc", maxBytes: 4, onUpload: "uploadDoc" },
			],
		};
		const form = formOf(block, ctx);
		for (const char of path) form.handleInput(char);
		form.handleInput(ENTER);
		expect(captured).toHaveLength(0);
		expect(form.render(100).join("\n")).toContain("larger than 4 bytes");
	});
});

function listForm(): FormBlock {
	return {
		type: "form",
		bind: "/tags",
		mode: "submit",
		children: [
			{
				type: "list",
				name: "tags",
				label: "Tags",
				item: { type: "text", name: "tag", label: "Tag" },
				reorder: true,
				max: 3,
			},
		],
	};
}

describe("list (§5.6)", () => {
	test("a adds, typing edits, d removes", () => {
		const { ctx } = makeCtx({ tags: {} });
		const form = formOf(listForm(), ctx);
		form.handleInput("a");
		form.handleInput("a");
		expect(form.values.tags).toEqual(["", ""]);
		form.handleInput("x");
		expect(form.values.tags).toEqual(["", "x"]);
		form.handleInput("d");
		expect(form.values.tags).toEqual([""]);
	});

	test("u/j reorder entries", () => {
		const { ctx } = makeCtx({ tags: {} });
		const form = formOf(listForm(), ctx);
		form.handleInput("a");
		form.handleInput("a");
		form.handleInput("a");
		form.handleInput(UP); // entry cursor to index 1
		form.handleInput("b");
		expect(form.values.tags).toEqual(["", "b", ""]);
		form.handleInput("u"); // move index 1 up
		expect(form.values.tags).toEqual(["b", "", ""]);
		form.handleInput("j");
		expect(form.values.tags).toEqual(["", "b", ""]);
	});

	test("max stops adding", () => {
		const { ctx } = makeCtx({ tags: {} });
		const form = formOf(listForm(), ctx);
		form.handleInput("a");
		form.handleInput("a");
		form.handleInput("a");
		form.handleInput("a"); // past max 3 — no-op
		expect((form.values.tags as JsonValue[]).length).toBe(3);
	});
});

describe("longtext (§5.6)", () => {
	test("syntax code opens the host $EDITOR seam with e", () => {
		const { ctx } = makeCtx({});
		const opened: string[] = [];
		ctx.openEditor = (text: string) => {
			opened.push(text);
			return { ok: true, text: "// edited code" };
		};
		const block: FormBlock = {
			type: "form",
			bind: "/note",
			mode: "submit",
			children: [
				{ type: "longtext", name: "body", label: "Body", syntax: "code", lang: "ts" },
			],
		};
		const form = formOf(block, ctx);
		form.handleInput("e");
		expect(opened).toHaveLength(1);
		expect(form.values.body).toBe("// edited code");
	});
});

function stepperForm(): FormBlock {
	return {
		type: "form",
		bind: "/answers",
		mode: "submit",
		onSubmit: "answer",
		submitLabel: "Send",
		children: [
			{
				type: "section",
				title: "Pick a color",
				children: [
					{
						type: "choice",
						name: "color",
						label: "Color",
						options: [
							{ id: "red", label: "Red" },
							{ id: "blue", label: "Blue" },
						],
					},
				],
			},
			{
				type: "section",
				title: "Pick a size",
				children: [
					{
						type: "choice",
						name: "size",
						label: "Size",
						options: [
							{ id: "s", label: "Small" },
							{ id: "l", label: "Large" },
						],
					},
				],
			},
		],
	};
}

describe("interaction stepper (§9.1)", () => {
	test("steps one section at a time with a review step, submitting once", () => {
		const { ctx, captured } = makeCtx({});
		const form = formOf(stepperForm(), ctx, { interaction: true });
		let text = form.render(100).join("\n");
		expect(text).toContain("Step 1 of 2");
		expect(text).toContain("Pick a color");
		expect(text).not.toContain("Pick a size");
		form.handleInput(DOWN); // blue
		form.handleInput(ENTER); // select blue
		form.handleInput(TAB); // to step 2
		text = form.render(100).join("\n");
		expect(text).toContain("Step 2 of 2");
		expect(text).toContain("Pick a size");
		form.handleInput(ENTER); // select Small
		form.handleInput(TAB); // to the review
		text = form.render(100).join("\n");
		expect(text).toContain("Review");
		expect(text).toContain("Pick a color: Blue");
		expect(text).toContain("Pick a size: Small");
		form.handleInput(ENTER); // submit once
		expect(captured).toHaveLength(1);
		expect(captured[0]?.action).toEqual({ type: "submit", name: "answer" });
		expect(captured[0]?.payload).toEqual({ values: { color: "blue", size: "s" } });
		form.handleInput(ENTER);
		expect(captured).toHaveLength(1);
	});

	test("a flat form in an interaction placement does NOT step", () => {
		const { ctx } = makeCtx({});
		const block: FormBlock = {
			type: "form",
			bind: "/a",
			mode: "submit",
			children: [{ type: "text", name: "q", label: "Q" }],
		};
		const form = formOf(block, ctx, { interaction: true });
		expect(form.render(100).join("\n")).not.toContain("Step 1");
	});
});

describe("Review Focus 4: the focused field survives a data update", () => {
	test("values and focus persist across a re-render with new data", () => {
		const { ctx } = makeCtx({ prefs: { nick: "" } });
		const form = formOf(textForm(), ctx);
		form.handleInput("a");
		form.handleInput("c");
		form.handleInput(ENTER); // focus quota
		expect(form.focusIndex).toBe(1);
		ctx.data = { prefs: { nick: "server value", quota: 3 } };
		form.invalidate();
		expect(form.focusIndex).toBe(1);
		expect(form.values.nick).toBe("ac");
		expect(form.render(100).join("\n")).toContain("ac");
	});
});

describe("review fixes (the fix round's covering tests)", () => {
	test("a sibling block bound /view/... reads a setView write (§6.2)", () => {
		vi.useFakeTimers();
		try {
			const { ctx } = makeCtx({});
			const block: FormBlock = {
				type: "form",
				bind: "/view/filter",
				mode: "live",
				children: [{ type: "text", name: "q", label: "Filter" }],
			};
			const form = formOf(block, ctx);
			form.handleInput("a");
			form.handleInput("c");
			vi.advanceTimersByTime(LIVE_DEBOUNCE_MS);
			// The test double's setView only records; mirror what
			// SurfaceState.setView does (write into the branch) so the
			// sibling read resolves it.
			ctx.setView?.("", {});
			ctx.view.values = { filter: { q: "ac" } };
			// A sibling markdown block bound /view/filter/q must resolve it.
			const sibling = renderBlock({ type: "markdown", text: { $: "/view/filter/q" } }, ctx);
			expect(sibling.render(100).join("\n")).toContain("ac");
		} finally {
			vi.useRealTimers();
		}
	});

	test("a number field never holds NaN: 'abc' leaves the value empty", () => {
		const { ctx, captured } = makeCtx({ prefs: { nick: "ok" } });
		const form = formOf(textForm(), ctx);
		form.handleInput(ENTER); // quota
		form.handleInput("a");
		form.handleInput("b");
		form.handleInput("c");
		expect(form.values.quota).toBe("");
		// A valid number still submits as a number.
		form.handleInput("\x7f");
		form.handleInput("\x7f");
		form.handleInput("\x7f");
		form.handleInput("4");
		expect(form.values.quota).toBe(4);
		form.handleInput(ENTER); // submit row
		form.handleInput(ENTER);
		expect(captured[0]?.payload).toEqual({ values: { nick: "ok", quota: 4 } });
	});

	test("a multi file field appends picks (nothing is dropped)", () => {
		const { ctx, uploads } = makeCtx({});
		const first = writeFixture("one.txt", "one");
		const second = writeFixture("two.txt", "two");
		const block: FormBlock = {
			type: "form",
			bind: "/docs",
			mode: "submit",
			children: [
				{ type: "file", name: "docs", label: "Docs", multi: true, onUpload: "uploadDocs" },
			],
		};
		const form = formOf(block, ctx);
		for (const char of first) form.handleInput(char);
		form.handleInput(ENTER);
		// The path editor cleared on the successful pick.
		expect(form.render(100).join("\n")).toContain("uploaded: one.txt");
		for (const char of second) form.handleInput(char);
		form.handleInput(ENTER);
		expect(uploads).toHaveLength(2);
		const value = form.values.docs as { name: string }[];
		expect(Array.isArray(value)).toBe(true);
		expect(value.map((entry) => entry.name)).toEqual(["one.txt", "two.txt"]);
	});

	test("a choice+longtext section focuses only the choice; the review shows both answers (§9.1)", () => {
		const { ctx, captured } = makeCtx({});
		const block: FormBlock = {
			type: "form",
			bind: "/answers",
			mode: "submit",
			onSubmit: "answer",
			children: [
				{
					type: "section",
					title: "One",
					children: [
						{
							type: "choice",
							name: "pick",
							label: "Pick",
							options: [
								{ id: "x", label: "Ex" },
								{ id: "y", label: "Why" },
							],
						},
						{ type: "longtext", name: "note", label: "Note" },
					],
				},
				{
					type: "section",
					title: "Two",
					children: [
						{
							type: "choice",
							name: "second",
							label: "Second",
							options: [
								{ id: "s", label: "Small" },
								{ id: "l", label: "Large" },
							],
						},
					],
				},
			],
		};
		const form = formOf(block, ctx, { interaction: true });
		const stepOne = form.render(100);
		const pickRow = stepOne.findIndex((line) => line.includes("Ex"));
		const noteRow = stepOne.findIndex((line) => line.includes("Note"));
		expect(pickRow).toBeGreaterThanOrEqual(0);
		expect(noteRow).toBeGreaterThan(pickRow);
		// The choice row carries focus chrome ("> " after the label
		// column); the longtext renders read-only (no caret marker).
		expect(stepOne[pickRow]).toContain("> ( ) Ex");
		const noteEditor = stepOne[noteRow + 1] ?? "";
		expect(noteEditor).not.toContain("▏");
		// Answer the choice and continue.
		form.handleInput(ENTER); // pick Ex
		form.handleInput(TAB); // step 2
		form.handleInput(DOWN);
		form.handleInput(ENTER); // Large
		form.handleInput(TAB); // review
		const review = form.render(100).join("\n");
		expect(review).toContain("One: Ex");
		expect(review).toContain("Two: Large");
		form.handleInput(ENTER);
		expect(captured).toHaveLength(1);
	});
});
