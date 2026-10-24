/**
 * The host bridge (core hardening W5 Task 5, spec §9.5/§9.7): the
 * in-process implementation behind every seam host's `conversations` /
 * `users` / `access` / `identity` surface. `createServer` builds ONE
 * bridge over its `ServerContext` and `OpenedHarness.bindHostBridge`
 * hands it to every seam host — so an extension driving conversations
 * in-process runs the SAME code paths the HTTP routes run
 * (src/server/conversation-ops.ts): content-part resolution, the
 * served-model check, activity stamping, and the durable listing are
 * identical by construction, never re-implemented.
 *
 * Posture (spec §9.5): extensions are TRUSTED IN-PROCESS code — they may
 * act for any user (no per-principal access gating on the bridge paths;
 * mapping a channel's users to sigrun users is the extension's own
 * config), and the bridge's `list` reads the directory the way a
 * superuser's HTTP list does: every row visible, `access: "write"`.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, ConversationId } from "@earendil-works/pi-durable";
import {
	accessOf as accessOfShared,
	type AccessPrincipal,
} from "@sigrun/shared/access";
import type { SigrunHost } from "../extension.js";
import type { DirectoryUser } from "../harness/identity/index.js";
import type { DataOps } from "@sigrun/shared/blocks";
import { isSuperuser, type Principal } from "./auth/principal.js";
import {
	abortOp,
	compactOp,
	configureOp,
	ConversationOpError,
	createConversationOp,
	forkOp,
	listConversationsOp,
	patchMetaOp,
	readFileOp,
	readMetaOp,
	submitOp,
	uploadOp,
} from "./conversation-ops.js";
import { listModels } from "./helpers.js";
import type { ServerContext } from "./context.js";
import { SessionMetaDoc } from "./session-meta.js";
import { accountLinkWire, serializeConversationView } from "./views.js";

/**
 * The effective-admin projection of one directory user (gateway C8):
 * host-side callers (chat commands, no request headers) see the STORED
 * flag OR the persisted group grant, plus the raw `groupAdmin` as a
 * definite boolean. The `/v1/users` wire keeps `admin` = the stored
 * flag (the users-admin UI toggles that one); the two surfaces are
 * deliberately different.
 */
function effectiveAdminOf(record: DirectoryUser): DirectoryUser {
	return {
		...record,
		admin: record.admin || record.groupAdmin === true,
		groupAdmin: record.groupAdmin === true,
	};
}

/**
 * The server-provided bridge a seam host delegates its
 * conversation/identity/users/access members to — exactly the
 * contract's member shapes (`SigrunHost["conversations"]` and friends),
 * so the seam host's re-exports and the bridge cannot drift.
 */
export interface HostBridge {
	readonly conversations: SigrunHost["conversations"];
	readonly users: SigrunHost["users"];
	readonly accounts: SigrunHost["accounts"];
	readonly access: SigrunHost["access"];
	readonly identity: SigrunHost["identity"];
	readonly models: SigrunHost["models"];
	readonly commands: SigrunHost["commands"];
	/**
	 * The surfaces seam's server side (UI-blocks U3 Task 4): the seam
	 * host's `surfaces.changed` delegates here — the slug is the
	 * CALLING extension's (the seam host knows it; the bridge takes it
	 * as an argument). Bumps the instance rev and publishes the
	 * `surface.changed` hub event through the service's one code path.
	 */
	readonly surfaces: {
		changed(
			slug: string,
			id: string,
			key: string,
			update?: DataOps,
		): void;
	};
}

