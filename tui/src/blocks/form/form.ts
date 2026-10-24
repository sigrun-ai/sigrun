/**
 * The `form` block (UI-blocks U2 Task 5, spec §5.6/§6.2/§9.1 — the TUI
 * port of U1's `Form.tsx`): modes (submit / live / inline), client
 * validation before dispatch, the live-mode 300 ms debounce with the
 * `/view/` view-only branch, and the interaction stepper — several
 * sections each holding a `choice` in an interaction placement present
 * one question at a time with a review step, submitting ONCE with every
 * field's value.
 *
 * TUI editing model (the app owns keymaps; the form owns text editing):
 * Up/Down move between fields (the stepper moves BETWEEN sections);
 * the focused field edits inline — characters insert, Backspace
 * deletes, Enter submits (text/number/date/secret), toggles (toggle)
 * or activates an option (choice); Tab moves to the next field.
 * `syntax: "code"` longtext opens the host's $EDITOR seam with `e`.
 * Editing is per-mode: `submit` edits locally until Enter on the button
 * row; `live` dispatches every change after 300 ms (a `/view/`-bound
 * live form writes through ctx.setView and never dispatches); `inline`
 * renders one row (field plus the submit label) and clears on success.
 *
 * The focused field survives a data update (Review Focus 4): values
 * and focus live in the component, not the render; a re-render after a
 * server data change keeps both.
 */

import type { Component } from "@earendil-works/pi-tui";
import type {
	Field,
	FormBlock,
	JsonObject,
	JsonValue,
	SectionBlock,
} from "@sigrun/shared/blocks";
import { resolvePointer } from "@sigrun/shared/blocks";
import { bindText, type BlockCtx } from "../context.js";
import { truncate, widthClassOf } from "../width.js";
import {
	ChoiceState,
	choiceActivate,
	choiceLines,
	choiceRowCount,
	choiceSetOther,
	choiceValueText,
	clampChoiceCursor,
	otherText,
	optionIdList,
} from "./choice.js";
import { EditBuffer, fieldLabel, fieldRowLines, valueText } from "./fields.js";
import {
	FileFieldState,
	fileStatusLine,
	maskText,
	pickFile,
	secretStatusLine,
} from "./file.js";
import { listAdd, listCanAdd, listCanRemove, listEntries, listLines, listMove, listRemove, listSet, ListFieldState } from "./list.js";
import { collectFields, initialValue, validateField } from "./values.js";

/** The live-mode debounce (spec §5.6: "every change is applied after
 *  300 ms"). */
export const LIVE_DEBOUNCE_MS = 300;

/** The choice value's display for the stepper review (ids label back). */
function reviewText(field: Field, ctx: BlockCtx, value: JsonValue): string {
	if (field.type === "choice") return choiceValueText(field, ctx, value);
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (value === null || value === undefined) return "";
	return JSON.stringify(value);
}

/** The stepper: does this form qualify (several sections each holding
 *  a choice, interaction placement)? (§9.1) */
export function stepperSections(
	block: FormBlock,
	interaction: boolean,
): readonly SectionBlock[] | null {
	if (!interaction) return null;
	const sections = block.children.filter(
		(child): child is SectionBlock =>
			typeof child === "object" &&
			child !== null &&
			(child as SectionBlock).type === "section",
	);
	if (sections.length < 2) return null;
	const allChoice = sections.every((section) =>
		section.children.some(
			(child) =>
				typeof child === "object" &&
				child !== null &&
				(child as Field).type === "choice",
		),
	);
	return allChoice ? sections : null;
}

/** The answerable fields of a stepper section (every field the review
 *  summarizes — §9.1's review step covers ALL of a section's fields,
 *  not only the choice). */
function sectionFields(section: SectionBlock): readonly Field[] {
	return section.children.filter(
		(child): child is Field =>
			typeof child === "object" &&
			child !== null &&
			typeof (child as Field).name === "string" &&
			typeof (child as Field).type === "string",
	);
}

