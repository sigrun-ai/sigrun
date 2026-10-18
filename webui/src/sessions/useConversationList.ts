/**
 * useConversationList (B3, UI refresh): App's lifted conversation list.
 *
 * The sidebar, the ChatHeader's title, and (later) the transcript's
 * parent links all read these SAME rows — one request, no per-row meta
 * GETs (the A1 contract). The hook owns freshness:
 * - load on mount;
 * - poll every 10 s while `document.visibilityState === "visible"` (a
 *   hidden tab stays quiet — no background chatter);
 * - on a busy → idle transition reload IMMEDIATELY, then again after
 *   5 s, so a name the server auto-generated at run settlement appears
 *   without a manual reload.
 *
 * `reload` is exposed (App calls it after its own writes — create, fork,
 * meta PATCHes — so the sidebar reflects them at once instead of waiting
 * for the next tick). Errors never throw to the caller: `error` carries
 * the description and `rows` keeps the last good load.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ConversationSummary, SigrunClient } from "../api";

export interface UseConversationListResult {
	/** The latest list load (raw summaries — archived rows included). */
	readonly rows: readonly ConversationSummary[];
	/** Re-run the list GET now (resolves once the load settled). */
	reload(): Promise<void>;
	/** The latest load failure's description, or null. */
	readonly error: string | null;
}

const POLL_INTERVAL_MS = 10_000;
const BUSY_SETTLE_MS = 5_000;

/** The visibility gate; an absent document (test env) reads as visible. */
function documentVisible(): boolean {
	const state = (
		globalThis as { document?: { visibilityState?: string } }
	).document?.visibilityState;
	return (state ?? "visible") === "visible";
}

export function useConversationList(
	client: SigrunClient,
	options: { busy: boolean },
): UseConversationListResult {
	const busy = options.busy;
	const [rows, setRows] = useState<readonly ConversationSummary[]>([]);
	const [error, setError] = useState<string | null>(null);

	const reload = useCallback(async (): Promise<void> => {
		try {
			const list = await client.listConversations();
			setRows(list.conversations);
			setError(null);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}, [client]);

	useEffect(() => {
		void reload();
	}, [reload]);

	useEffect(() => {
		const timer = setInterval(() => {
			if (documentVisible()) void reload();
		}, POLL_INTERVAL_MS);
		return () => clearInterval(timer);
	}, [reload]);

	// The busy → idle transition: an immediate reload plus a settle reload
	// 5 s later (auto names land at run settlement, shortly after idle).
	const previousBusy = useRef(busy);
	useEffect(() => {
		const wasBusy = previousBusy.current;
		previousBusy.current = busy;
		if (!wasBusy || busy) return;
		void reload();
		const settle = setTimeout(() => void reload(), BUSY_SETTLE_MS);
		return () => clearTimeout(settle);
	}, [busy, reload]);

	return { rows, reload, error };
}
