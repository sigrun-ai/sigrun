/**
 * The users + invites routes (core hardening W1 Task 4, spec §5.8): the
 * admin-gated directory surface — list, patch (with the last-record-admin
 * guard: group-derived admins never count, Authelia can revoke them at
 * any moment), delete-with-transfer (ownership rewrite → token revocation
 * → account-link removal → stop services → the `userDeleted` lifecycle
 * event → record removal, per spec §10.6), and invite issuance.
 *
 * The admin gate reads `request.principal.admin` — record admin, service
 * token, the naive loopback superuser, or a proxy-group grant. The
 * last-admin GUARDS read the directory records only (`recordAdminCount`).
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FastifyInstance } from "fastify";
import { join } from "node:path";
import type { ServerContext } from "../context.js";
import { withClaimLock } from "../auth/claim-lock.js";
import type { DirectoryUser } from "../../harness/identity/index.js";
import { effectiveAdmin, storedGroups } from "../../harness/identity/groups.js";
import { transferOwnership } from "../ownership.js";
import type { InviteResponse, UserWire } from "../views.js";
import type { Grant } from "../../sandbox/grants.js";
import { validateGrantPath } from "../../sandbox/grants.js";

/** The wire form of one directory user. `admin` stays the STORED flag;
 * `groupAdmin` is DERIVED from stored groups and retained for one release
 * so the users UI keeps rendering. */
export function userWire(
	record: DirectoryUser,
	adminGroups: readonly string[],
): UserWire {
	const effective = effectiveAdmin(record, adminGroups);
	return {
		user: record.user,
		...(record.name === undefined ? {} : { name: record.name }),
		...(record.email === undefined ? {} : { email: record.email }),
		admin: record.admin,
		groupAdmin: effective && !record.admin,
		groups: storedGroups(record),
		...(record.workspace === undefined ? {} : { workspace: record.workspace }),
		...(record.grants === undefined ? {} : { grants: record.grants }),
		...(record.osUser === undefined ? {} : { osUser: record.osUser }),
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
		return { users: identity.users.list().map((record) => userWire(record, ctx.config.auth.adminGroups)) };
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
		const patch: {
			name?: string;
			email?: string;
			admin?: boolean;
			workspace?: string;
			grants?: readonly Grant[];
			osUser?: string;
		} = {};
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
				case "workspace": {
					if (typeof value !== "string") {
						return await reply.code(400).send({ error: "invalid_body" });
					}
					const result = validateGrantPath(value, {
						managed: ctx.managedPaths,
						user,
					});
					if (!result.ok) {
						return await reply.code(400).send({
							error: "invalid_grant",
							path: value,
							reason: result.reason,
						});
					}
					patch.workspace = result.realpath;
					break;
				}
				case "grants": {
					if (!Array.isArray(value)) {
						return await reply.code(400).send({ error: "invalid_body" });
					}
					const grants: Grant[] = [];
					for (const entry of value as unknown[]) {
						if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
							return await reply.code(400).send({ error: "invalid_body" });
						}
						const candidate = entry as Record<string, unknown>;
						if (
							typeof candidate.path !== "string" ||
							(candidate.access !== "ro" && candidate.access !== "rw") ||
							Object.keys(candidate).some((key) => key !== "path" && key !== "access")
						) {
							return await reply.code(400).send({ error: "invalid_body" });
						}
						const result = validateGrantPath(candidate.path, {
							managed: ctx.managedPaths,
							user,
						});
						if (!result.ok) {
							return await reply.code(400).send({
								error: "invalid_grant",
								path: candidate.path,
								reason: result.reason,
							});
						}
						grants.push({ path: result.realpath, access: candidate.access });
					}
					patch.grants = grants;
					break;
				}
				case "osUser":
					if (typeof value !== "string" || value === "") {
						return await reply.code(400).send({ error: "invalid_body" });
					}
					patch.osUser = value;
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
		const updated = await identity.users.update(user, patch);
		return userWire(updated, ctx.config.auth.adminGroups);
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
		if (target.osUser !== undefined) {
			return await reply.code(409).send({
				error: "invalid_transfer",
				reason: "osUser workspace",
			});
		}
		// The last record-admin may not be deleted — admin is not a
		// transferable property (transferTo moves resources, not rights).
		if (target.admin && identity.users.recordAdminCount() === 1) {
			return await reply.code(409).send({ error: "last_admin" });
		}
		const to = query.transferTo;
		const workspace =
			target.workspace ??
			join(ctx.managedPaths.roots.dataDir, "users", user, "workspace");
		// Complete the only grant-dependent failure decision BEFORE the
		// irreversible transfer/revocation. Invalid grants remain non-fatal.
		const validatedGrant = validateGrantPath(workspace, {
			managed: ctx.managedPaths,
			user: to,
			inheritedFrom: user,
		});
		const grant: Grant | undefined = validatedGrant.ok
			? {
					path: validatedGrant.realpath,
					access: "rw",
					inheritedFrom: user,
				}
			: undefined;
		if (!validatedGrant.ok) {
			console.warn(
				`user delete: skipping departing workspace grant for ${to}: ${workspace}: ${validatedGrant.reason}`,
			);
		}
		await transferOwnership(ctx, user, to);
		await identity.tokens.revokeAllFor(user);
		// External identities never transfer (multi-user §10.6 step 1):
		// credentials belong to a person, and a transferred link would hand
		// the receiving user's account to whoever holds that chat identity.
		await identity.accounts.removeUser(user);
		// §10.6 step 2: stop credential-bearing sibling processes and
		// uninstall every *@user entry while the directory record exists.
		await ctx.opened.userServices.stopUser(user);
		ctx.opened.userTools.removeUser(user);
		// §10.6 step 3: provider credentials remain readable throughout the
		// fan-out. Always release the deletion marker before record removal.
		await eventBus.emitUserDeleted({ user, transferTo: to }, BACKGROUND_CONTEXT);
		if (grant === undefined) await identity.users.remove(user);
		else await identity.users.removeWithGrant(user, to, grant);
		// §10.6 step 5: data/state stay for the recipient; core owns only
		// the departing user's credentials, settings, and every cache slug.
		await ctx.opened.extensionStores.removeUserData(user);
		return await reply.code(204).send();
	});
}
