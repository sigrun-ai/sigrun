/**
 * The hub-internal notice.changed event (notices spec §4): the wire shape
 * PLUS the recipient `user`, attached at publish time (the store's
 * `NoticeChange` always names its user). The events route reads `user`
 * and strips it before delivery — the wire shape carries no user, and a
 * notice event never crosses to another principal's stream.
 */

/** The hub copy of one `notice.changed` event (wire + routing user). */
export interface NoticeChangedInternal {
	readonly type: "notice.changed";
	/** The user whose notice set changed (routing metadata, never wire). */
	readonly user: string;
	readonly ids: readonly string[];
	readonly change: "posted" | "cleared";
}