interface TextState {
	buffer: EditBuffer;
}

/** The form component. */
export class FormComponent implements Component {
	readonly #block: FormBlock;
	readonly #ctx: BlockCtx;
	readonly #interaction: boolean;
	/** The flattened fields (sections nest; editing order is depth-first). */
	readonly #fields: readonly Field[];
	#values: JsonObject;
	#errors: Record<string, string> = {};
	/** The focused field index (the submit button row sits after the
	 *  last field for submit-mode forms). */
	#focus = 0;
	#step = 0;
	readonly #text = new Map<string, TextState>();
	readonly #choice = new Map<string, ChoiceState>();
	readonly #list = new Map<string, ListFieldState>();
	readonly #file = new Map<string, FileFieldState>();
	#debounce: ReturnType<typeof setTimeout> | null = null;
	/** The stepper's submitted flag (the review step locks after submit). */
	#submitted = false;

	constructor(block: FormBlock, ctx: BlockCtx, opts: { interaction?: boolean } = {}) {
		this.#block = block;
		this.#ctx = ctx;
		this.#interaction = opts.interaction === true;
		this.#fields = collectFields(block);
		const boundObject = this.#boundObject();
		const init: JsonObject = {};
		for (const field of this.#fields) init[field.name] = initialValue(field, boundObject);
		this.#values = init;
	}

	/** The object the fields read (the `/view/` branch for a view-bound
	 *  form, the surface data otherwise — §6.2). The data reads through
	 *  `ctxRefresh` when the host supplies it: the component is memoized
	 *  but the surface's confirmed data moves on after a save's refetch
	 *  (the stale-ctx fix, U4 Task 4 fix wave). */
	#boundObject(): JsonObject {
		const data = this.#ctx.ctxRefresh?.().data ?? this.#ctx.data;
		const bind = this.#block.bind;
		if (bind.startsWith("/view/")) {
			const pointer = bind.replace(/^\/view\/?/, "/");
			const resolved = resolvePointer(this.#ctx.view.values as JsonValue, pointer);
			if (typeof resolved === "object" && resolved !== null && !Array.isArray(resolved)) {
				return resolved as JsonObject;
			}
			return {};
		}
		const resolved = resolvePointer(data, bind);
		if (typeof resolved === "object" && resolved !== null && !Array.isArray(resolved)) {
			return resolved as JsonObject;
		}
		return {};
	}

	/** The current data revision (the live read when the host supplies
	 *  it; the construction-time snapshot otherwise). */
	#currentRev(): number {
		return this.#ctx.ctxRefresh?.().rev ?? this.#ctx.rev ?? 0;
	}

	#textState(field: Field): TextState {
		let state = this.#text.get(field.name);
		if (state === undefined) {
			state = { buffer: new EditBuffer(valueText(this.#values[field.name])) };
			this.#text.set(field.name, state);
		}
		return state;
	}

	#choiceState(field: Field): ChoiceState {
		let state = this.#choice.get(field.name);
		if (state === undefined) {
			state = new ChoiceState();
			const other = otherText(this.#values[field.name] ?? "");
			state.other = new EditBuffer(other);
			this.#choice.set(field.name, state);
		}
		return state;
	}

	#listState(field: Field): ListFieldState {
		let state = this.#list.get(field.name);
		if (state === undefined) {
			state = new ListFieldState();
			this.#list.set(field.name, state);
		}
		return state;
	}

	#fileState(field: Field): FileFieldState {
		let state = this.#file.get(field.name);
		if (state === undefined) {
			state = new FileFieldState();
			this.#file.set(field.name, state);
		}
		return state;
	}

	/** Validate the form; returns true when every field passes. */
	#validate(): boolean {
		const next: Record<string, string> = {};
		for (const field of this.#fields) {
			const message = validateField(field, this.#values[field.name], fieldLabel(field, this.#ctx));
			if (message !== null) next[field.name] = message;
		}
		this.#errors = next;
		return Object.keys(next).length === 0;
	}

