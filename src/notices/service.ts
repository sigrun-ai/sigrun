/**
 * The notices service (notices Task 3, spec §2/§4): the one mediation
 * point between the store files and every caller — the extension-facing
 * `host.notices` surface (via the host bridge), the HTTP routes (Task
 * 4), and the user-removal path (`removeUser`).
 *
 * Responsibilities the store deliberately does NOT own:
 *
 *  - access: a post's recipient must exist, and every conversation the
 *    notice names (`conversationId`, plus any `navigate` action's
 *    conversation target) must be visible to that user — the service's
 *    `visible` dep answers for an ARBITRARY directory user
 *    (`visibleToUser`), because the posting extension is never the
 *    recipient;
 *  - the declared-handler gate: an `extension` action's `name` must be
 *    declared in the posting extension's `noticeActions` (the loader's
 *    bindings are the registry);
 *  - the `notice.changed` feed: the store's `NoticeChange` becomes the
 *    hub event (`NoticeChangedInternal` — the wire shape plus the user);
 *  - visibility pruning on the user read: `listForUser` re-checks every
 *    conversation notice against the CURRENT share state and removes the
 *    ones the user can no longer see (a revoked share never leaves the
 *    name behind — spec §3 "Lost access");
 *  - action dispatch (`runAction`): the surface-action primitives
 *    (per-principal rate limit, requestId dedup, the 10 s timeout),
 *    the notice lookup, and the clear-on-ok rule.
 *
 * The per-user store cache (`stores` map) exists because constructing a
 * `NoticeStore` is closure-allocation over ONE user area; the store
 * itself caches nothing (every op reads the file under the area mutex),
 * so a stale cache entry can never serve stale data. `removeUser`
 * evicts the entry (Task 5's users route deletes the file).
 */

import { ACTION_TIMEOUT_MS } from "../server/surfaces/service.js";
import { ActionDedup } from "../server/surfaces/dedup.js";
import { ActionRateLimit } from "../server/surfaces/rate-limit.js";
import type { ActionResponse } from "../server/surfaces/service.js";
import type { Principal, UserNoticeActionResult } from "../extension.js";
import type {
	NoticeActionResponse,
	UserNotice,
	UserNoticeAction,
} from "@sigrun/shared/notices";
import type { HostEventWire } from "@sigrun/shared/views";
import type { JsonObject } from "@sigrun/shared/blocks";
import type { OpenedHarness } from "../harness/boot.js";
import { NoticeStore, type NoticeChange } from "./store.js";
import type { NoticeChangedInternal } from "./events.js";
import { validateNoticeInput } from "./validate.js";

/** What the service needs: the boot, its seams, and the publish sink. */
export interface NoticesServiceDeps {
	readonly opened: OpenedHarness;
	/** One user's state directory (the store file's home). */
	readonly userArea: (user: string) => string;
	/** Visibility for an ARBITRARY directory user (server/visibility.ts). */
	readonly visible: (conversationId: number, user: string) => Promise<boolean>;
	/** The hub publish (the store's changes become `notice.changed`). */
	readonly publish: (event: HostEventWire) => void;
	readonly now: () => Date;
	readonly log: (line: string) => void;
}

/** `runAction`'s answer: the HTTP status the route returns, plus the body. */
export type NoticeActionAnswer = {
	readonly status: 200 | 400 | 404 | 409 | 429;
	readonly body: NoticeActionResponse | { readonly error: string };
};

/**
 * The dedup table for notice actions (spec §4): keyed by the client
 * requestId, like the surface service's — same-notice retries replay
 * the first result. The shared `ActionDedup` is typed on the surface
 * `ActionResponse`; Task 4 makes it generic — until then the notice
 * body crosses as a cast (both are the `{ok, ...}` result shape).
 */
type NoticeDedup = ActionDedup;

export class NoticesService {
	private readonly stores = new Map<string, NoticeStore>();
	private readonly dedup: NoticeDedup = new ActionDedup();
	private readonly rateLimit = new ActionRateLimit();

	constructor(private readonly deps: NoticesServiceDeps) {}

