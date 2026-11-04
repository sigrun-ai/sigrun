/**
 * useNotices (notices Task 6): the app's lifted per-user notice list.
 *
 * The shell owns ONE instance (App); the bell count, the pane, the
 * inline strip, and the peek all read the same rows. Freshness rides
 * `refetchToken` — App bumps it on the three triggers the shared events
 * source already observes (`notice.changed`, a reconnect `hello`, and
 * tab visibility), so the notices list heals exactly when the
 * conversation list heals.
 *
 * `arrivals` is the peek feed: notices whose ids were NOT in the
 * previous load (the server serves newest first, so a new post is a
 * load-time diff). Dismissals never count as arrivals.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { CoreTarget } from "@sigrun/shared/blocks";
import type {
	NoticeActionResponse,
	UserNotice,
	UserNoticeAction,
} from "@sigrun/shared/notices";
import type { SigrunClient } from "../api";

/** How long an ok-clear refetch waits: the card's own result-message
 *  window (NoticeCard's 4 s) — the message and the dismissal share the
 *  one deadline. */
export const RESULT_DELAY_MS = 4_000;

export interface UseNoticesResult {
	/** The latest load (newest first), or [] before the first load. */
	readonly notices: readonly UserNotice[];
	/** Notices newly posted since the last refetch (the peek feed). */
	readonly arrivals: readonly UserNotice[];
	/**
	 * Notices Task 7: the last action result's text per notice id (the
	 * card's transient `message`/`error` line, LIFTED out of the card —
	 * a clear-on-ok refetch drops the notice's row, and a card-local
	 * state update dies with it; the map survives the refetch, so the
	 * replacement row renders the same message). An entry lives 4 s
	 * (the card's old local window), then its heal removes the notice
	 * AND the entry together.
	 */
	readonly results: Readonly<Record<string, string>>;
	/** Re-run the list GET now (resolves once the load settled). */
	refetch(): Promise<void>;
	/** Dismiss one notice (204); the list refetches after the write. */
	dismiss(id: string): Promise<void>;
	/** Clear the pile (POST dismiss-all); the list refetches after it. */
	dismissAll(): Promise<void>;
	/**
	 * Run one notice action:
	 * - `navigate` → onNavigate(target), then dismiss;
	 * - `open` → `window.open(url, "_blank", "noopener,noreferrer")`, then dismiss;
	 * - `extension` → POST the action route; the response is returned to
	 *   the caller (the card shows its `message`/`error` for 4 s), the
	 *   list refetches (a server-side clear or replace is then visible),
	 *   and a returned `navigate` target routes onNavigate.
	 */
	run(
		notice: UserNotice,
		action: UserNoticeAction,
		onNavigate: (target: CoreTarget) => void,
	): Promise<NoticeActionResponse | undefined>;
}