/** Build the host bridge over one server context. */
export function createHostBridge(ctx: ServerContext): HostBridge {
	const { opened } = ctx;
	// The bridge's conversation resolution: an id no storage ever
	// recorded fails LOUD (the routes' 404 analog — the caller passed a
	// bad id, never a silent default).
	const conversationOf = async (id: ConversationId): Promise<Conversation> => {
		const conversation = await opened.harness.conversation(
			id,
			BACKGROUND_CONTEXT,
		);
		if (conversation === undefined) {
			throw new Error(`conversation ${id} not found`);
		}
		return conversation;
	};
	return {
		conversations: {
			async create(opts = {}) {
				const created = await createConversationOp(ctx, opts);
				// `ConversationCreateResponse.id` is the unbranded wire number;
				// the host hands back the branded id (the brand is nominal).
				return created.id as ConversationId;
			},
			async submit(id, input, opts) {
				const conversation = await conversationOf(id);
				// `user` is accepted and NOT verified: extensions own their
				// user mapping (spec §9.5) — a channel's unmapped user submits
				// fine, and owner attribution happened at create.
				return await submitOp(ctx, conversation, input, {
					...(opts?.requestId === undefined
						? {}
						: { requestId: opts.requestId }),
					...(opts?.whenBusy === undefined
						? {}
						: { whenBusy: opts.whenBusy }),
				});
			},
			async watch(id, listener) {
				const conversation = await conversationOf(id);
				// Snapshot-first (the SSE stream's shape, spec §7.3): the
				// acquisition revision is the first listener call, then every
				// watch revision after (pending frames flow because start
				// never invokes the listener inline).
				const watch = await conversation.watch(BACKGROUND_CONTEXT);
				listener(serializeConversationView(watch.value));
				watch.start((value) => {
					// An extension listener that throws (or returns a rejecting
					// promise — async listeners) must not end the watch or the
					// process — warn and keep delivering.
					return Promise.resolve()
						.then(() => listener(serializeConversationView(value)))
						.catch((cause: unknown) => {
							console.warn(
								`host bridge: watch listener failed: ${
									cause instanceof Error ? cause.message : String(cause)
								}`,
							);
						});
				});
				return async () => {
					await watch.stop();
				};
			},
			async list(opts = {}) {
				// The trusted read: extensions may act for any user, so the
				// bridge list sees every row (the superuser shape) — the
				// per-caller filtering is the HTTP route's own concern.
				return await listConversationsOp(ctx, { superuser: true }, {
					...(opts.owner === undefined ? {} : { owner: opts.owner }),
					...(opts.archived === undefined
						? {}
						: { archivedOnly: opts.archived }),
				});
			},
			async meta(id) {
				await conversationOf(id);
				return await readMetaOp(opened, id);
			},
			// Gateway C4a: the remaining conversation ops, each the SAME op
			// its HTTP route runs — resolved through conversationOf (unknown id
			// → the bridge's loud `conversation <id> not found`).
			async abort(id) {
				const conversation = await conversationOf(id);
				// `/stop` on an idle chat is not an error (the plan's ruling): the
				// op's 404 no_active_submission resolves instead — the HTTP route
				// keeps its exact 404.
				try {
					await abortOp(ctx, conversation);
				} catch (error) {
					if (
						error instanceof ConversationOpError &&
						error.status === 404 &&
						error.body.error === "no_active_submission"
					) {
						return;
					}
					throw error;
				}
			},
			async configure(id, opts = {}) {
				const conversation = await conversationOf(id);
				// Thin over the op (host inputs are typed — the op still
				// validates exactly like the route's body).
				await configureOp(ctx, conversation, {
					...(opts.model === undefined ? {} : { model: opts.model }),
					...(opts.thinking === undefined ? {} : { thinking: opts.thinking }),
				});
			},
			async compact(id) {
				const conversation = await conversationOf(id);
				await compactOp(ctx, conversation);
			},
			async fork(id, opts = {}) {
				const conversation = await conversationOf(id);
				const forked = await forkOp(ctx, conversation, {
					...(opts.at === undefined ? {} : { at: opts.at }),
					...(opts.owner === undefined ? {} : { owner: opts.owner }),
				});
				return forked.id as ConversationId;
			},
			async patchMeta(id, patch) {
				const conversation = await conversationOf(id);
				// No principal: host callers are trusted — the sharing gate is
				// the HTTP route's own concern (the plan's ruling).
				return await patchMetaOp(ctx, conversation, patch);
			},
			// Gateway C4b: the files routes' ops, each the SAME op its HTTP
			// route runs — the upload routes' shared write core and the
			// files/raw route's confinement + cap (the host sees the op's own
			// error vocabulary: invalid_field name / invalid_path / not_found /
			// too_large).
			async upload(id, file) {
				const conversation = await conversationOf(id);
				return await uploadOp(ctx, conversation, file);
			},
			async readFile(id, path) {
				const conversation = await conversationOf(id);
				return await readFileOp(ctx, conversation, path);
			},
		},
		users: {
			// The directory in wire form (emails are admin material; the
			// bridge is in-process server code, the same trust as the
			// admin-gated /v1/users routes) — with EFFECTIVE admin (gateway
			// C8): a persisted group grant counts for host-side checks.
			async list() {
				return opened.identity.users.list().map(effectiveAdminOf);
			},
			async get(user) {
				const record = opened.identity.users.get(user);
				return record === undefined ? undefined : effectiveAdminOf(record);
			},
		},
		accounts: {
			// The one link table (multi-user §11.3): core code over core's
			// store — the single write path, with the store's own validation
			// and conflict refusal. `account_link_conflict:` errors cross the
			// bridge as plain Errors (extensions match the message prefix).
			async lookup(provider, subject) {
				const link = opened.identity.accounts.lookup(provider, subject);
				return link === undefined ? undefined : accountLinkWire(link);
			},
			async link(provider, subject, user, via) {
				const link = await opened.identity.accounts.link({
					provider,
					subject,
					user,
					via,
				});
				return accountLinkWire(link);
			},
			async unlink(provider, subject) {
				return await opened.identity.accounts.unlink(provider, subject);
			},
			async listForUser(user) {
				return opened.identity.accounts.listForUser(user).map(accountLinkWire);
			},
		},
		access: {
			async accessOf(principal, resource) {
				// A full Principal maps through the SAME superuser rule the
				// server's routes use (naive-loopback or service — a
				// directory admin is not a superuser for accessOf); the bare
				// `{user}` shape is the shared rule's own principal.
				const resolved: AccessPrincipal =
					"admin" in principal
						? {
								user: principal.user,
								superuser: isSuperuser(principal as Principal),
							}
						: { user: principal.user };
				return accessOfShared(resolved, resource);
			},
		},
		identity: {
			// The conversation's owner — who the agent acts for (§9.7).
			async actingUser(conversationId) {
				const meta = await opened.harness.snapshot(
					SessionMetaDoc,
					conversationId,
					BACKGROUND_CONTEXT,
				);
				return meta?.owner;
			},
		},
		// Gateway C4b: the model catalog — the SAME source function the
		// `GET /v1/models` route serves (one construction, never two).
		models: {
			async list() {
				return listModels(opened);
			},
		},
		commands: {
			// The merged catalog rows (`GET /v1/commands`' core + extension
			// half — the live skill/template expand entries are the composer's
			// per-request concern, not this surface's).
			async list() {
				return ctx.commandCatalog.commands;
			},
			// The invoke route's resolution, in-process: the runnable map
			// (core names and dropped/collided losers throw), the principal
			// built from the directory with EFFECTIVE admin and method "host",
			// and the extension's seam host exactly as the route passes it. A
			// throwing run PROPAGATES (the HTTP route maps 500 command_failed;
			// the host caller owns its own handling).
			async run(conversationId, name, args, opts) {
				const merged = ctx.commandCatalog.runnable.get(name);
				if (merged === undefined) {
					throw new Error(`command_not_found: ${name}`);
				}
				const record = opened.identity.users.get(opts.user);
				if (record === undefined) {
					throw new Error(`unknown user "${opts.user}"`);
				}
				// Effective admin (gateway C8): the stored flag OR the persisted
				// group grant — host-side code has no request headers to
				// recompute one.
				const principal: Principal = {
					user: record.user,
					...(record.name === undefined ? {} : { name: record.name }),
					...(record.email === undefined ? {} : { email: record.email }),
					admin: effectiveAdminOf(record).admin,
					service: false,
					method: "host",
				};
				const host = ctx.opened.seamHosts.get(merged.extension) as
					| SigrunHost
					| undefined;
				const result = await merged.run({
					conversationId,
					args,
					principal,
					host: host as SigrunHost,
				});
			return result === undefined || result.notice === undefined
				? {}
				: { notice: result.notice };
		},
	},
	surfaces: {
		// UI-blocks U3 Task 4 (spec §7.3): the same bumpRev the actions
		// route takes — the rev advance and the hub event are one step.
		changed(slug, id, key, update) {
			ctx.surfaces.bumpRev(slug, id, key, update);
		},
	},
};
}
