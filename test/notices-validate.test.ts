/**
 * Task 1 (notices spec §1): the shared limits/regexes and the two input
 * validators — `validateNoticeShape` (shape, bounds, grammars, https-only
 * `open`, duplicate action ids) and `validateNoticeInput` (the same plus
 * the declared-handler gate the post path adds).
 *
 * Every bound is exercised twice: at its limit (accepted) and one past it
 * (rejected with the field named). The literals are pinned once against
 * `NOTICE_LIMITS`, so the table and the validator can never drift from
 * the spec.
 */

import { describe, expect, test } from "vitest";
import {
	NOTICE_ACTION_ID_RE,
	NOTICE_KEY_RE,
	NOTICE_LIMITS,
} from "@sigrun/shared/notices";
import {
	validateNoticeInput,
	validateNoticeShape,
	type NoticeValidation,
} from "../src/notices/validate.js";

/** The posting extension's declared handler names (the loader's contract). */
const DECLARED: ReadonlySet<string> = new Set(["undoReview"]);

/** A minimal valid notice; a test overrides the one field it exercises. */
function notice(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { user: "alice", title: "Learned: prefer pnpm", ...overrides };
}

/** A 2048-character https URL (the `url` bound is its own length rule). */
const HTTPS_URL = `https://example.invalid/${"a".repeat(2024)}`;

/** The rejection, asserting the validator did not accept the input. */
function rejection(result: NoticeValidation): { field: string; message: string } {
	if (result.ok) throw new Error("expected the notice to be rejected");
	return { field: result.field, message: result.message };
}

/** The accepted input, asserting the validator did not reject it. */
function accepted(result: NoticeValidation): Record<string, unknown> {
	if (!result.ok) {
		throw new Error(`expected acceptance, got ${result.field}: ${result.message}`);
	}
	return result.value as unknown as Record<string, unknown>;
}

describe("the shared limits and grammars", () => {
	test("NOTICE_LIMITS carries the spec's exact bounds", () => {
		expect(NOTICE_LIMITS).toEqual({
			title: 200,
			body: 1000,
			actions: 3,
			label: 40,
			payloadBytes: 4096,
			confirm: 200,
			url: 2048,
			perExtension: 10,
			perUser: 50,
		});
	});

	test("the key and action-id grammars are the spec's", () => {
		expect(NOTICE_KEY_RE.source).toBe("^[a-z0-9._:-]{1,128}$");
		expect(NOTICE_ACTION_ID_RE.source).toBe("^[a-z0-9-]{1,32}$");
	});
});