	/** The error under a field (a client error wins; else the server
	 *  field error, §5.6). */
	#errorOf(field: Field): string | undefined {
		// A file field's pick failure (accept/maxBytes/read) renders under
		// the field too (§5.6) — it lives in the field state, not the
		// submit validation map.
		return (
			this.#errors[field.name] ??
			this.#file.get(field.name)?.error ??
			this.#ctx.serverErrors?.[field.name]
		);
	}

	/** Change a field's value; live mode debounces the dispatch. */
	#change(name: string, value: JsonValue): void {
		this.#values = { ...this.#values, [name]: value };
		// A local edit clears the field's errors (the next validate or
		// server answer re-populates).
		delete this.#errors[name];
		if (this.#block.mode !== "live") return;
		if (this.#debounce !== null) clearTimeout(this.#debounce);
		this.#debounce = setTimeout(() => {
			this.#debounce = null;
			const flushed = this.#values;
			if (this.#block.bind.startsWith("/view/")) {
				// §6.2: view-only — the channel owns /view/. Write the branch
				// so sibling blocks reading /view/... update; never dispatch.
				const viewPath = this.#block.bind.replace(/^\/view\/?/, "");
				this.#ctx.setView?.(viewPath, { ...flushed });
				return;
			}
			this.#ctx.dispatch(
				{
					type: "edit",
					name: this.#block.onSubmit ?? "edit",
					...(this.#block.turn === undefined ? {} : { turn: this.#block.turn }),
				},
				{ values: { ...flushed } },
			);
		}, LIVE_DEBOUNCE_MS);
	}

	/** Submit (validate first; a failed submit dispatches nothing). */
	#submit(): boolean {
		if (!this.#validate()) return false;
		this.#ctx.dispatch(
			{
				type: "submit",
				name: this.#block.onSubmit ?? "submit",
				...(this.#block.turn === undefined ? {} : { turn: this.#block.turn }),
			},
			// The optimistic-concurrency rev rides every submit (the
			// LIVE surface rev — the component is memoized, so the
			// construction-time ctx.rev is stale after the first save's
			// refetch; a save-shaped action handler reads it, every other
			// handler ignores it).
			{ values: { ...this.#values }, rev: this.#currentRev() },
		);
		return true;
	}

	/** The read-only gate (access read disables editing, §6.5). */
	get #readOnly(): boolean {
		return this.#ctx.access !== "write";
	}

	/** The submit label (spec §5.6's default). */
	get #submitLabel(): string {
		return bindText(this.#block.submitLabel, this.#ctx) || "Submit";
	}

	/** The total focusable rows: fields (+ a submit row for submit mode). */
	#focusableCount(): number {
		const submitRow = this.#block.mode === "submit" && !this.#readOnly ? 1 : 0;
		return this.#fields.length + submitRow;
	}

	/** The fields visible in the current step (the stepper shows one
	 *  section; a flat form shows them all). */
	#visibleFields(): readonly Field[] {
		const sections = stepperSections(this.#block, this.#interaction);
		if (sections === null) return this.#fields;
		if (this.#step >= sections.length) return []; // the review step
		const section = sections[this.#step];
		if (section === undefined) return [];
		const fields: Field[] = [];
		for (const child of section.children) {
			if (
				typeof child === "object" &&
				child !== null &&
				typeof (child as Field).name === "string" &&
				typeof (child as Field).type === "string"
			) {
				fields.push(child as Field);
			}
		}
		return fields;
	}

	/** Render (the form re-renders against the current ctx data — the
	 *  host re-creates or re-renders on SurfaceState changes). */
	render(width: number): string[] {
		const sections = stepperSections(this.#block, this.#interaction);
		if (sections !== null) return this.#renderStepper(width, sections);
		if (this.#block.mode === "inline") return this.#renderInline(width);
		const lines: string[] = [];
		this.#visibleFields().forEach((field) => {
			const focused = this.#fields[this.#focus] === field;
			lines.push(...this.#renderField(field, width, focused));
		});
		if (this.#block.mode === "submit" && !this.#readOnly) {
			const cursor = this.#focus === this.#fields.length ? "> " : "  ";
			lines.push(truncate(`${cursor}[ ${this.#submitLabel} ]`, width));
		}
		return lines;
	}

	#renderInline(width: number): string[] {
		// Inline (§5.6): one row — the field editor plus the submit label.
		const field = this.#fields[0];
		if (field === undefined) return [];
		const state = this.#textState(field);
		const editor = state.buffer.render(this.#ctx.unicode);
		return [
			truncate(
				`${fieldLabel(field, this.#ctx)}: ${editor}  [ ${this.#submitLabel} ]`,
				width,
			),
		];
	}

	#renderStepper(width: number, sections: readonly SectionBlock[]): string[] {
		const total = sections.length;
		const lines: string[] = [];
		if (this.#step >= total) {
			// The review step (§9.1): every section's answerable fields, then
			// submit. A section title line leads its field answers.
			lines.push(this.#ctx.theme.bold(truncate("Review", width)));
			sections.forEach((section) => {
				const title = bindText(section.title, this.#ctx);
				const answers = sectionFields(section).map((field) =>
					reviewText(field, this.#ctx, this.#values[field.name] ?? null),
				);
				const summary = answers.filter((text) => text !== "").join(", ");
				lines.push(truncate(`  ${title}: ${summary}`, width));
			});
			if (!this.#readOnly && !this.#submitted) {
				lines.push(truncate(`> [ ${this.#submitLabel} ]`, width));
			}
			lines.push(this.#ctx.theme.dim(truncate("Up/Back returns · Enter submits", width)));
			return lines;
		}
		const section = sections[this.#step];
		lines.push(
			this.#ctx.theme.dim(truncate(`Step ${this.#step + 1} of ${total}`, width)),
		);
		if (section !== undefined) {
			const title = bindText(section.title, this.#ctx);
			if (title !== "") lines.push(this.#ctx.theme.bold(truncate(title, width)));
			// Only the section's FIRST field takes focus chrome and input;
			// the rest render read-only (the stepper's contract is one
			// answer per step — §9.1).
			const visible = this.#visibleFields();
			const primary = visible[0];
			for (const field of visible) {
				lines.push(...this.#renderField(field, width, field === primary));
			}
		}
		lines.push(
			this.#ctx.theme.dim(
				truncate(
					this.#step + 1 === total
						? "Enter selects · Tab reviews"
						: "Enter selects · Tab continues",
					width,
				),
			),
		);
		return lines;
	}

	/** One field's rows (the chrome plus its editor). */
	#renderField(field: Field, width: number, focused: boolean): string[] {
		const error = this.#errorOf(field);
		const editor = this.#editorLines(field, width, focused);
		return fieldRowLines({ field, ctx: this.#ctx, width, editor, error });
	}

	/** The editor lines of a field (per type). */
	#editorLines(field: Field, width: number, focused: boolean): string[] {
		const value = this.#values[field.name];
		const compact = widthClassOf(width) === "compact";
		const indent = compact && fieldLabel(field, this.#ctx) !== "" ? "  " : "";
		switch (field.type) {
			case "toggle": {
				const box = value === true ? (this.#ctx.unicode ? "[x]" : "[x]") : "[ ]";
				return [`${indent}${focused ? "> " : "  "}${box} ${value === true ? "on" : "off"}`];
			}
			case "choice":
				return choiceLines({
					field,
					ctx: this.#ctx,
					width,
					value,
					state: this.#choiceState(field),
					focused,
				}).map((line) => (indent === "" ? line : `${indent}${line}`));
			case "secret": {
				const status = secretStatusLine(field, this.#block.bind, this.#ctx);
				const state = this.#textState(field);
				const masked = maskText(state.buffer.text, this.#ctx.unicode);
				const editor = focused
					? `${masked}${this.#ctx.unicode ? "▏" : "|"}`
					: masked;
				return [`${indent}${editor}`, this.#ctx.theme.dim(status)];
			}
			case "file": {
				const state = this.#fileState(field);
				const buffer = this.#textState(field).buffer;
				const lines = [`${indent}${focused ? buffer.render(this.#ctx.unicode) : buffer.text}`];
				const status = fileStatusLine(state, width);
				if (status !== undefined) lines.push(this.#ctx.theme.dim(status));
				return lines;
			}
			case "list": {
				const state = this.#listState(field);
				return listLines({
					field,
					width,
					value,
					state,
					focused,
					entryLine: (index, entry, entryFocused) => {
						const key = `${field.name}.${index}`;
						let buffer = this.#text.get(key)?.buffer;
						if (buffer === undefined) {
							buffer = new EditBuffer(valueText(entry));
							this.#text.set(key, { buffer });
						}
						return entryFocused ? buffer.render(this.#ctx.unicode) : buffer.text;
					},
				}).map((line) => (indent === "" ? line : `${indent}${line}`));
			}
			default: {
				// text / number / date / datetime / longtext: the one-line editor.
				const state = this.#textState(field);
				const line = focused
					? state.buffer.render(this.#ctx.unicode)
					: state.buffer.text;
				const editorHint =
					field.type === "longtext" && field.syntax === "code" && focused
						? this.#ctx.theme.dim("  (e: edit in $EDITOR)")
						: "";
				return [`${indent}${line}${editorHint}`];
			}
		}
	}

	/** Input handling (the host routes keys while the form has focus). */
	handleInput(data: string): void {
		if (this.#readOnly) return;
		const sections = stepperSections(this.#block, this.#interaction);
		if (sections !== null) {
			this.#inputStepper(data, sections);
			return;
		}
		if (this.#block.mode === "inline") {
			this.#inputInline(data);
			return;
		}
		this.#inputForm(data);
	}

	#inputStepper(data: string, sections: readonly SectionBlock[]): void {
		const total = sections.length;
		if (this.#step >= total) {
			// The review step: Up/Back returns, Enter submits once.
			if (data === "\x1b[A") {
				this.#step = total - 1;
				return;
			}
			if (data === "\r" && !this.#submitted) {
				if (this.#submit()) this.#submitted = true;
			}
			return;
		}
		const visible = this.#visibleFields();
		const field = visible[0];
		if (data === "\x1b[A") {
			if (this.#step > 0) this.#step -= 1;
			return;
		}
		if (data === "\t") {
			this.#step = Math.min(total, this.#step + 1);
			return;
		}
		if (field !== undefined && field.type === "choice") {
			const state = this.#choiceState(field);
			if (data === "\x1b[B") {
				state.cursor = Math.min(choiceRowCount(field, this.#ctx) - 1, state.cursor + 1);
				return;
			}
			if (data === "\x1b[A") {
				state.cursor = Math.max(0, state.cursor - 1);
				return;
			}
			if (data === "\r" || data === " ") {
				const next = choiceActivate(field, this.#ctx, this.#values[field.name], state.cursor);
				if (next !== undefined) {
					this.#change(field.name, next);
					return;
				}
				// The other row: Enter selects the typed text as the value.
				const typed = state.other.text;
				if (typed !== "") {
					this.#change(field.name, choiceSetOther(field, this.#values[field.name], typed));
				}
				return;
			}
			// Typing edits the other row's text (when the cursor sits on it).
			if (state.cursor >= choiceRowCount(field, this.#ctx) - 1 && field.allowOther !== undefined) {
				if (state.other.input(data)) {
					this.#change(field.name, choiceSetOther(field, this.#values[field.name], state.other.text));
				}
			}
		}
	}

	#inputInline(data: string): void {
		const field = this.#fields[0];
		if (field === undefined) return;
		if (data === "\r") {
			if (this.#submit()) {
				// Inline clears on success (the dispatch did not throw).
				const cleared: JsonObject = {};
				for (const item of this.#fields) {
					cleared[item.name] = initialValue(item, {});
					this.#text.set(item.name, { buffer: new EditBuffer("") });
				}
				this.#values = cleared;
			}
			return;
		}
		const state = this.#textState(field);
		if (state.buffer.input(data)) {
			this.#values = { ...this.#values, [field.name]: state.buffer.text };
		}
	}

	#inputForm(data: string): void {
		const count = this.#focusableCount();
		const focused = this.#fields[this.#focus];
		if (data === "\t") {
			this.#focus = Math.min(count - 1, this.#focus + 1);
			return;
		}
		// Up/Down move between fields EXCEPT when the focused field owns
		// a vertical cursor (choice/list): their rows consume the arrows.
		const ownsArrows =
			focused !== undefined && (focused.type === "choice" || focused.type === "list");
		if (data === "\x1b[A") {
			if (ownsArrows) {
				this.#inputField(focused, data);
			} else {
				this.#focus = Math.max(0, this.#focus - 1);
			}
			return;
		}
		if (data === "\x1b[B") {
			if (ownsArrows) {
				this.#inputField(focused, data);
			} else {
				this.#focus = Math.min(count - 1, this.#focus + 1);
			}
			return;
		}
		const field = this.#fields[this.#focus];
		if (field === undefined) {
			// The submit row.
			if (data === "\r") this.#submit();
			return;
		}
		if (field.disabled === true) return;
		this.#inputField(field, data);
	}

	/** Route input to the focused field's editor. */
	#inputField(field: Field, data: string): void {
		const value = this.#values[field.name];
		switch (field.type) {
			case "toggle":
				if (data === "\r" || data === " ") this.#change(field.name, value !== true);
				return;
			case "choice": {
				const state = this.#choiceState(field);
				clampChoiceCursor(field, this.#ctx, state);
				if (data === "\x1b[A" && state.cursor > 0) {
					state.cursor -= 1;
					return;
				}
				if (data === "\x1b[B" && state.cursor < choiceRowCount(field, this.#ctx) - 1) {
					state.cursor += 1;
					return;
				}
				if (data === "\r" || data === " ") {
					const next = choiceActivate(field, this.#ctx, value, state.cursor);
					if (next !== undefined) {
						this.#change(field.name, next);
						return;
					}
					const typed = state.other.text;
					if (typed !== "") {
						this.#change(field.name, choiceSetOther(field, value, typed));
					}
					return;
				}
				if (state.cursor >= choiceRowCount(field, this.#ctx) - 1 && field.allowOther !== undefined) {
					if (state.other.input(data)) {
						this.#change(field.name, choiceSetOther(field, value, state.other.text));
					}
				}
				return;
			}
			case "list": {
				const state = this.#listState(field);
				const entries = listEntries(value);
				if (data === "\x1b[A" && state.cursor > 0) {
					state.cursor -= 1;
					return;
				}
				if (data === "\x1b[B" && state.cursor < Math.max(0, entries.length - 1)) {
					state.cursor += 1;
					return;
				}
				if (data === "a" && listCanAdd(field, value)) {
					const next = listAdd(value);
					this.#change(field.name, next);
					// The cursor lands on the new entry so typing edits it.
					state.cursor = listEntries(next).length - 1;
					return;
				}
				if (data === "d" && entries.length > 0 && listCanRemove(field, value)) {
					this.#change(field.name, listRemove(value, state.cursor));
					state.cursor = Math.max(0, state.cursor - 1);
					return;
				}
				if (field.reorder === true) {
					if (data === "u") {
						this.#change(field.name, listMove(value, state.cursor, -1));
						state.cursor = Math.max(0, state.cursor - 1);
						return;
					}
					if (data === "j") {
						this.#change(field.name, listMove(value, state.cursor, 1));
						state.cursor = Math.min(entries.length - 1, state.cursor + 1);
						return;
					}
				}
				const key = `${field.name}.${state.cursor}`;
				let entryState = this.#text.get(key);
				if (entryState === undefined) {
					entryState = { buffer: new EditBuffer(valueText(entries[state.cursor])) };
					this.#text.set(key, entryState);
				}
				if (entryState.buffer.input(data)) {
					this.#change(field.name, listSet(value, state.cursor, entryState.buffer.text));
				}
				return;
			}
			case "file": {
				if (data !== "\r") {
					const state = this.#textState(field);
					if (state.buffer.input(data)) {
						// The typed path is editing scratch, not the value (the
						// value becomes the descriptor(s) on a successful pick).
					}
					return;
				}
				// Enter picks the typed path: check, read, dispatch onUpload.
				const path = this.#textState(field).buffer.text;
				if (path === "") return;
				const picked = pickFile(field, path);
				const state = this.#fileState(field);
				if (!picked.ok) {
					state.error = picked.error;
					return;
				}
				state.error = undefined;
				state.uploaded = [...state.uploaded, picked.descriptor.name];
				// A multi file field APPENDS picks; single replaces.
				const prior = this.#values[field.name];
				this.#values = {
					...this.#values,
					[field.name]:
						field.multi === true
							? [...(Array.isArray(prior) ? prior : []), picked.descriptor]
							: picked.descriptor,
				};
				this.#ctx.dispatch(
					{ type: "submit", name: field.onUpload, turn: false },
					{ field: field.name, files: [picked.payloadFile] },
				);
				this.#ctx.uploadBytes?.(field.name, picked.descriptor.name, picked.bytes);
				// The pick consumed the path; clear the editor so the next
				// pick types fresh (a multi field appends its descriptors).
				this.#text.set(field.name, { buffer: new EditBuffer("") });
				return;
			}
			case "longtext":
				if (field.syntax === "code" && data === "e" && this.#ctx.openEditor !== undefined) {
					const state = this.#textState(field);
					const result = this.#ctx.openEditor(state.buffer.text);
					if (result.ok) {
						state.buffer = new EditBuffer(result.text);
						this.#text.set(field.name, state);
						this.#change(field.name, result.text);
					}
					return;
				}
			// fall through to the text editor
			default: {
				const state = this.#textState(field);
				if (data === "\r") {
					// Enter on a text-shaped field moves to the next row (the
					// submit row's Enter sends the form).
					this.#focus = Math.min(this.#focusableCount() - 1, this.#focus + 1);
					return;
				}
				if (state.buffer.input(data)) {
					if (field.type === "number") {
						const raw = state.buffer.text;
						const parsed = Number(raw);
						// Never NaN into the values (NaN serializes to null and
						// defeats min/max validation): non-numeric text holds the
						// empty value until it parses.
						this.#change(field.name, raw === "" || Number.isNaN(parsed) ? "" : parsed);
						return;
					}
					this.#change(field.name, state.buffer.text);
				}
			}
		}
	}

	invalidate(): void {
		// The form's values/focus live in the component; a re-render
		// re-reads ctx.data for the bound object (data updates never
		// touch the editing state — Review Focus 4).
	}

	/** Cancel any pending live debounce (the host's dispose seam). */
	dispose(): void {
		if (this.#debounce !== null) clearTimeout(this.#debounce);
		this.#debounce = null;
	}

	/** Test/host introspection: the current values and focus. */
	get values(): JsonObject {
		return this.#values;
	}

	get focusIndex(): number {
		return this.#focus;
	}

	/** Move focus to the field with this name (the settings view's
	 *  search-resolve seam, U4 Task 4: a "naming" hit lands the
	 *  caret on the naming-model row). Returns false when no field
	 *  carries the name. */
	focusName(name: string): boolean {
		const index = this.#fields.findIndex((field) => field.name === name);
		if (index < 0) return false;
		this.#focus = index;
		return true;
	}

	/** The flattened field names (the host's search-resolve check). */
	get fieldNames(): readonly string[] {
		return this.#fields.map((field) => field.name);
	}

	get step(): number {
		return this.#step;
	}

	get submittedOnce(): boolean {
		return this.#submitted;
	}
}
