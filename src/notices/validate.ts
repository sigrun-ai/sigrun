/**
 * Notice input validation (notices spec §1): shape, the `NOTICE_LIMITS`
 * bounds, the key and action-id grammars, https-only `open`, duplicate
 * action ids, and — on the post path only — that every `extension`
 * action names a handler the posting extension declared.
 *
 * Two entry points, because a STORED notice outlives its extension:
 * `validateNoticeShape` is what the store re-validates a loaded entry
 * with (spec §3: a notice whose extension is disabled or unloaded stays
 * dismissible), while `validateNoticeInput` adds the declared-handler
 * gate a fresh post must pass. Both rebuild the accepted input from the
 * validated fields only, so an unknown key — including a stored
 * `id`/`owner`/`at`, which are the store's own checks — never rides into
 * the record.
 *
 * Every rejection names the offending field (`actions[0].url`); the
 * caller renders `<field>: <message>`, the spec's fail-loud posture.
 * Access checks (does the user exist, can they see the conversation)
 * belong to the service, not here.
 */

import { ICON_NAMES, canonicalJson } from "@sigrun/shared/blocks";
import type {
	CoreTarget,
	IconName,
	JsonObject,
	JsonValue,
	Tone,
} from "@sigrun/shared/blocks";
import {
	NOTICE_ACTION_ID_RE,
	NOTICE_KEY_RE,
	NOTICE_LIMITS,
	type UserNoticeAction,
	type UserNoticeInput,
} from "@sigrun/shared/notices";

/** The validator's answer: the rebuilt input, or the first offending field. */
export type NoticeValidation =
	| { ok: true; value: UserNoticeInput }
	| { ok: false; field: string; message: string };

/** A rejection: the offending field path and why (the caller renders both). */
interface NoticeRejection {
	ok: false;
	field: string;
	message: string;
}

/**
 * Every `Tone` member as a runtime set. The `Record<Tone, true>` annotation
 * is the drift guard: a member added to the blocks union without a line
 * here fails the typecheck rather than being rejected at post time.
 */
const TONES: ReadonlySet<string> = new Set(
	Object.keys({
		neutral: true,
		accent: true,
		good: true,
		warn: true,
		bad: true,
		info: true,
	} satisfies Record<Tone, true>),
);

/** The closed icon set (the block contract's own names). */
const ICONS: ReadonlySet<string> = new Set(ICON_NAMES);

/** The three action kinds (spec §1). */
const ACTION_KINDS = ["navigate", "open", "extension"] as const;

/** The core targets a `navigate` action may name (the blocks `CoreTarget`). */
const TARGET_KEYS = ["conversation", "job", "settings", "view"] as const;

/**
 * Validate a notice's shape, bounds and grammars — no handler check.
 * Used on load (a stored entry) and as the first half of the post path.
 */
export function validateNoticeShape(input: unknown): NoticeValidation {
	if (!isRecord(input)) {
		return invalid("notice", "a notice must be an object");
	}

	const user = input.user;
	if (typeof user !== "string" || user === "") {
		return invalid("user", "must be a non-empty string");
	}

	const title = input.title;
	if (typeof title !== "string" || title === "") {
		return invalid("title", "must be a non-empty string");
	}
	if (title.length > NOTICE_LIMITS.title) {
		return invalid("title", `longer than ${NOTICE_LIMITS.title} characters`);
	}

	const conversationId = input.conversationId;
	if (conversationId !== undefined) {
		if (typeof conversationId !== "number" || !Number.isInteger(conversationId)) {
			return invalid("conversationId", "must be an integer");
		}
	}

	const key = input.key;
	if (key !== undefined) {
		if (typeof key !== "string" || !NOTICE_KEY_RE.test(key)) {
			return invalid("key", `must match ${NOTICE_KEY_RE.source}`);
		}
	}

	const body = input.body;
	if (body !== undefined) {
		if (typeof body !== "string") {
			return invalid("body", "must be a string");
		}
		if (body.length > NOTICE_LIMITS.body) {
			return invalid("body", `longer than ${NOTICE_LIMITS.body} characters`);
		}
	}

	const tone = input.tone;
	if (tone !== undefined && !isTone(tone)) {
		return invalid("tone", `must be one of ${[...TONES].join("|")}`);
	}

	const actions = validateActions(input.actions);
	if (!actions.ok) return actions;

	return {
		ok: true,
		value: {
			user,
			title,
			...(conversationId === undefined ? {} : { conversationId }),
			...(key === undefined ? {} : { key }),
			...(body === undefined ? {} : { body }),
			...(tone === undefined ? {} : { tone }),
			...(actions.value === undefined ? {} : { actions: actions.value }),
		},
	};
}

