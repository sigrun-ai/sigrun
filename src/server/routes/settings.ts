/**
 * Settings routes over the file-backed store on the harness's live
 * settings (pi parity): GET serves the current effective settings
 * (absent file = `{}` — every default) plus the pending-restart diff
 * (U4 §13.2); PATCH validates + merges + persists through the store's
 * `apply()` — the write classifies live vs. restart against the §13.1
 * registry, reports both, and publishes `settings.changed` after the
 * write commits.
 */

import type { FastifyInstance } from "fastify";
import { SettingsValidationError } from "../../harness/settings.js";
import { pendingRestart as diffPendingRestart } from "../../settings/pending.js";
import type { ServerContext } from "../context.js";
import { settingsResponse } from "../helpers.js";
import type { SettingsResponse } from "../views.js";

/** Register `GET`/`PATCH /v1/settings`. */
export function registerSettingsRoutes(
	app: FastifyInstance,
	ctx: ServerContext,
): void {
	const { opened, config, env } = ctx;

	// PATCH semantics: the harness picks a change up on the next resolution
	// (steeringMode on the next submission's admission, because
	// pi-durable re-reads `HarnessSettings` per boundary). Errors follow
	// the repo's PATCH conventions: 400 `invalid_field` naming the key
	// (unknown key, wrong type), 400 `invalid_body` for a non-object.
	app.get("/v1/settings", async (): Promise<SettingsResponse> => {
		return settingsResponse(opened, config, env);
	});

	app.patch("/v1/settings", async (request, reply): Promise<SettingsResponse> => {
		// Admin-only (spec §5.6): PATCH edits `extensions[]`, which is code
		// execution at the next boot — a non-admin (any authenticated
		// token-method user, a non-admin proxy user) gets 403 before the
		// body is even read. GET stays ungated (spec lists only PATCH).
		if (!request.principal.admin) {
			return await reply.code(403).send({ error: "forbidden" });
		}
		const body = request.body as Record<string, unknown> | undefined;
		if (
			body === undefined ||
			body === null ||
			typeof body !== "object" ||
			Array.isArray(body)
		) {
			return await reply.code(400).send({ error: "invalid_body" });
		}
		try {
			const outcome = opened.settings.apply(body);
			// §13.2: the store's onWrite observer (boot's settings-changed
			// sink) published `settings.changed` when the write committed —
			// hub publication, extension onSettingsChanged fan-out, and the
			// scheduler re-arm all ride that ONE seam, so the route only
			// reports the write's own classification here. Observer errors
			// never fail the write (§13.2's caught-and-logged rule).
			return settingsResponse(opened, config, env, {
				applied: outcome.applied,
				pending: outcome.pending,
			});
		} catch (error) {
			if (error instanceof SettingsValidationError) {
				return await reply
					.code(400)
					.send({ error: "invalid_field", field: error.field });
			}
			throw error;
		}
	});
}

/**
 * The applied/pending extras a PATCH response carries over GET (the
 * write's own classification, spec §13.2/§13.1).
 */
interface SettingsWriteExtras {
	readonly applied: readonly string[];
	readonly pending: readonly string[];
}
