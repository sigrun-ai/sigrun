/**
 * Test-fixture extension package (knowledge C7, Task 2): a published-hook
 * provider whose `run` never settles before the deadline (the timeout
 * branch — the test sets SIGRUN_PUBLISHED_HOOK_DEADLINE=50 and the run
 * hangs for 5 s, far past it).
 */

import { defineExtension } from "@earendil-works/pi-durable";
import { Type } from "typebox";

export default function createFixtureHookSlow() {
	return {
		extension: defineExtension({ name: "acme-slow-hooks" }),
		publishedHooks: [
			{
				name: "recall.echo",
				input: Type.Object({}),
				async run(_payload, call) {
					// The deadline aborts the linked signal; a provider that
					// ignores it keeps running unwatched (the accepted posture),
					// but a signal-honoring provider settles at the deadline.
					await new Promise((resolve, reject) => {
						const timer = setTimeout(resolve, 5000);
						call.abortSignal?.addEventListener("abort", () => {
							clearTimeout(timer);
							reject(new Error("aborted"));
						}, { once: true });
					});
					return { done: true };
				},
			},
		],
	};
}