/**
 * `validateNoticeShape` plus the declared-handler gate: every `extension`
 * action must name a handler the posting extension declared (the loader's
 * `noticeActions` keys). Used on post only — a stored notice survives its
 * extension being unloaded, so load re-validation never calls this.
 */
export function validateNoticeInput(
	input: unknown,
	declaredHandlers: ReadonlySet<string>,
): NoticeValidation {
	const shape = validateNoticeShape(input);
	if (!shape.ok) return shape;
	for (const [index, action] of (shape.value.actions ?? []).entries()) {
		if (action.kind !== "extension") continue;
		if (!declaredHandlers.has(action.name)) {
			return invalid(
				`actions[${index}].name`,
				`no declared handler named ${JSON.stringify(action.name)}`,
			);
		}
	}
	return shape;
}

/**
 * The action list: the count bound, then each action's own shape (the
 * duplicate-id check rides on the id pass, so the first offending action
 * wins). Undefined = the notice carries no actions.
 */
function validateActions(
	input: unknown,
): { ok: true; value?: readonly UserNoticeAction[] } | NoticeRejection {
	if (input === undefined) return { ok: true };
	if (!Array.isArray(input)) {
		return invalid("actions", "must be an array");
	}
	if (input.length > NOTICE_LIMITS.actions) {
		return invalid("actions", `more than ${NOTICE_LIMITS.actions} actions`);
	}
	const actions: UserNoticeAction[] = [];
	const ids = new Set<string>();
	for (let index = 0; index < input.length; index += 1) {
		const action = validateAction(input[index], `actions[${index}]`);
		if (!action.ok) return action;
		if (ids.has(action.value.id)) {
			return invalid(
				`actions[${index}].id`,
				`duplicate action id ${JSON.stringify(action.value.id)}`,
			);
		}
		ids.add(action.value.id);
		actions.push(action.value);
	}
	return { ok: true, value: actions };
}

/** One action: the shared id/label/icon, then its kind's own fields. */
function validateAction(
	input: unknown,
	field: string,
): { ok: true; value: UserNoticeAction } | NoticeRejection {
	if (!isRecord(input)) {
		return invalid(field, "must be an object");
	}

	const id = input.id;
	if (typeof id !== "string" || !NOTICE_ACTION_ID_RE.test(id)) {
		return invalid(`${field}.id`, `must match ${NOTICE_ACTION_ID_RE.source}`);
	}

	const label = input.label;
	if (typeof label !== "string" || label === "") {
		return invalid(`${field}.label`, "must be a non-empty string");
	}
	if (label.length > NOTICE_LIMITS.label) {
		return invalid(
			`${field}.label`,
			`longer than ${NOTICE_LIMITS.label} characters`,
		);
	}

	const icon = input.icon;
	if (icon !== undefined && !isIconName(icon)) {
		return invalid(`${field}.icon`, "must be a known icon name");
	}
	const base = { id, label, ...(icon === undefined ? {} : { icon }) };

	const kind = input.kind;
	if (!ACTION_KINDS.some((known) => known === kind)) {
		return invalid(`${field}.kind`, `must be one of ${ACTION_KINDS.join("|")}`);
	}

	if (kind === "navigate") {
		const target = validateTarget(input.target, `${field}.target`);
		if (!target.ok) return target;
		return { ok: true, value: { ...base, kind, target: target.value } };
	}

	if (kind === "open") {
		const url = input.url;
		if (typeof url !== "string" || !url.startsWith("https://")) {
			return invalid(`${field}.url`, "must be an https URL");
		}
		if (url.length > NOTICE_LIMITS.url) {
			return invalid(`${field}.url`, `longer than ${NOTICE_LIMITS.url} characters`);
		}
		return { ok: true, value: { ...base, kind, url } };
	}

	const name = input.name;
	if (typeof name !== "string" || name === "") {
		return invalid(`${field}.name`, "must be a non-empty string");
	}

	const payload = input.payload;
	if (payload !== undefined) {
		if (!isJsonObject(payload)) {
			return invalid(`${field}.payload`, "must be a JSON object");
		}
		// The bound is canonical JSON bytes (spec §1): key order never
		// changes whether a payload fits.
		if (Buffer.byteLength(canonicalJson(payload), "utf8") > NOTICE_LIMITS.payloadBytes) {
			return invalid(
				`${field}.payload`,
				`larger than ${NOTICE_LIMITS.payloadBytes} bytes`,
			);
		}
	}

	const confirm = input.confirm;
	if (confirm !== undefined) {
		if (typeof confirm !== "string") {
			return invalid(`${field}.confirm`, "must be a string");
		}
		if (confirm.length > NOTICE_LIMITS.confirm) {
			return invalid(
				`${field}.confirm`,
				`longer than ${NOTICE_LIMITS.confirm} characters`,
			);
		}
	}

	return {
		ok: true,
		value: {
			...base,
			kind: "extension",
			name,
			...(payload === undefined ? {} : { payload }),
			...(confirm === undefined ? {} : { confirm }),
		},
	};
}

