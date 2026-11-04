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

export interface UseNoticesResult {
	/** The latest load (newest first), or [] before the first load. */
	readonly notices: readonly UserNotice[];
	/** Notices newly posted since the last refetch (the peek feed). */
	readonly arrivals: readonly UserNotice[];
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
	const knownRef = useRef<ReadonlySet<string> | null>(null);

	const refetch = useCallback(async (): Promise<void> => {
		const response = await client.listNotices();
		const next = response.notices;
		const known = knownRef.current;
		if (known !== null) {
			setArrivals(next.filter((one) => !known.has(one.id)));
		}
		knownRef.current = new Set(next.map((one) => one.id));
		setNotices(next);
	}, [client]);

	useEffect(() => {
		void refetch().catch(() => undefined);
	}, [refetch, opts.refetchToken]);

	const dismiss = useCallback(
		async (id: string): Promise<void> => {
			await client.dismissNotice(id);
			await refetch().catch(() => undefined);
		},
		[client, refetch],
	);

	const dismissAll = useCallback(async (): Promise<void> => {
		await client.dismissAllNotices();
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
			const response = await client.runNoticeAction(notice.id, action.id);
			if (response.ok && response.navigate !== undefined) {
				onNavigate(response.navigate);
			}
			// Whether the action kept or cleared the notice, the refetch
			// reflects it (a clear disappears; a keep stays).
			await refetch().catch(() => undefined);
			return response;
		},
		[client, dismiss, refetch],
	);

	return { notices, arrivals, refetch, dismiss, dismissAll, run };
}
