/**
 * Settings routes over the file-backed store on the harness's live
 * settings (pi parity): GET serves the current effective settings
 * (absent file = `{}` — every default); PATCH validates + merges +
 * persists through the store.
 */

import type { FastifyInstance } from "fastify";
import { SettingsValidationError } from "../../harness/settings.js";
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
			opened.settings.update(body);
			return settingsResponse(opened, config, env);
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
