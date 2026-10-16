/**
 * The interaction seam's TUI renderer (Task 8 — the parity rule): the
 * pending-interaction stack rendered as an answerable prompt strip
 * between the conversation pane and the composer (spec §3.2: "a visible
 * prompt in the conversation pane" — the TUI's medium-appropriate form is
 * a strip directly above the composer, where the answer keys live).
 *
 * Genericity (the seam's whole point): this component renders the closed
 * primitives (text / options / fields / diff) and the envelope, and knows
 * NOTHING about kinds — there is no "approval" here. `details` renders as
 * one collapsed JSON line, never interpreted (the single read is the
 * webui-parity `details.multi === true` multi-select flag).
 *
 * Answering: ctrl+o enters answer mode (the app routes it via
 * {@link TuiApp.handleKeybinding}; ctrl+a is the editor's cursorLineStart,
 * so the prompt uses ctrl+o). Digits 1-9 pick options — single-choice
 * answers immediately; multi (`details.multi`) toggles and enter submits
 * the accumulated set; esc exits. The answer POSTs through the ONE generic
 * route (`answerInteraction`); the record clears when the next list poll
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
 * Polling: {@link kick} on each stream frame (a revision may change the
 * pending set) plus a short interval while a conversation is active.
 * Kicks coalesce (one fetch in flight, one queued). Poll failures are
 * QUIET — the prompt keeps its last state; the stream's own error path
 * reports transport health. Answer failures (user-initiated) are LOUD via
 * {@link onError} (the app routes them to the pane's `[error]` line).
 */

import { Key, matchesKey, type Component } from "@earendil-works/pi-tui";
import type {
	InteractionAnswerInput,
	InteractionWire,
	SigrunClient,
} from "../api.js";
import { describeCommandError } from "./composer.js";

/** The default interaction poll interval (the brief's "short interval"). */
const DEFAULT_POLL_MS = 2_000;

/** The answer-mode option pick keys: digits 1-9. */
const DIGIT = /^[1-9]$/;

export interface InteractionPrompterOptions {
	/** Poll interval while a conversation is active (default 2s). */
	readonly pollMs?: number;
}

export class InteractionPrompter implements Component {
	readonly #client: SigrunClient;
	readonly #pollMs: number;

	#conversationId: number | undefined;
	/** Monotonic per-conversation generation: stale fetches never land. */
	#gen = 0;
	#pending: readonly InteractionWire[] = [];
	#answerMode = false;
	/** The multi-select working set (option ids), pre-seeded recommended. */
	#selected: ReadonlySet<string> = new Set();
	#timer: ReturnType<typeof setInterval> | undefined;
	/** Coalescing poll state: one fetch in flight, at most one queued. */
	#inFlight = false;
	#queued = false;

	/** Answer failures (user-initiated — loud). The app routes to the pane. */
	onError?: (message: string) => void;
	/** Rendered-state changes (the app requests a repaint). */
	onChanged?: () => void;

	constructor(client: SigrunClient, options?: InteractionPrompterOptions) {
		this.#client = client;
		this.#pollMs = options?.pollMs ?? DEFAULT_POLL_MS;
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
	 * Retarget the prompter: reset state, fetch immediately, and start the
	 * poll interval. `undefined` clears the prompt and stops polling.
	 */
	setConversation(id: number | undefined): void {
		this.#gen += 1;
		this.#conversationId = id;
		this.#pending = [];
		this.#exitAnswer();
		this.#stopTimer();
		// A fetch from the OLD conversation may still be in flight (or stuck);
		// its result is fenced by the generation guard, so its promise is
		// orphaned — the new conversation must not queue behind it.
		this.#inFlight = false;
		this.#queued = false;
		if (id === undefined) {
			this.#changed();
			return;
		}
		this.#timer = setInterval(() => this.kick(), this.#pollMs);
		// Never keep the process alive for chrome polling.
		this.#timer.unref();
		void this.#refresh();
	}

	/** Coalesced poll (the app's stream frames call this). */
	kick(): void {
		void this.#refresh();
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
			this.#answerMode = false;
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
				if (this.#pending.length === 0) this.#exitAnswer();
				this.#changed();
			} while (this.#queued && gen === this.#gen);
		} finally {
			if (gen === this.#gen) this.#inFlight = false;
		}
	}

	#stopTimer(): void {
		if (this.#timer !== undefined) {
			clearInterval(this.#timer);
			this.#timer = undefined;
		}
	}

	#changed(): void {
		this.onChanged?.();
	}

	/** Stop polling (the app calls this on dispose). */
	dispose(): void {
		this.#gen += 1;
		this.#stopTimer();
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
