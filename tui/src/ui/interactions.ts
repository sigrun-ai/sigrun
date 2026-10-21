/**
 * The interaction seam's TUI renderer (Task 8 — the parity rule): the
 * pending-interaction stack rendered as an answerable prompt strip
 * between the conversation pane and the composer (spec §3.2: "a visible
 * prompt in the conversation pane" — the TUI's medium-appropriate form is
 * a strip directly above the composer, where the answer keys live).
 *
 * Genericity (the seam's whole point): this component renders the closed
 * primitives (text / options / fields / diff) and the envelope, and knows
 * NOTHING about kinds — there is no gate-specific concept here. `details` renders as
 * one collapsed JSON line, never interpreted (the single read is the
 * webui-parity `details.multi === true` multi-select flag).
 *
 * Answering: ctrl+o enters answer mode (the app routes it via
 * {@link TuiApp.handleKeybinding}; ctrl+a is the editor's cursorLineStart,
 * so the prompt uses ctrl+o). Digits 1-9 pick options — single-choice
 * answers immediately; multi (`details.multi`) toggles and enter submits
 * the accumulated set; esc exits. Answer mode PINS the record it was
 * armed on: if a poll replaces the top of the stack before the user keys
 * an answer, the mode exits instead of answering a record the user never
 * saw. The answer POSTs through the ONE generic route
 * (`answerInteraction`); the record clears when the next list poll
 * reflects the settle (the server drops answered records from pending).
 *
 * Medium limits (the parity rule's documented exceptions):
 * - Form `fields` render read-only with a "answer in the webui" hint —
 *   the TUI's composer is the conversation's text input; capturing it for
 *   form values would collide with submission routing. v1 answers
 *   option-based prompts only.
 * - Option `tone` is a color/severity hint; the shell pins a no-color
 *   theme (styling is a later task), so tone is not rendered.
 *
 * Refetch triggers (W3 Task 4 — the 2s poll interval is RETIRED): kicks
 * arrive on each stream frame (a revision may change the pending set) and
 * on `interaction.*` host events (the app wires `watchEvents`'s
 * `interaction.pending`/`interaction.settled` to {@link kick}). Kicks
 * coalesce (one fetch in flight, one queued). Poll failures are
 * QUIET — the prompt keeps its last state; stream transport health is
 * reported separately by the watcher's error/open transition notices
 * (the launcher's stream-health wiring). Answer failures (user-initiated)
 * are LOUD via {@link onError} (the app routes them to the pane's
 * `[error]` line).
 */

import { Key, matchesKey, type Component } from "@earendil-works/pi-tui";
import type {
	InteractionAnswerInput,
	InteractionWire,
	SigrunClient,
} from "../api.js";
import { describeCommandError } from "./composer.js";

/** The answer-mode option pick keys: digits 1-9. */
const DIGIT = /^[1-9]$/;

export class InteractionPrompter implements Component {
	readonly #client: SigrunClient;

	#conversationId: number | undefined;
	/** Monotonic per-conversation generation: stale fetches never land. */
	#gen = 0;
	#pending: readonly InteractionWire[] = [];
	#answerMode = false;
	/**
	 * The record answer mode is ARMED ON. Pinned at beginAnswer: a poll can
	 * replace the top of the stack at any time (the record settled via the
	 * webui, the extension resolved it, it expired), and a digit keyed for
	 * the prompt the user READ must never answer the prompt that replaced
	 * it. Any top-identity change exits answer mode instead.
	 */
	#answerCallId: string | undefined;
	/** The multi-select working set (option ids), pre-seeded recommended. */
	#selected: ReadonlySet<string> = new Set();
	/** Coalescing poll state: one fetch in flight, at most one queued. */
	#inFlight = false;
	#queued = false;

	/** Answer failures (user-initiated — loud). The app routes to the pane. */
	onError?: (message: string) => void;
	/** Rendered-state changes (the app requests a repaint). */
	onChanged?: () => void;

	constructor(client: SigrunClient) {
		this.#client = client;
	}

	/** The latest pending list (top of stack first). */
	get pending(): readonly InteractionWire[] {
		return this.#pending;
	}