describe("validateNoticeShape", () => {
	test("accepts a minimal notice and keeps only the declared fields", () => {
		const value = accepted(
			validateNoticeShape({
				...notice(),
				// Never trusted: `id`/`owner`/`at` are the store's own fields.
				id: "0b7c2f9a-0000-4000-8000-000000000000",
				owner: "acme-notes",
				at: "2026-11-03T12:00:00.000Z",
			}),
		);
		expect(value).toEqual({ user: "alice", title: "Learned: prefer pnpm" });
	});

	test("accepts every bound at its limit", () => {
		const payload = { note: "x".repeat(4085) };
		expect(JSON.stringify(payload)).toHaveLength(NOTICE_LIMITS.payloadBytes);

		const value = accepted(
			validateNoticeShape(
				notice({
					conversationId: 7,
					key: "review:1",
					title: "t".repeat(NOTICE_LIMITS.title),
					body: "b".repeat(NOTICE_LIMITS.body),
					tone: "info",
					actions: [
						{
							id: "undo",
							label: "l".repeat(NOTICE_LIMITS.label),
							icon: "refresh",
							kind: "extension",
							name: "undoReview",
							payload,
							confirm: "c".repeat(NOTICE_LIMITS.confirm),
						},
						{ id: "review", label: "Review", kind: "navigate", target: { job: "digest" } },
						{ id: "docs", label: "Docs", kind: "open", url: HTTPS_URL },
					],
				}),
			),
		);
		expect(value.actions).toHaveLength(NOTICE_LIMITS.actions);
		expect((value.actions as unknown[])[2]).toEqual({
			id: "docs",
			label: "Docs",
			kind: "open",
			url: HTTPS_URL,
		});
	});

	test("rejects a title one character past its bound", () => {
		const { field, message } = rejection(
			validateNoticeShape(notice({ title: "t".repeat(NOTICE_LIMITS.title + 1) })),
		);
		expect(field).toBe("title");
		expect(message).toBe(`longer than ${NOTICE_LIMITS.title} characters`);
	});

	test("rejects a body one character past its bound", () => {
		const { field, message } = rejection(
			validateNoticeShape(notice({ body: "b".repeat(NOTICE_LIMITS.body + 1) })),
		);
		expect(field).toBe("body");
		expect(message).toBe(`longer than ${NOTICE_LIMITS.body} characters`);
	});

	test("rejects a fourth action", () => {
		const open = (id: string): Record<string, unknown> => ({
			id,
			label: "Docs",
			kind: "open",
			url: "https://example.invalid/docs",
		});
		const { field, message } = rejection(
			validateNoticeShape(
				notice({ actions: [open("a"), open("b"), open("c"), open("d")] }),
			),
		);
		expect(field).toBe("actions");
		expect(message).toBe(`more than ${NOTICE_LIMITS.actions} actions`);
	});

	test("rejects an action label one character past its bound", () => {
		const { field, message } = rejection(
			validateNoticeShape(
				notice({
					actions: [
						{
							id: "undo",
							label: "l".repeat(NOTICE_LIMITS.label + 1),
							kind: "extension",
							name: "undoReview",
						},
					],
				}),
			),
		);
		expect(field).toBe("actions[0].label");
		expect(message).toBe(`longer than ${NOTICE_LIMITS.label} characters`);
	});

	test("rejects a payload one byte past its bound", () => {
		const payload = { note: "x".repeat(4086) };
		expect(JSON.stringify(payload)).toHaveLength(NOTICE_LIMITS.payloadBytes + 1);
		const { field, message } = rejection(
			validateNoticeShape(
				notice({
					actions: [
						{
							id: "undo",
							label: "Undo",
							kind: "extension",
							name: "undoReview",
							payload,
						},
					],
				}),
			),
		);
		expect(field).toBe("actions[0].payload");
		expect(message).toBe(`larger than ${NOTICE_LIMITS.payloadBytes} bytes`);
	});

	test("rejects a confirm one character past its bound", () => {
		const { field, message } = rejection(
			validateNoticeShape(
				notice({
					actions: [
						{
							id: "undo",
							label: "Undo",
							kind: "extension",
							name: "undoReview",
							confirm: "c".repeat(NOTICE_LIMITS.confirm + 1),
						},
					],
				}),
			),
		);
		expect(field).toBe("actions[0].confirm");
		expect(message).toBe(`longer than ${NOTICE_LIMITS.confirm} characters`);
	});

	test("rejects a url one character past its bound", () => {
		const { field, message } = rejection(
			validateNoticeShape(
				notice({
					actions: [
						{ id: "docs", label: "Docs", kind: "open", url: `${HTTPS_URL}a` },
					],
				}),
			),
		);
		expect(field).toBe("actions[0].url");
		expect(message).toBe(`longer than ${NOTICE_LIMITS.url} characters`);
	});

	test("rejects an http:// open action", () => {
		const { field, message } = rejection(
			validateNoticeShape(
				notice({
					actions: [
						{
							id: "docs",
							label: "Docs",
							kind: "open",
							url: "http://example.invalid/docs",
						},
					],
				}),
			),
		);
		expect(field).toBe("actions[0].url");
		expect(message).toBe("must be an https URL");
	});

	test("rejects a key with an uppercase letter", () => {
		expect(rejection(validateNoticeShape(notice({ key: "Review:1" }))).field).toBe(
			"key",
		);
	});

	test("rejects a key one character past its bound", () => {
		expect(rejection(validateNoticeShape(notice({ key: "a".repeat(129) }))).field).toBe(
			"key",
		);
	});

	test("rejects an action id with an uppercase letter", () => {
		const { field, message } = rejection(
			validateNoticeShape(
				notice({
					actions: [
						{ id: "Undo", label: "Undo", kind: "open", url: HTTPS_URL },
					],
				}),
			),
		);
		expect(field).toBe("actions[0].id");
		expect(message).toBe(`must match ${NOTICE_ACTION_ID_RE.source}`);
	});

	test("rejects an action id one character past its bound", () => {
		expect(
			rejection(
				validateNoticeShape(
					notice({
						actions: [
							{ id: "a".repeat(33), label: "Docs", kind: "open", url: HTTPS_URL },
						],
					}),
				),
			).field,
		).toBe("actions[0].id");
	});

	test("rejects duplicate action ids, naming the later one", () => {
		const { field, message } = rejection(
			validateNoticeShape(
				notice({
					actions: [
						{ id: "undo", label: "Undo", kind: "extension", name: "undoReview" },
						{ id: "undo", label: "Undo again", kind: "open", url: HTTPS_URL },
					],
				}),
			),
		);
		expect(field).toBe("actions[1].id");
		expect(message).toBe('duplicate action id "undo"');
	});

	test("rejects a tone outside the blocks Tone union", () => {
		const { field, message } = rejection(
			validateNoticeShape(notice({ tone: "cheerful" })),
		);
		expect(field).toBe("tone");
		expect(message).toBe("must be one of neutral|accent|good|warn|bad|info");
	});

	test("rejects an unknown action kind", () => {
		expect(
			rejection(
				validateNoticeShape(
					notice({ actions: [{ id: "go", label: "Go", kind: "launch" }] }),
				),
			).field,
		).toBe("actions[0].kind");
	});

	test("rejects an icon outside the closed set", () => {
		expect(
			rejection(
				validateNoticeShape(
					notice({
						actions: [
							{
								id: "undo",
								label: "Undo",
								icon: "sparkles",
								kind: "extension",
								name: "undoReview",
							},
						],
					}),
				),
			).field,
		).toBe("actions[0].icon");
	});

	test("rejects a navigate target that names two core keys", () => {
		expect(
			rejection(
				validateNoticeShape(
					notice({
						actions: [
							{
								id: "go",
								label: "Go",
								kind: "navigate",
								target: { conversation: 7, job: "digest" },
							},
						],
					}),
				),
			).field,
		).toBe("actions[0].target");
	});

	test("accepts every CoreTarget member", () => {
		const targets = [
			{ conversation: 7 },
			{ job: "digest" },
			{ settings: "notices" },
			{ view: { extension: "acme-notes", id: "review", params: { id: 3 } } },
		];
		for (const [index, target] of targets.entries()) {
			const value = accepted(
				validateNoticeShape(
					notice({
						actions: [
							{ id: `go-${index}`, label: "Go", kind: "navigate", target },
						],
					}),
				),
			);
			expect((value.actions as unknown[])[0]).toEqual({
				id: `go-${index}`,
				label: "Go",
				kind: "navigate",
				target,
			});
		}
	});

	test("rejects a non-object input", () => {
		expect(rejection(validateNoticeShape("Learned: prefer pnpm")).field).toBe("notice");
	});

	test("rejects a notice without a user", () => {
		expect(rejection(validateNoticeShape({ title: "Learned" })).field).toBe("user");
	});

	test("rejects a notice without a title", () => {
		expect(rejection(validateNoticeShape({ user: "alice" })).field).toBe("title");
	});

	test("rejects a non-integer conversationId", () => {
		expect(
			rejection(validateNoticeShape(notice({ conversationId: "7" }))).field,
		).toBe("conversationId");
	});
});

