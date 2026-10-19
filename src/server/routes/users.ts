/**
 * The users + invites routes (core hardening W1 Task 4, spec §5.8): the
 * admin-gated directory surface — list, patch (with the last-record-admin
 * guard: group-derived admins never count, Authelia can revoke them at
 * any moment), delete-with-transfer (ownership rewrite → token revocation
 * → record removal → the `userDeleted` lifecycle event), and invite
 * issuance.
 *
 * The admin gate reads `request.principal.admin` — record admin, service
 * token, the naive loopback superuser, or a proxy-group grant. The
 * last-admin GUARDS read the directory records only (`recordAdminCount`).
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FastifyInstance } from "fastify";
import type { ServerContext } from "../context.js";
import { withClaimLock } from "../auth/claim-lock.js";
import type { DirectoryUser } from "../../harness/identity/index.js";
import { transferOwnership } from "../ownership.js";
import type { InviteResponse, UserWire } from "../views.js";

/** The wire form of one directory user (the record minus nothing — the
 * routes serving it are admin-gated, and emails are admin material). */
function userWire(record: DirectoryUser): UserWire {
	return {
		user: record.user,
		...(record.name === undefined ? {} : { name: record.name }),
		...(record.email === undefined ? {} : { email: record.email }),
		admin: record.admin,
		createdAt: record.createdAt,
		source: record.source,
	};
}

/** Register the users + invites routes. */
export function registerUserRoutes(
	app: FastifyInstance,
	ctx: ServerContext,
): void {
	const { identity, eventBus } = ctx.opened;

	app.get("/v1/users", async (request, reply) => {
		if (!request.principal.admin) {
			return await reply.code(403).send({ error: "forbidden" });
		}
		return { users: identity.users.list().map(userWire) };
	});

	app.patch("/v1/users/:user", async (request, reply) => {
		if (!request.principal.admin) {
			return await reply.code(403).send({ error: "forbidden" });
		}
		const { user } = request.params as { user: string };
		const target = identity.users.get(user);
		if (target === undefined) {
			return await reply.code(404).send({ error: "unknown_user" });
		}
		const body = request.body;
		if (
			typeof body !== "object" ||
			body === null ||
			Array.isArray(body)
		) {
			return await reply.code(400).send({ error: "invalid_body" });
		}
		const patch: { name?: string; email?: string; admin?: boolean } = {};
		for (const key of Object.keys(body as Record<string, unknown>)) {
			const value = (body as Record<string, unknown>)[key];
			switch (key) {
				case "name":
				case "email":
					// Absent = unchanged (clearing is not patch surface v1 —
					// null is a wrong type, not a clear operator, here).
					if (typeof value !== "string") {
						return await reply.code(400).send({ error: "invalid_body" });
					}
					patch[key] = value;
					break;
				case "admin":
					if (typeof value !== "boolean") {
						return await reply.code(400).send({ error: "invalid_body" });
					}
					patch.admin = value;
					break;
				default:
					return await reply
						.code(400)
						.send({ error: "invalid_field", field: key });
			}
		}
		if (Object.keys(patch).length === 0) {
			return await reply.code(400).send({ error: "invalid_body" });
		}
		// The last record-admin may not demote themselves — the directory
		// would hold no admin at all (group admins never count).
		if (
			patch.admin === false &&
			target.admin &&
			identity.users.recordAdminCount() === 1
		) {
			return await reply.code(409).send({ error: "last_admin" });
		}
		const updated = await identity.users.update(user, {
			...(patch.name === undefined ? {} : { name: patch.name }),
			...(patch.email === undefined ? {} : { email: patch.email }),
			...(patch.admin === undefined ? {} : { admin: patch.admin }),
		});
		return userWire(updated);
	});

	app.post("/v1/users/invites", async (request, reply) => {
		if (!request.principal.admin) {
			return await reply.code(403).send({ error: "forbidden" });
		}
		const body = request.body;
		if (
			typeof body !== "object" ||
			body === null ||
			Array.isArray(body)
		) {
			return await reply.code(400).send({ error: "invalid_body" });
		}
		const admin =
			(body as Record<string, unknown>).admin === undefined
				? false
				: (body as Record<string, unknown>).admin;
		if (typeof admin !== "boolean") {
			return await reply.code(400).send({ error: "invalid_body" });
		}
		const expiresInMsRaw = (body as Record<string, unknown>).expiresInMs;
		let expiresInMs: number | undefined;
		if (expiresInMsRaw !== undefined) {
			if (
				typeof expiresInMsRaw !== "number" ||
				!Number.isFinite(expiresInMsRaw) ||
				expiresInMsRaw <= 0
			) {
				return await reply.code(400).send({ error: "invalid_body" });
			}
			expiresInMs = expiresInMsRaw;
		}
		for (const key of Object.keys(body as Record<string, unknown>)) {
			if (key !== "admin" && key !== "expiresInMs") {
				return await reply
					.code(400)
					.send({ error: "invalid_field", field: key });
			}
		}
		// Issuance rides the claim lock too: an invite minted while a claim
		// is mid-flight cannot interleave with the redemption path's
		// read-decide-write.
		const invite = await withClaimLock(() =>
			identity.invites.create({ admin, ...(expiresInMs === undefined ? {} : { expiresInMs }) }),
		);
		const response: InviteResponse = {
			id: invite.id,
			code: invite.code,
			expiresAt: invite.expiresAt,
		};
		return await reply.code(201).send(response);
	});

	app.delete("/v1/users/:user", async (request, reply) => {
		if (!request.principal.admin) {
			return await reply.code(403).send({ error: "forbidden" });
		}
		const { user } = request.params as { user: string };
		const target = identity.users.get(user);
		if (target === undefined) {
			return await reply.code(404).send({ error: "unknown_user" });
		}
		// transferTo is required and must name ANOTHER directory user.
		const query = request.query as { transferTo?: string };
		if (
			query.transferTo === undefined ||
			query.transferTo === "" ||
			query.transferTo === user ||
			identity.users.get(query.transferTo) === undefined
		) {
			return await reply.code(400).send({ error: "invalid_transfer" });
		}
		// The last record-admin may not be deleted — admin is not a
		// transferable property (transferTo moves resources, not rights).
		if (target.admin && identity.users.recordAdminCount() === 1) {
			return await reply.code(409).send({ error: "last_admin" });
		}
		const to = query.transferTo;
		await transferOwnership(ctx, user, to);
		await identity.tokens.revokeAllFor(user);
		await identity.users.remove(user);
		// The lifecycle event: extensions transfer their own records
		// (deadlocked-ordering free — the core transfer already landed).
		await eventBus.emitUserDeleted({ user, transferTo: to }, BACKGROUND_CONTEXT);
		return await reply.code(204).send();
	});
}
