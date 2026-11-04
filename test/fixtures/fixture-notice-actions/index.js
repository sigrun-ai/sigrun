/**
 * Test-fixture extension package (notices Task 3): a factory result
 * carrying a valid `noticeActions` record. `ping` records its invocation
 * module-side (the fixture-memory pattern: the loader and the test import
 * the SAME file:// URL, one module instance) and answers ok; `hold`
 * answers `{ok: true, keep: true}`. Task 4 adds `fail` (a deliberate
 * ok:false — the error-return shape) and `slow` (settles after ~200 ms,
 * past the test rig's injected 50 ms timeout — the abandoned-handler
 * shape).
 */

import { defineExtension } from "@earendil-works/pi-durable";

/** Every `ping` invocation: `{user, payload, noticeId}`, in order. */
export const calls = [];

/** Clear the records (tests own their fixtures' state). */
export function resetCalls() {
	calls.length = 0;
}

export default function createFixtureNoticeActions() {
	return {
		extension: defineExtension({ name: "acme-notes" }),
		noticeActions: {
			async ping(ctx, payload) {
				calls.push({
					user: ctx.principal.user,
					payload,
					noticeId: ctx.notice.id,
				});
				return { ok: true, message: "pong" };
			},
			async hold() {
				return { ok: true, keep: true };
			},
			async fail() {
				return { ok: false, error: { message: "deliberate failure" } };
			},
			async slow() {
				await new Promise((resolve) => setTimeout(resolve, 200));
				return { ok: true };
			},
		},
	};
}