describe("validateNoticeInput", () => {
	test("accepts an extension action naming a declared handler", () => {
		const value = accepted(
			validateNoticeInput(
				notice({
					actions: [
						{
							id: "undo",
							label: "Undo",
							kind: "extension",
							name: "undoReview",
							payload: { reviewId: "r-1" },
							confirm: "Undo every change this review made?",
						},
					],
				}),
				DECLARED,
			),
		);
		expect((value.actions as unknown[])[0]).toEqual({
			id: "undo",
			label: "Undo",
			kind: "extension",
			name: "undoReview",
			payload: { reviewId: "r-1" },
			confirm: "Undo every change this review made?",
		});
	});

	test("rejects an extension action naming an undeclared handler", () => {
		const { field, message } = rejection(
			validateNoticeInput(
				notice({
					actions: [{ id: "undo", label: "Undo", kind: "extension", name: "undo" }],
				}),
				DECLARED,
			),
		);
		expect(field).toBe("actions[0].name");
		expect(message).toBe('no declared handler named "undo"');
	});

	test("skips the handler gate for navigate and open actions", () => {
		const value = accepted(
			validateNoticeInput(
				notice({
					actions: [
						{ id: "docs", label: "Docs", kind: "open", url: HTTPS_URL },
						{ id: "go", label: "Go", kind: "navigate", target: { conversation: 7 } },
					],
				}),
				new Set(),
			),
		);
		expect(value.actions).toHaveLength(2);
	});

	test("reports the shape rejection before the handler gate", () => {
		expect(
			rejection(
				validateNoticeInput(
					notice({ title: "t".repeat(NOTICE_LIMITS.title + 1) }),
					DECLARED,
				),
			).field,
		).toBe("title");
	});

	test("the shape check alone accepts a notice whose extension is unloaded", () => {
		// Spec §3: a stored notice whose posting extension is disabled stays
		// dismissible, so load re-validation must not consult handlers.
		const input = notice({
			actions: [{ id: "undo", label: "Undo", kind: "extension", name: "undoReview" }],
		});
		expect(validateNoticeShape(input).ok).toBe(true);
		expect(validateNoticeInput(input, new Set()).ok).toBe(false);
	});
});
