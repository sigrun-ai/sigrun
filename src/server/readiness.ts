/**
 * The shared readiness storage check (core-hardening Task 5): the ONE
 * derivation behind BOTH `GET /readyz`'s storage verdict and `/metrics`'s
 * `sigrun_ready` gauge, so the k8s probe and the alerting signal cannot
 * disagree.
 *
 * The check is the exact read `/readyz` has always done (W2 §6.1,
 * storage-only readiness): resolve the reserved root conversation
 * through the session line (`storage.conversation()` under
 * `harness.conversation`) — one real sqlite record fetch proving the db
 * file + session answer right now. A closed harness throws here
 * (assertOpen) — caught, reported as "failed"; `undefined` (record gone)
 * likewise fails — not a harness anyone should route traffic to.
 *
 * Core-hardening's finding: `sigrun_up` reflects `harness.inspect()`,
 * which can stay healthy while this read fails — then `/readyz`
 * answered 503 but the `/metrics` scrape stayed green and nothing
 * paged. The gauge answers the same call this function makes.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ServerContext } from "./context.js";

/**
 * The readiness storage check: `"ok"` when the root conversation
 * resolves through the session line, `"failed"` otherwise (thrown or
 * absent — either way, not a harness to route traffic to). Never throws.
 */
export async function checkStorage(
	ctx: ServerContext,
): Promise<"ok" | "failed"> {
	try {
		const conversation = await ctx.opened.harness.conversation(
			ctx.rootId,
			BACKGROUND_CONTEXT,
		);
		// undefined = storage answered but the root record is gone — not a
		// harness anyone should route traffic to.
		return conversation === undefined ? "failed" : "ok";
	} catch {
		return "failed";
	}
}
