/**
 * The interaction SurfaceTransport (UI-blocks U6 Task 3): an interaction
 * record rendered through the block renderer. The record IS the state —
 * `load` returns the record's block tree (placement `interaction`: a
 * root `form`) with the form's bind path as the initial data, and
 * `act` on the form's submit POSTs the payload as the answer `{values}`
 * to the ONE generic answer route.
 *
 * No polling: a record never changes while rendered here (an expiry or
 * an extension-side settle lands via the channel's list refetch, which
 * drops the record from the pending set). `fetchData`/`upload`/`image`
 * are rejected placeholders — the interaction block set has no
 * data-backed or upload blocks.
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

export interface InteractionTransportOptions {
	readonly conversationId: number;
	readonly callId: string;
	/** The record's block-tree body (placement `interaction`). */
	readonly tree: Tree;
	/** The data the form's bind path points at (`/values` → `{values}`).
	 *  A settled record passes its stored answer so the read-only form
	 *  renders the values it was answered with. */
	readonly data: JsonObject;
	/** Settled records render read-only (spec §6.5). */
	readonly access: "read" | "write";
	/** The root form's submit action name (`onSubmit ?? "submit"`) — the
	 *  ONLY action that answers the record; every other action (a
	 *  callout button, a live-mode edit dispatch) is ignored. */
	readonly submitAction: string;
	/** The answer route. `values` is the act payload verbatim. */
	readonly answer: (body: { values: JsonObject }) => Promise<unknown>;
	/** An accepted answer's follow-through (the channel's list refetch). */
	readonly onAnswered?: () => void;
	/** A 404 (not_pending — the record settled under the user's fingers)
	 *  or a transport failure's follow-through. */
	readonly onSettledElsewhere?: (message: string) => void;
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
			// No data document: nothing ever changes server-side mid-card.
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
			// answer shape verbatim (ruling 20). A pending record answered
			// twice is a channel bug; guard anyway (the route would 404).
			if (answered) {
				return { ok: false, error: { message: "already answered" } };
			}
			const payload = body.payload;
			const values =
				typeof payload === "object" &&
				payload !== null &&
				!Array.isArray(payload) &&
				typeof (payload as { values?: unknown }).values === "object" &&
				(payload as { values?: unknown }).values !== null
					? ((payload as { values: JsonObject }).values)
					: {};
			try {
				await options.answer({ values });
			} catch (cause) {
				const message =
					cause instanceof Error ? cause.message : String(cause);
				options.onSettledElsewhere?.(message);
				return { ok: false, error: { message } };
			}
			answered = true;
			options.onAnswered?.();
			return { ok: true, rev: 1 };
		},
		upload(_body: SurfaceUploadBody): Promise<SurfaceActResult> {
			// The interaction placement has no file field (§5.7).
			return Promise.reject(
				new Error("interaction surfaces do not accept uploads"),
			);
		},
		image(): Promise<Uint8Array> {
			// U7 owns image routes; the interaction block set carries none.
			return Promise.reject(new Error("interaction surfaces have no image route"));
		},
		onChanged(_listener: (event: SurfaceChangedEvent) => void): () => void {
			// Nothing to subscribe to: the record is static while rendered.
			return () => {};
		},
	};
}
