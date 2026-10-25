/**
 * The TUI's interaction SurfaceTransport (UI-blocks U6 Task 3), the port
 * of the webui's `interactionTransport.ts`: an interaction record IS the
 * surface — `load` returns the record's block tree (placement
 * `interaction`: a root `form` whose submit is the answer) with the
 * form's bind-path document as the initial data, and `act` on the submit
 * POSTs the payload as the answer `{values}` to the ONE generic answer
 * route (ruling 20).
 *
 * No polling: the record never changes while rendered here (a settle
 * lands via the prompter's list refetch, which drops the record from the
 * pending set), so `onChanged` is inert and `fetchData` echoes the load
 * data. `upload`/`image` reject: the interaction block set carries no
 * data-backed or upload blocks (§5.7's field set).
 */

import type {
	JsonObject,
	JsonValue,
	SurfaceActResult,
	SurfaceChangedEvent,
	SurfaceFetch,
	SurfaceLoad,
	SurfaceTransport,
	SurfaceUploadBody,
	Tree,
} from "@sigrun/shared/blocks";
import type { SigrunClient } from "../api.js";

export interface InteractionTransportOptions {
	readonly client: SigrunClient;
	readonly conversationId: number;
	readonly callId: string;
	/** The record's block-tree body (placement `interaction`). */
	readonly tree: Tree;
	/** The form's bind document (`/values` → `{values}`); a settled
	 *  record passes its stored answer so the read-only form renders the
	 *  values it was answered with. */
	readonly data: JsonObject;
	/** Settled records render read-only (spec §6.5). */
	readonly access: "read" | "write";
	/** The root form's submit action name (`onSubmit ?? "submit"`) — the
	 *  ONLY action that answers the record; every other action (a
	 *  callout button, a live-mode edit dispatch) is ignored. */
	readonly submitAction: string;
	/** An accepted answer's follow-through (the prompter's refetch). */
	readonly onAnswered?: () => void;
	/** A 404 (not_pending — the record settled under the user's fingers)
	 *  or a transport failure's follow-through; the original error rides
	 *  along so the host's error describer keeps its status formatting. */
	readonly onSettledElsewhere?: (message: string, cause: unknown) => void;
}

/** The record-as-surface transport. */
export function createInteractionTransport(
	options: InteractionTransportOptions,
): SurfaceTransport {
	let answered = false;
	return {
		load(): Promise<SurfaceLoad> {
			return Promise.resolve({
				tree: options.tree,
				data: options.data,
				rev: 0,
				treeRev: 0,
				access: options.access,
			});
		},
		fetchData(): Promise<SurfaceFetch> {
			return Promise.resolve({ rev: 0, treeRev: 0, data: options.data });
		},
		async act(body: {
			action: string;
			type: string;
			payload: JsonValue;
			actionId: string;
		}): Promise<SurfaceActResult> {
			// Only the root form's submit is the answer (Review fix): a
			// callout button or a live-mode edit dispatch must never POST
			// `{values}` — ignore it (an ok result keeps the form happy).
			// The gate checks the action KIND too (fix round 2): a callout
			// itemAction or a live-mode edit NAMED "submit" still isn't
			// one.
			if (body.type !== "submit" || body.action !== options.submitAction) {
				return { ok: true, rev: 0 };
			}
			// The form's submit payload is `{values}` (spec §5.6) — the
			// answer shape verbatim. A double-submit is a channel bug; the
			// route would 404 — guard anyway.
			if (answered) {
				return { ok: false, error: { message: "already answered" } };
			}
			const payload = body.payload;
			const values: JsonObject =
				typeof payload === "object" &&
				payload !== null &&
				!Array.isArray(payload) &&
				typeof (payload as { values?: unknown }).values === "object" &&
				(payload as { values?: unknown }).values !== null &&
				!Array.isArray((payload as { values?: unknown }).values)
					? (payload as { values: JsonObject }).values
					: {};
			try {
				await options.client.answerInteraction(
					options.conversationId,
					options.callId,
					{ values },
				);
			} catch (cause) {
				const message =
					cause instanceof Error ? cause.message : String(cause);
				options.onSettledElsewhere?.(message, cause);
				return { ok: false, error: { message } };
			}
			answered = true;
			options.onAnswered?.();
			return { ok: true, rev: 1 };
		},
		upload(_body: SurfaceUploadBody): Promise<SurfaceActResult> {
			return Promise.reject(
				new Error("interaction surfaces do not accept uploads"),
			);
		},
		image(): Promise<Uint8Array> {
			return Promise.reject(
				new Error("interaction surfaces have no image route"),
			);
		},
		onChanged(_listener: (event: SurfaceChangedEvent) => void): () => void {
			return () => {};
		},
	};
}
