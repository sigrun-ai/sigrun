/**
 * The interaction seam's TUI renderer (UI-blocks U6 Task 3, the parity
 * rule): the pending-interaction stack rendered FROM BLOCK TREES — each
 * record's body is a root `form` (placement `interaction`, spec §9.1)
 * rendered through the shared renderer against a
 * {@link createInteractionTransport}: the record IS the surface (the
 * tree is the load, the form's submit POSTs `{values}` to the ONE
 * generic answer route — ruling 20). The strip sits between the
 * conversation pane and the composer, where the answer keys live.
 *
 * Genericity (the seam's whole point): the renderer renders the tree
 * and knows NOTHING about kinds. `details` renders as one collapsed
 * JSON line, never interpreted.
 *
 * Answering: ctrl+o ARMS the prompt (the app routes it via
 * {@link TuiApp.handleKeybinding}; ctrl+a is the editor's
 * cursorLineStart, so the prompt uses ctrl+o); while armed, keys route
 * to the rendered form (choice rows take digits 1-9 as a direct pick —
 * the medium-appropriate accelerator — plus the form's own keys; a
 * multi-question form's stepper advances with Tab, reviews, and submits
 * ONCE with Enter). Answer mode PINS the record it was armed on: if a
 * poll replaces the top of the stack before the user keys an answer,
 * the mode exits instead of answering a record the user never saw.
 *
 * Expiry mid-stepper (Review Focus 2): a submit that lands on an
 * already-settled record (404 not_pending) refetches the record through
 * {@link SigrunClient.getInteraction}, renders its settled status, and
 * keeps the typed values visible but read-only (the form's state
 * survives — the tree never changed).
 *
 * Refetch triggers (W3 Task 4 — the 2s poll interval is RETIRED): kicks
 * arrive on each stream frame and on `interaction.*` host events. Kicks
 * coalesce (one fetch in flight, one queued). Poll failures are QUIET —
 * the prompt keeps its last state; answer failures (user-initiated) are
 * LOUD via {@link onError}.
 */

import { Key, matchesKey, type Component } from "@earendil-works/pi-tui";
import type { JsonObject, JsonValue, Tree } from "@sigrun/shared/blocks";
import type { InteractionWire, SigrunClient } from "../api.js";
import { createInteractionTransport } from "../blocks/interaction-transport.js";
import { SurfaceState } from "../blocks/surface.js";
import { SurfaceView } from "../blocks/surface-view.js";
import { plainTuiTheme, type TuiTheme } from "../theme.js";
import { describeCommandError } from "./composer.js";

/** The answer-mode direct-pick keys: digits 1-9. */
const DIGIT = /^[1-9]$/;

/** The record-as-surface data document: the form binds `/values`, so
 *  the document is `{values}` — a settled record's stored answer seeds
 *  the read-only render (spec §6.5; secret fields render write-only
 *  regardless). */
function recordData(record: InteractionWire): JsonObject {
	if (record.answer === undefined) return {};
	return { values: { ...record.answer.values } } as JsonObject;
}

/** One rendered interaction record: the surface pair plus the settled
 *  envelope a mid-edit settle refetch swapped in. */
interface SurfaceCard {
	readonly record: InteractionWire;
	readonly state: SurfaceState;
	readonly view: SurfaceView;
	/** Whether the surface renders read-only (settled records). */
	readonly access: "read" | "write";
	/** The settled envelope a mid-edit settle refetch swapped in
	 *  (preferred over `record` for rendering: a same-callId poll still
	 *  serves the record PENDING, so the settled envelope must win or
	 *  the read-only swap reverts on the next render — Review fix). */
	readonly settled?: InteractionWire;
}

export class InteractionPrompter implements Component {
	readonly #client: SigrunClient;
	readonly #theme: TuiTheme;

	#conversationId: number | undefined;
	/** Monotonic per-conversation generation: stale fetches never land. */
	#gen = 0;
	#pending: readonly InteractionWire[] = [];
	#answerMode = false;
	/**
	 * The record answer mode is ARMED ON. Pinned at beginAnswer: a poll can
	 * replace the top of the stack at any time (the record settled via the
	 * webui, the extension resolved it, it expired), and a key pressed for
	 * the prompt the user READ must never answer the prompt that replaced
	 * it. Any top-identity change exits answer mode instead.
	 */
	#answerCallId: string | undefined;
	/**
	 * The rendered surface of the TOP record (rebuilt when the top's
	 * identity changes; NOT rebuilt on a mere list refresh of the same
	 * record — the form's typed state must survive a poll, Review Focus
	 * 2's "typed values stay visible").
	 */
	#surface: SurfaceCard | undefined;
	/** Coalescing poll state: one fetch in flight, at most one queued. */
	#inFlight = false;
	#queued = false;

	/** Answer failures (user-initiated — loud). The app routes to the pane. */
	onError?: (message: string) => void;
	/** Rendered-state changes (the app requests a repaint). */
	onChanged?: () => void;