export function useNotices(
	client: SigrunClient,
	opts: { readonly refetchToken: number },
): UseNoticesResult {
	const [notices, setNotices] = useState<readonly UserNotice[]>([]);
	const [arrivals, setArrivals] = useState<readonly UserNotice[]>([]);
	const [results, setResultsState] = useState<Readonly<Record<string, string>>>({});
	// The ref mirror: refetches read the retention set through the ref —
	// a refetch bound before `setResults` (the SSE `notice.changed`
	// token effect's) would otherwise see an EMPTY map and drop the
	// row mid-message (the stale-closure race this whole seam exists
	// to close).
	const resultsRef = useRef<Readonly<Record<string, string>>>({});
	const setResults = useCallback(
		(
			updater:
				| Readonly<Record<string, string>>
				| ((current: Readonly<Record<string, string>>) => Readonly<Record<string, string>>),
		): void => {
			resultsRef.current =
				typeof updater === "function" ? updater(resultsRef.current) : updater;
			setResultsState(resultsRef.current);
		},
		[],
	);
	const knownRef = useRef<ReadonlySet<string> | null>(null);
	// The result-message hold (spec §6's "briefly on the notice"): an
	// ok-clear sets this until the card's 4 s window ends; EVERY refetch
	// path (the token effect AND a `notice.changed` SSE frame) gates on
	// it so the card keeps rendering its message while the pile heals
	// around it.
	const holdUntilRef = useRef(0);
	// Notices whose extension action is IN FLIGHT (set synchronously at
	// dispatch, cleared when the response settles). A `notice.changed`
	// SSE frame can land before the response (and before `results` has
	// the entry) — the retention below must not drop the row in that
	// window either (a dropped row can never render the message).
	const pendingRef = useRef<ReadonlySet<string>>(new Set());

	const refetch = useCallback(
		async (force = false): Promise<void> => {
			const response = await client.listNotices();
			const next = response.notices;
			const known = knownRef.current;
			if (known !== null) {
				setArrivals(next.filter((one) => !known.has(one.id)));
			}
			knownRef.current = new Set(next.map((one) => one.id));
			// The result-message hold (spec §6's "briefly on the notice"):
			// while the hold is armed, rows with a live result entry are
			// RETAINED even though the server already dropped them — the
			// card needs its row to hang the message on, and React drops
			// a row's queued state when an ancestor removes it. The heal
			// at the window's end refetches forced (no retention).
			if (!force && Date.now() < holdUntilRef.current) {
				setNotices((current) => {
					const fresh = new Set(next.map((one) => one.id));
					return [
						// Rows the server still has, in server order…
						...next,
						// …then rows retained while their message lives: a live
						// result entry OR an in-flight action (the SSE frame
						// that lands before the response has settled). Read
						// through the REFS — this callback can be a stale
						// binding from before the response applied.
						...current.filter(
							(one) =>
								!fresh.has(one.id) &&
								(resultsRef.current[one.id] !== undefined ||
									pendingRef.current.has(one.id)),
						),
					];
				});
				return;
			}
			setNotices(next);
		},
		[client],
	);

	// One scheduled-heal handle at a time (a second hold replaces the
	// first — the pile heals once, at the LATER deadline). The heal also
	// drops the expired result entries (the message and the notice's
	// dismissal share the one window).
	const healTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const scheduleHeal = useCallback((): void => {
		holdUntilRef.current = Date.now() + RESULT_DELAY_MS;
		if (healTimerRef.current !== null) clearTimeout(healTimerRef.current);
		healTimerRef.current = setTimeout(() => {
			healTimerRef.current = null;
			setResults({});
			// The heal is the window's own expiry: forced (it IS the
			// deadline the gate was holding for).
			void refetch(true).catch(() => undefined);
		}, RESULT_DELAY_MS);
		const timer = healTimerRef.current;
		// An unref'd handle keeps a bare node host (the test renderer's
		// environment) from hanging on the 4 s tail.
		if (typeof timer === "object" && timer !== null && "unref" in timer) {
			(timer as { unref(): void }).unref();
		}
	}, [refetch]);

	useEffect(() => {
		// The token effect goes through the same hold gate (the refetch
		// itself swallows while the result-message window is armed).
		void refetch().catch(() => undefined);
	}, [refetch, opts.refetchToken]);

	const dismiss = useCallback(
		async (id: string): Promise<void> => {
			// A stale click after a keyed replace 404s (Review Focus 2): the
			// refetch heals the pile either way, so never skip it.
			await client.dismissNotice(id).catch(() => undefined);
			await refetch().catch(() => undefined);
		},
		[client, refetch],
	);

	const dismissAll = useCallback(async (): Promise<void> => {
		await client.dismissAllNotices().catch(() => undefined);
		await refetch().catch(() => undefined);
	}, [client, refetch]);

	const run = useCallback(
		async (
			notice: UserNotice,
			action: UserNoticeAction,
			onNavigate: (target: CoreTarget) => void,
		): Promise<NoticeActionResponse | undefined> => {
			if (action.kind === "navigate") {
				onNavigate(action.target);
				await dismiss(notice.id);
				return undefined;
			}
			if (action.kind === "open") {
				(globalThis as { window?: Window }).window?.open(
					action.url,
					"_blank",
					"noopener,noreferrer",
				);
				await dismiss(notice.id);
				return undefined;
			}
			// Mark in-flight SYNCHRONOUSLY — a clear-driven SSE refetch can
			// land before the response resolves, and the retention reads
			// this set (not the async state) to keep the row.
			pendingRef.current = new Set([...pendingRef.current, notice.id]);
			let response: NoticeActionResponse;
			try {
				response = await client.runNoticeAction(notice.id, action.id);
			} finally {
				const next = new Set(pendingRef.current);
				next.delete(notice.id);
				pendingRef.current = next;
			}
			if (response.ok && response.navigate !== undefined) {
				onNavigate(response.navigate);
			}
			// Record the result text into the lifted map FIRST — the card
			// renders from here, so the message is independent of which
			// refetch drops the row.
			const text = response.ok
				? response.message
				: response.error.message;
			if (text !== undefined) {
				setResults((current) => ({ ...current, [notice.id]: text }));
			}
			// The card's result-message paint races every clear-driven
			// refetch (the hook's own AND the `notice.changed` SSE frame):
			// a clear drops the card's row, and a row's own React state
			// dies with it (React discards the queued update on the
			// ancestor-removed subtree). The lifted map above already
			// carries the message; on ok the heal is DEFERRED to the card's
			// old 4 s window (the notice dismisses with the message — one
			// deadline for both; a `keep` answer simply sees an unchanged
			// pile). A failure leaves the notice, so its refetch runs
			// immediately. ONLY a pile SHOWING the notice holds — an
			// invisible one heals now (a same-notice `notice.changed`
			// replace would otherwise show a stale copy for the window).
			if (response.ok && notices.some((one) => one.id === notice.id)) {
				scheduleHeal();
				return response;
			}
			await refetch(true).catch(() => undefined);
			return response;
		},
		[client, dismiss, refetch, scheduleHeal, notices],
	);

	return { notices, arrivals, results, refetch, dismiss, dismissAll, run };
}