/**
 * A `navigate` target: exactly ONE core key, its value shaped as the
 * blocks `CoreTarget` member declares it (a view target carries the
 * extension slug, the view id and optional params).
 */
function validateTarget(
	input: unknown,
	field: string,
): { ok: true; value: CoreTarget } | NoticeRejection {
	if (!isRecord(input)) {
		return invalid(field, "must be a CoreTarget object");
	}
	const present = TARGET_KEYS.filter((key) => input[key] !== undefined);
	if (present.length !== 1) {
		return invalid(field, `must carry exactly one of ${TARGET_KEYS.join("|")}`);
	}
	const key = present[0] as (typeof TARGET_KEYS)[number];
	const raw = input[key];

	if (key === "conversation") {
		if (typeof raw !== "number" || !Number.isInteger(raw)) {
			return invalid(`${field}.conversation`, "must be an integer");
		}
		return { ok: true, value: { conversation: raw } };
	}
	if (key === "job") {
		if (typeof raw !== "string" || raw === "") {
			return invalid(`${field}.job`, "must be a non-empty string");
		}
		return { ok: true, value: { job: raw } };
	}
	if (key === "settings") {
		if (typeof raw !== "string" || raw === "") {
			return invalid(`${field}.settings`, "must be a non-empty string");
		}
		return { ok: true, value: { settings: raw } };
	}

	if (!isRecord(raw)) {
		return invalid(`${field}.view`, "must be an object");
	}
	const extension = raw.extension;
	const id = raw.id;
	if (typeof extension !== "string" || extension === "") {
		return invalid(`${field}.view.extension`, "must be a non-empty string");
	}
	if (typeof id !== "string" || id === "") {
		return invalid(`${field}.view.id`, "must be a non-empty string");
	}
	const params = raw.params;
	if (params !== undefined && !isJsonObject(params)) {
		return invalid(`${field}.view.params`, "must be a JSON object");
	}
	return {
		ok: true,
		value: {
			view: { extension, id, ...(params === undefined ? {} : { params }) },
		},
	};
}

function invalid(field: string, message: string): NoticeRejection {
	return { ok: false, field, message };
}

/** A plain record (arrays and null excluded). */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A member of the blocks `Tone` union. */
function isTone(value: unknown): value is Tone {
	return typeof value === "string" && TONES.has(value);
}

/** A member of the block contract's closed icon set. */
function isIconName(value: unknown): value is IconName {
	return typeof value === "string" && ICONS.has(value);
}

/** A structurally valid JSON object (a `JsonObject`, never an array). */
function isJsonObject(value: unknown): value is JsonObject {
	return isRecord(value) && Object.values(value).every(isJsonValue);
}

/** A structurally valid JSON value. */
function isJsonValue(value: unknown): value is JsonValue {
	if (value === null) return true;
	const type = typeof value;
	if (type === "string" || type === "boolean") return true;
	if (type === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJsonValue);
	return isRecord(value) && Object.values(value).every(isJsonValue);
}