	/**
	 * Post one notice as `owner` (the calling extension's slug): shape
	 * validation plus the declared-handler gate, then the access checks
	 * (unknown user; an invisible conversation or navigate target), then
	 * the store write. Throws `Error("<field>: <message>")` on any
	 * rejection — the fail-loud posture.
	 */
	async post(owner: string, input: unknown): Promise<{ id: string }> {
		const declared = this.declaredHandlers(owner);
		const validation = validateNoticeInput(input, declared);
		if (!validation.ok) {
			throw new Error(`${validation.field}: ${validation.message}`);
		}
		const notice = validation.value;
		const record = this.deps.opened.identity.users.get(notice.user);
		if (record === undefined) {
			throw new Error(`user: unknown user "${notice.user}"`);
		}
		if (
			notice.conversationId !== undefined &&
			!(await this.deps.visible(notice.conversationId, notice.user))
		) {
			throw new Error(
				`conversationId: conversation ${notice.conversationId} not visible to user "${notice.user}"`,
			);
		}
		for (const [index, action] of (notice.actions ?? []).entries()) {
			if (action.kind !== "navigate" || !("conversation" in action.target)) {
				continue;
			}
			const target = action.target.conversation;
			if (!(await this.deps.visible(target, notice.user))) {
				throw new Error(
					`actions[${index}].target: conversation ${target} not visible to user "${notice.user}"`,
				);
			}
		}
		const posted = await this.storeFor(notice.user).post(owner, notice);
		return { id: posted.id };
	}

	/**
	 * The calling extension's own clear: by (user, key) or (user, id),
	 * always owner-scoped — another extension's notice is never touched.
	 */
	async clear(
		owner: string,
		selector: { user: string; key: string } | { user: string; id: string },
	): Promise<void> {
		const store = this.storeFor(selector.user);
		if ("key" in selector) {
			await store.clearByKey(owner, selector.key);
		} else {
			await store.clearById(owner, selector.id);
		}
	}

	/** The calling extension's own notices for `user` (owner-scoped read). */
	async listForExtension(
		owner: string,
		user: string,
	): Promise<readonly UserNotice[]> {
		const notices = await this.storeFor(user).list();
		return notices.filter((notice) => notice.owner === owner);
	}

	/**
	 * The user's own read (the GET route's source): every notice, minus
	 * any conversation notice whose conversation the user can no longer
	 * see — those are removed from the file on the same read (spec §3).
	 */
	async listForUser(user: string): Promise<readonly UserNotice[]> {
		const store = this.storeFor(user);
		const notices = await store.list();
		const lost: string[] = [];
		for (const notice of notices) {
			if (notice.conversationId === undefined) continue;
			if (!(await this.deps.visible(notice.conversationId, user))) {
				lost.push(notice.id);
			}
		}
		if (lost.length === 0) return notices;
		for (const id of lost) await store.dismiss(id);
		const lostSet = new Set(lost);
		return notices.filter((notice) => !lostSet.has(notice.id));
	}

	/** Dismiss one of the user's notices; `false` when absent. */
	async dismiss(user: string, id: string): Promise<boolean> {
		return await this.storeFor(user).dismiss(id);
	}

	/** Dismiss everything of the user's. */
	async dismissAll(user: string): Promise<void> {
		await this.storeFor(user).dismissAll();
	}

	/** Remove one conversation's notices for `user` (app-wide ones stay). */
	async clearConversationFor(
		user: string,
		conversationId: number,
	): Promise<void> {
		await this.storeFor(user).clearConversation(conversationId);
	}