	constructor(client: SigrunClient, options: { theme?: TuiTheme } = {}) {
		this.#client = client;
		// No-color default (the shell pins structure; styling rides the
		// app's theme when the host passes one).
		this.#theme = options.theme ?? plainTuiTheme();
	}

	/** The latest pending list (top of stack first). */
	get pending(): readonly InteractionWire[] {
		return this.#pending;
	}

	/** Whether keys are captured for answering. */
	get answerMode(): boolean {
		return this.#answerMode;
	}

	/** The live surface's state (tests drive non-submit dispatches
	 *  through it). */
	get surface(): SurfaceState | undefined {
		return this.#surface?.state;
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
		this.#surface?.state.dispose();
		this.#surface = undefined;
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
	 * Enter answer mode — only when the top pending item carries a
	 * block-tree body to answer. Returns whether the mode was entered (the
	 * caller consumes the key only then).
	 */
	beginAnswer(): boolean {
		const top = this.#pending[0];
		if (top === undefined || top.body === undefined) return false;
		this.#ensureSurface(top);
		this.#answerMode = true;
		// Pin the target: keys answer THIS record or nothing.
		this.#answerCallId = top.callId;
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
		if (!this.#answerMode || top === undefined) {
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
		this.#ensureSurface(top);
		if (this.#surface === undefined) {
			this.#exitAnswer();
			return false;
		}
		// A digit aims at the top record's choice field — the
		// one-question gate's direct pick (1-9 answers immediately).
		// Everything else — arrows, Tab, Enter, typed text — is the
		// form's own key language. The shortcut only fires on a
		// ONE-question gate (no stepper): a multi-question stepper's
		// digits belong to the form's per-step choice editing.
		if (DIGIT.test(data)) {
			const body: Tree | undefined = top.body;
			const choice = body === undefined ? undefined : firstChoice(body);
			const stepper =
				body !== undefined &&
				body.root.type === "form" &&
				stepperSections(body.root, true) !== null;
			if (choice !== undefined && !stepper) {
				const index = Number(data) - 1;
				const option = Array.isArray(choice.options)
					? choice.options[index]
					: undefined;
				if (option !== undefined) {
					const form = formComponent(this.#surface);
					if (form !== undefined) {
						if (choice.multi === true) {
							// Multi: toggle into the form's value; Enter (the
							// form's key) submits the accumulated set.
							const current = form.fieldValue(choice.name);
							const set = new Set(
								Array.isArray(current) ? (current as string[]) : [],
							);
							if (set.has(option.id)) {
								set.delete(option.id);
							} else {
								set.add(option.id);
							}
							form.setFieldValue(choice.name, [...set]);
							this.#changed();
							return true;
						}
						form.setFieldValue(choice.name, option.id);
						// Single-choice: the pick IS the answer — submit at
						// once (the one-question gate's direct pick).
						this.#surface.state.dispatch(
							{ type: "submit", name: "submit" },
							{ values: { ...(form.values ?? {}) } },
						);
						return true;
					}
				}
				// No matching option: the digit still belongs to the prompt.
				return true;
			}
			// A stepper's digits route to the form (its stepper owns the
			// per-step choice editing).
			if (choice !== undefined) {
				this.#surface.view.handleInput(data);
				return true;
			}
			return true;
		}
		this.#surface.view.handleInput(data);
		return true;
	}



	/** Build (or keep) the top record's surface pair. A mid-edit settle
	 *  swap (Review Focus 2) reuses the same callId: the settled envelope
	 *  flips access to read; the tree is unchanged so the typed values
	 *  stay on screen. */
	#ensureSurface(record: InteractionWire): void {
		const existing = this.#surface;
		if (existing !== undefined && existing.record.callId === record.callId) {
			// A settled envelope (the mid-edit settle swap) sticks: the
			// pending poll re-serves the record as pending, and the
			// settled render must not revert to write access.
			if (existing.settled !== undefined) return;
			const access = record.status === "pending" ? "write" : "read";
			if (existing.access === access) return;
			this.#surface = { ...existing, record, access };
			return;
		}
		const access = record.status === "pending" ? "write" : "read";
		const conversationId = this.#conversationId;
		if (conversationId === undefined || record.body === undefined) return;
		const root = record.body.root;
		const submitAction =
			root.type === "form" ? (root.onSubmit ?? "submit") : "submit";
		const transport = createInteractionTransport({
			client: this.#client,
			conversationId,
			callId: record.callId,
			tree: record.body,
			data: recordData(record),
			access,
			submitAction,
			onAnswered: () => {
				// The settle lands via the next list poll (the server drops
				// answered records from pending).
				this.#exitAnswer();
				void this.#refresh();
			},
			onSettledElsewhere: (_message, cause) => {
				// The settle raced the user's submit (expiry, another channel,
				// the extension): refetch the record and render it settled —
				// the typed values stay visible, read-only (Review Focus 2).
				const id = this.#conversationId;
				if (id === undefined) {
					this.onError?.(describeCommandError("answer", cause));
					return;
				}
				this.#client.getInteraction(id, record.callId).then(
					(fresh: InteractionWire) => {
						// Swap ONLY the record the user was working on; a
						// conversation switch since the submit discards it.
						if (this.#surface?.record.callId !== record.callId) return;
						// Only a genuinely settled record swaps in — a still-
						// pending refetch (a 400, a network blip) must NOT wedge
						// the card read-only: report the failure and stay
						// writable (Review fix).
						if (fresh.status === "pending") {
							this.onError?.(describeCommandError("answer", cause));
							this.#changed();
							return;
						}
						this.#surface = this.#surface === undefined
							? undefined
							: {
									...this.#surface,
									settled: fresh,
									access: "read",
								};
						// Flip the LIVE surface's access so the read-only
						// render takes effect immediately (the transport's
						// access was captured at load).
						this.#surface?.state.setAccess("read");
						this.#exitAnswer();
						this.#changed();
					},
					() => {
						this.onError?.(describeCommandError("answer", cause));
					},
				);
			},
		});
		const state = new SurfaceState(transport);
		const view = new SurfaceView(state, {
			theme: this.#theme,
			unicode: true,
			options: { interaction: true },
		});
		this.#surface = { record, state, view, access };
		// The record's tree is static, so the load resolves within a
		// microtask; the repaint lands via the change subscription.
		state.onChange(() => this.#changed());
		void state.load();
	}

	#exitAnswer(): void {
		this.#answerMode = false;
		this.#answerCallId = undefined;
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
				// A top-identity change rebuilds the surface; a same-record
				// refresh keeps it (typed values survive the poll).
				const top = this.#pending[0];
				if (top === undefined) {
					this.#surface?.state.dispose();
					this.#surface = undefined;
				} else if (this.#surface?.record.callId !== top.callId) {
					this.#surface?.state.dispose();
					this.#surface = undefined;
					// Build eagerly (not at render) so the async load settles
					// with the poll's flush — a strip that waits a frame for
					// "loading…" reads as a flicker.
					this.#ensureSurface(top);
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
	 * item's header, its block tree, the answer affordance, and a stack
	 * count.
	 */
	render(width: number): string[] {
		const top = this.#pending[0];
		if (top === undefined) return [];
		const lines: string[] = [];
		const shown = this.#surface?.settled ?? top;
		const suffix =
			this.#answerMode
				? " — answering"
				: shown.status === "pending"
					? ""
					: ` — ${shown.status}`;
		lines.push(`[interaction] ${shown.kind}${suffix}`);
		if (top.body !== undefined) {
			this.#ensureSurface(top);
			if (this.#surface !== undefined) {
				lines.push(...this.#surface.view.render(width));
			}
		}
		if (top.details !== undefined) {
			lines.push(`[details] ${JSON.stringify(top.details)}`);
		}
		if (this.#pending.length > 1) {
			lines.push(`+${this.#pending.length - 1} more pending`);
		}
		if (top.body !== undefined) {
			lines.push(
				this.#answerMode
					? "1-9 answer · Tab next · esc cancel"
					: "ctrl+o to answer",
			);
		}
		return lines;
	}

	invalidate(): void {
		this.#surface?.view.invalidate();
	}
}

import type { ChoiceField } from "@sigrun/shared/blocks";
import { stepperSections } from "../blocks/form/form.js";

/** The form's first choice field (the digit accelerator's target), or
 *  undefined when the form holds none. */
function firstChoice(tree: Tree): ChoiceField | undefined {
	const root = tree.root;
	if (root.type !== "form") return undefined;
	const walk = (children: readonly unknown[]): ChoiceField | undefined => {
		for (const child of children) {
			if (typeof child !== "object" || child === null) continue;
			const record = child as JsonObject;
			if (record.type === "choice" && typeof record.name === "string") {
				// SAFETY: the type/name guard above is the choice field's
				// identifying shape (the tree passed placement validation).
				return record as unknown as ChoiceField;
			}
			if (record.type === "section" && Array.isArray(record.children)) {
				const found = walk(record.children);
				if (found !== undefined) return found;
			}
		}
		return undefined;
	};
	return walk(root.children);
}

/** The wrapped form component, when the surface's root is a form. */
function formComponent(surface: SurfaceCard): {
	setFieldValue(name: string, value: JsonValue): void;
	fieldValue(name: string): JsonValue | undefined;
	values: JsonObject | undefined;
} | undefined {
	const inner = surface.view.inner;
	if (inner === undefined) return undefined;
	if (!("setFieldValue" in inner)) return undefined;
	// SAFETY: the WidthGated wrapper forwards the form introspection
	// (the render seam's forwarding contract).
	return inner as unknown as {
		setFieldValue(name: string, value: JsonValue): void;
		fieldValue(name: string): JsonValue | undefined;
		values: JsonObject | undefined;
	};
}

