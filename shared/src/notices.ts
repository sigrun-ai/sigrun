/**
 * The per-user notice wire types (notices spec §1/§3) — THE notices
 * channel contract.
 *
 * Part of the shared leaf package (`@sigrun/shared`): the server owns the
 * runtime half (`src/notices/*` — validation, store, service) and both
 * clients (webui, tui) import these types directly. Like every wire
 * module, imports are TYPE-ONLY from sibling shared modules (the
 * views-purity guard enforces this); the two `RegExp` constants and the
 * limits table are local pure values.
 *
 * A notice is a short message aimed at ONE directory user: a title, an
 * optional line of body text, and up to three buttons. It is deliberately
 * not a block tree (every client renders it the same way) and it is never
 * conversation state — that is what ambient records are for. The `User*`
 * prefix keeps these shapes apart from `host.notify`'s
 * `ExtensionNoticeInput`, which delivers to external channels instead.
 */

import type { CoreTarget, IconName, Tone } from "./blocks/index.js";
import type { JsonObject } from "./json.js";

/**
 * The notice bounds (spec §1 fields, §3 caps): the input limits the
 * validator enforces, and the per-user store caps that bound the pile.
 */
export const NOTICE_LIMITS = {
	/** Max title characters (one line). */
	title: 200,
	/** Max body characters (plain text, shown under the title). */
	body: 1000,
	/** Max actions per notice. */
	actions: 3,
	/** Max action label characters. */
	label: 40,
	/** Max extension-action payload, as canonical JSON bytes. */
	payloadBytes: 4096,
	/** Max extension-action confirm characters. */
	confirm: 200,
	/** Max `open` URL characters (https only). */
	url: 2048,
	/** Max notices one extension may hold per user. */
	perExtension: 10,
	/** Max notices a user may hold in total. */
	perUser: 50,
} as const;

/**
 * The extension-scoped replace key grammar (spec §1): posting an existing
 * (extension, user, key) replaces that notice.
 */
export const NOTICE_KEY_RE = /^[a-z0-9._:-]{1,128}$/;

/** The per-notice action id grammar (spec §1); ids are unique per notice. */
export const NOTICE_ACTION_ID_RE = /^[a-z0-9-]{1,32}$/;

/**
 * One notice button. `navigate` moves the client to a core target, `open`
 * opens an https link (and then dismisses), and `extension` runs a
 * handler the posting extension declared (and clears the notice unless
 * the handler asks to keep it).
 */
export type UserNoticeAction = {
	readonly id: string;
	readonly label: string;
	readonly icon?: IconName;
} & (
	| { readonly kind: "navigate"; readonly target: CoreTarget }
	| { readonly kind: "open"; readonly url: string }
	| {
			readonly kind: "extension";
			readonly name: string;
			/** Extension-owned payload, read by the handler; visible to the client, so never a secret. */
			readonly payload?: JsonObject;
			/** Confirmation the client shows before running the handler. */
			readonly confirm?: string;
	  }
);

/** What an extension posts: one recipient, the content, at most three actions. */
export interface UserNoticeInput {
	/** The one recipient (a directory user). */
	readonly user: string;
	/** Present → a conversation notice; absent → an app-wide notice. */
	readonly conversationId?: number;
	/** Extension-scoped replace key; posting the same key replaces the notice. */
	readonly key?: string;
	readonly title: string;
	readonly body?: string;
	readonly tone?: Tone;
	readonly actions?: readonly UserNoticeAction[];
}

/** A stored notice as the wire carries it (core assigns the three extras). */
export interface UserNotice extends UserNoticeInput {
	/** Core-assigned random UUID; a keyed replace mints a new one. */
	readonly id: string;
	/** The posting extension slug. */
	readonly owner: string;
	/** ISO timestamp, set on post. */
	readonly at: string;
}

/** The `GET /v1/notices` payload: the caller's notices, newest first. */
export interface NoticesResponse {
	readonly notices: readonly UserNotice[];
}

/** The `POST /v1/notices/{id}/actions/{actionId}` answer (spec §4). */
export type NoticeActionResponse =
	| {
			readonly ok: true;
			readonly message?: string;
			readonly navigate?: CoreTarget;
	  }
	| { readonly ok: false; readonly error: { readonly message: string } };