	/**
	 * Run one notice's `extension` action (spec §4). The notice must
	 * belong to the principal's user (404 otherwise — a foreign id never
	 * reveals existence); the action must be a declared `extension`
	 * action on it (400); the handler must be loaded right now (409);
	 * per-principal rate limit (429). The handler runs under the 10 s
	 * action timeout; on `ok` the notice clears unless `keep: true`.
	 */
	async runAction(
		principal: Principal,
		id: string,
		actionId: string,
		requestId?: string,
	): Promise<NoticeActionAnswer> {
		const user = principal.user;
		if (user === undefined) {
			return { status: 404, body: { error: "notice_not_found" } };
		}
		const notice = await this.storeFor(user).get(id);
		if (notice === undefined) {
			return { status: 404, body: { error: "notice_not_found" } };
		}
		const action = notice.actions?.find(
			(entry): entry is Extract<UserNoticeAction, { kind: "extension" }> =>
				entry.id === actionId && entry.kind === "extension",
		);
		if (action === undefined) {
			return { status: 400, body: { error: "unknown_action" } };
		}
		if (!this.rateLimit.take("notices", notice.owner, user)) {
			return { status: 429, body: { error: "rate_limited" } };
		}
		const handler = this.deps.opened.noticeActionBindings.find(
			(binding) => binding.extension === notice.owner,
		)?.actions[action.name];
		if (handler === undefined) {
			return { status: 409, body: { error: "notice_action_unavailable" } };
		}
		const payload: JsonObject = action.payload ?? {};
		const fingerprint = JSON.stringify({
			notice: notice.id,
			action: actionId,
			payload,
		});
		const composite = `notice${notice.id}${actionId}`;
		if (requestId !== undefined) {
			const hit = this.dedup.check(requestId, composite, fingerprint);
			if (hit !== undefined && hit !== null) {
				// SAFETY: the dedup table is typed on the surface
				// `ActionResponse`, but this composite only ever stored the
				// notice answer (the cast below at `record`); the read is the
				// same shape that was written. Task 4 generalizes the table.
				return {
					status: 200,
					body: hit.result as unknown as NoticeActionResponse,
				};
			}
		}
		const controller = new AbortController();
		const result = await this.invokeWithTimeout(
			() =>
				handler(
					{ principal, notice, signal: controller.signal },
					payload,
				),
			controller,
		);
		if (result.ok && result.keep !== true) {
			await this.storeFor(user).dismiss(notice.id);
		}
		const body: NoticeActionResponse =
			result.ok === true
				? {
						ok: true,
						...(result.message === undefined ? {} : { message: result.message }),
						...(result.navigate === undefined
							? {}
							: { navigate: result.navigate }),
					}
				: result;
		if (requestId !== undefined) {
			// SAFETY: the dedup table types on the surface `ActionResponse`;
			// the notice body is the same {ok, ...} result shape (Task 4
			// generalizes the table).
			this.dedup.record(
				requestId,
				composite,
				fingerprint,
				body as unknown as ActionResponse,
			);
		}
		return { status: 200, body };
	}

	/**
	 * User deletion: evict the cached store (the file's removal is the
	 * users route's, Task 5 — `removeFile` stays available for it).
	 */
	async removeUser(user: string): Promise<void> {
		this.stores.delete(user);
	}

	/** Test seam: disable (or re-enable) the action rate limiter. */
	setRateLimitDisabled(disabled: boolean): void {
		this.rateLimit.setDisabled(disabled);
	}

	/** The handler names `owner` declared in its `noticeActions`. */
	private declaredHandlers(owner: string): ReadonlySet<string> {
		const binding = this.deps.opened.noticeActionBindings.find(
			(entry) => entry.extension === owner,
		);
		return new Set(Object.keys(binding?.actions ?? {}));
	}

	/** The cached per-user store, constructed on first use. */
	private storeFor(user: string): NoticeStore {
		const cached = this.stores.get(user);
		if (cached !== undefined) return cached;
		const store = new NoticeStore({
			userArea: this.deps.userArea(user),
			user,
			userCreatedAt: () =>
				this.deps.opened.identity.users.get(user)?.createdAt,
			now: this.deps.now,
			onChange: (change: NoticeChange) => {
				// The hub copy carries the user (NoticeChangedInternal); the
				// events route strips it before delivery (spec §4).
				const event: NoticeChangedInternal = {
					type: "notice.changed",
					user: change.user,
					ids: change.ids,
					change: change.change,
				};
				this.deps.publish(event);
			},
			log: this.deps.log,
		});
		this.stores.set(user, store);
		return store;
	}

	/**
	 * Race the handler against the 10 s action timeout (spec §4): on a
	 * timeout the handler is abandoned (its late settlement is dropped)
	 * and the action answers the `timed out` failure, the notice stays.
	 */
	private async invokeWithTimeout(
		invoke: () => Promise<UserNoticeActionResult>,
		controller: AbortController,
	): Promise<UserNoticeActionResult> {
		let timer: NodeJS.Timeout | undefined;
		try {
			const outcome = await Promise.race([
				invoke().then(
					(result): { kind: "done"; result: UserNoticeActionResult } => ({
						kind: "done",
						result,
					}),
					(cause: unknown): { kind: "threw"; cause: unknown } => ({
						kind: "threw",
						cause,
					}),
				),
				new Promise<{ kind: "timedout" }>((resolve) => {
					timer = setTimeout(
						() => resolve({ kind: "timedout" }),
						ACTION_TIMEOUT_MS,
					);
				}),
			]);
			if (outcome.kind === "timedout") {
				return { ok: false, error: { message: "timed out" } };
			}
			if (outcome.kind === "threw") {
				const cause = outcome.cause;
				return {
					ok: false,
					error: {
						message: cause instanceof Error ? cause.message : String(cause),
					},
				};
			}
			return outcome.result;
		} finally {
			if (timer !== undefined) clearTimeout(timer);
			controller.abort();
		}
	}
}