	/** Whether digit/enter/esc keys are captured for answering. */
	get answerMode(): boolean {
		return this.#answerMode;
	}

	/**
	 * Retarget the prompter: reset state and fetch immediately.
	 * `undefined` clears the prompt. (W3 Task 4: no poll interval —
	 * stream frames and `interaction.*` host events own the refreshes.)
	 */
	setConversation(id: number | undefined): void {
		this.#gen += 1;
		this.#conversationId = id;
		this.#pending = [];
		this.#exitAnswer();
		// A fetch from the OLD conversation may still be in flight (or stuck);
		// its result is fenced by the generation guard, so its promise is
		// orphaned — the new conversation must not queue behind it.
		this.#inFlight = false;
		this.#queued = false;
		if (id === undefined) {
			this.#changed();
			return;
		}
		void this.#refresh();
	}

	/** Coalesced poll (the app's stream frames call this). */
	kick(): void {
		void this.#refresh();
	}

	/**
	 * kick(), awaited. Production polls are fire-and-forget; tests need to
	 * await the poll's settle to assert the state after it.
	 */
	async kickAndWait(): Promise<void> {
		await this.#refresh();
	}

	/**
	 * Enter answer mode — only when the top pending item is option-
	 * answerable. Returns whether the mode was entered (the caller consumes
	 * the key only then).
	 */
	beginAnswer(): boolean {
		const top = this.#pending[0];
		const options = top?.body?.options ?? [];
		if (top === undefined || options.length === 0) return false;
		this.#answerMode = true;
		// Pin the target: keys answer THIS record or nothing.
		this.#answerCallId = top.callId;
		// The webui's pre-selection rule: recommended options start selected.
		this.#selected = new Set(
			options.filter((o) => o.recommended === true).map((o) => o.id),
		);
		this.#changed();
		return true;
	}

	/**
	 * Route one key while in answer mode. Returns true when consumed.
	 * Unrelated keys pass through (the seam never blocks — the user can
	 * keep typing while a prompt waits).
	 */
	handleKey(data: string): boolean {
		const top = this.#pending[0];
		const options = top?.body?.options ?? [];
		if (!this.#answerMode || top === undefined || options.length === 0) {
			this.#exitAnswer();
			return false;
		}
		// Target-pin check: if a poll replaced the armed record, the keys
		// the user is pressing belong to a prompt they never saw — exit
		// answer mode and let the key pass through unanswered.
		if (this.#answerCallId !== top.callId) {
			this.#exitAnswer();
			this.#changed();
			return false;
		}
		if (matchesKey(data, Key.escape)) {
			this.#exitAnswer();
			this.#changed();
			return true;
		}
		const multi = isMulti(top);
		if (matchesKey(data, Key.enter)) {
			if (multi && this.#selected.size > 0) {
				this.#submit(top, [...this.#selected]);
			}
			return true;
		}
		if (DIGIT.test(data)) {
			const index = Number(data) - 1;
			const option = options[index];
			if (option !== undefined) {
				if (multi) {
					const next = new Set(this.#selected);
					if (next.has(option.id)) {
						next.delete(option.id);
					} else {
						next.add(option.id);
					}
					this.#selected = next;
					this.#changed();
				} else {
					this.#submit(top, [option.id]);
				}
			}
			// In-range or not, digits belong to the prompt in answer mode.
			return true;
		}
		return false;
	}

	/** Fire-and-forget answer; the next list poll reflects the settle. */
	#submit(record: InteractionWire, ids: readonly string[]): void {
		const id = this.#conversationId;
		if (id === undefined) return;
		// Belt to the handleKey pin check: never POST for a record the
		// answer keys were not armed on.
		if (this.#answerCallId !== record.callId) return;
		this.#exitAnswer();
		this.#changed();
		const answer: InteractionAnswerInput = { ids };
		this.#client.answerInteraction(id, record.callId, answer).then(
			() => {
				void this.#refresh();
			},
			(error: unknown) => {
				this.onError?.(describeCommandError("answer", error));
				void this.#refresh();
			},
		);
	}

	#exitAnswer(): void {
		this.#answerMode = false;
		this.#answerCallId = undefined;
		this.#selected = new Set();
	}

	/** Generation-guarded, coalesced fetch of the pending list. */
	async #refresh(): Promise<void> {
		const id = this.#conversationId;
		const gen = this.#gen;
		if (id === undefined) return;
		if (this.#inFlight) {
			this.#queued = true;
			return;
		}
		this.#inFlight = true;
		try {
			do {
				this.#queued = false;
				let list;
				try {
					list = await this.#client.listInteractions(id);
				} catch {
					// Quiet poll failure: keep the last pending list.
					continue;
				}
				if (gen !== this.#gen) return; // stale — a switch happened
				// The route serves pending-only; the filter is belt for races.
				this.#pending = list.interactions.filter(
					(record) => record.status === "pending",
				);
				// The armed record left the top of the stack (settled via
				// another channel, resolved by its extension, expired — or
				// simply reordered): the user's armed keys belong to a prompt
				// they are no longer looking at. Exit answer mode rather than
				// risk answering a record they never saw.
				if (
					this.#answerMode &&
					this.#pending[0]?.callId !== this.#answerCallId
				) {
					this.#exitAnswer();
				}
				this.#changed();
			} while (this.#queued && gen === this.#gen);
		} finally {
			if (gen === this.#gen) this.#inFlight = false;
		}
	}

	#changed(): void {
		this.onChanged?.();
	}

	/** Detach (the app calls this on dispose): stale fetches never land. */
	dispose(): void {
		this.#gen += 1;
	}

	/**
	 * The prompt strip: nothing when no item is pending; otherwise the top
	 * item's header, body primitives, answer affordance, and a stack count.
	 */
	render(_width: number): string[] {
		const top = this.#pending[0];
		if (top === undefined) return [];
		const body = top.body;
		const options = body?.options ?? [];
		const fields = body?.fields ?? [];
		const multi = isMulti(top);
		const lines: string[] = [];
		lines.push(
			this.#answerMode
				? `[interaction] ${top.kind} — answering`
				: `[interaction] ${top.kind}`,
		);
		if (body?.text !== undefined) {
			for (const line of body.text.split("\n")) lines.push(line);
		}
		if (body?.diff !== undefined) {
			lines.push(
				body.diff.path === undefined
					? "[diff]"
					: `[diff] ${body.diff.path}`,
			);
			for (const line of body.diff.before.split("\n")) lines.push(`- ${line}`);
			for (const line of body.diff.after.split("\n")) lines.push(`+ ${line}`);
		}
		for (const [index, option] of options.entries()) {
			const marker =
				this.#answerMode && multi
					? this.#selected.has(option.id)
						? "[x] "
						: "[ ] "
					: "";
			const recommended = option.recommended === true ? " (recommended)" : "";
			const description =
				option.description === undefined ? "" : ` — ${option.description}`;
			lines.push(
				`  ${marker}${index + 1}. ${option.label}${recommended}${description}`,
			);
		}
		for (const field of fields) {
			const label = field.label ?? field.name;
			const required = field.required === true ? " required" : "";
			lines.push(`  - ${label} (${field.type})${required}`);
		}
		if (top.details !== undefined) {
			lines.push(`[details] ${JSON.stringify(top.details)}`);
		}
		if (this.#pending.length > 1) {
			lines.push(`+${this.#pending.length - 1} more pending`);
		}
		if (options.length > 0) {
			if (this.#answerMode) {
				lines.push(
					multi
						? "1-9 toggle · enter submit · esc cancel"
						: "1-9 answer · esc cancel",
				);
			} else {
				lines.push("ctrl+o to answer");
			}
		} else if (fields.length > 0) {
			lines.push("needs form input — answer in the webui");
		}
		return lines;
	}

	invalidate(): void {
		// Stateless render: lines assemble from the current pending list.
	}
}

/** The webui's multi-select reading: `details.multi === true`. */
function isMulti(record: InteractionWire): boolean {
	return (
		(record.details as { readonly multi?: boolean } | undefined)?.multi === true
	);
}
