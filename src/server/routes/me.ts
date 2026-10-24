/**
 * Multi-user M2 Task 2: self-service per-user extension stores.
 *
 * Every operation resolves from request.principal.user — never a query
 * parameter. There is no cross-user selector: an admin asking for
 * `?user=alice` still addresses the admin's own stores, so another user's
 * data is never returned. Secret values are accepted on PUT and read
 * in-process by extensions, but no HTTP route here ever returns one.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ServerContext } from "../context.js";
import type { UserExtensionStores } from "../../harness/stores.js";
import type { ExtensionSettingsResponse } from "./extensions.js";

/** Register the self-only settings/secrets routes. */
export function registerMeRoutes(
	app: FastifyInstance,
	ctx: ServerContext,
): void {
	const { opened } = ctx;

	/** Resolve the caller + slug before any store I/O. */
	const resolve = (
		request: FastifyRequest,
		reply: FastifyReply,
	): UserExtensionStores | undefined => {
		const user = request.principal.user;
		if (user === undefined || opened.identity.users.get(user) === undefined) {
			void reply.code(400).send({ error: "named_user_required" });
			return undefined;
		}
		const { slug } = request.params as { slug: string };
		if (!opened.extensionOutcomes.some((outcome) => outcome.name === slug)) {
			void reply.code(404).send({ error: "extension_not_found" });
			return undefined;
		}
		return opened.extensionStores.userExtensionStores(slug, user);
	};

	app.get("/v1/me/extensions/:slug/settings", async (request, reply) => {
		const stores = resolve(request, reply);
		if (stores === undefined) return reply;
		const response: ExtensionSettingsResponse = {
			settings: await stores.settings.get(),
			pendingRestart: [],
		};
		return response;
	});

	app.put("/v1/me/extensions/:slug/settings", async (request, reply) => {
		const stores = resolve(request, reply);
		if (stores === undefined) return reply;
		const body = request.body;
		if (typeof body !== "object" || body === null || Array.isArray(body)) {
			return await reply.code(400).send({ error: "invalid_body" });
		}
		const settings = body as Record<string, unknown>;
		await stores.settings.set(settings);
		const response: ExtensionSettingsResponse = { settings, pendingRestart: [] };
		return response;
	});

	app.get("/v1/me/extensions/:slug/secrets", async (request, reply) => {
		const stores = resolve(request, reply);
		if (stores === undefined) return reply;
		// This store method lists names only; values have no HTTP read surface.
		return { keys: await opened.extensionStores.userSecretKeys(
			(request.params as { slug: string }).slug,
			request.principal.user!,
		) };
	});

	app.put("/v1/me/extensions/:slug/secrets/:key", async (request, reply) => {
		const stores = resolve(request, reply);
		if (stores === undefined) return reply;
		const body = request.body;
		if (
			typeof body !== "object" ||
			body === null ||
			Array.isArray(body) ||
			typeof (body as Record<string, unknown>).value !== "string" ||
			(body as Record<string, unknown>).value === ""
		) {
			return await reply.code(400).send({ error: "invalid_field", field: "value" });
		}
		const { key } = request.params as { key: string };
		await stores.secrets.set(key, (body as { value: string }).value);
		return await reply.code(204).send();
	});

	app.delete("/v1/me/extensions/:slug/secrets/:key", async (request, reply) => {
		const stores = resolve(request, reply);
		if (stores === undefined) return reply;
		const { key } = request.params as { key: string };
		await stores.secrets.delete(key);
		return await reply.code(204).send();
	});
}
