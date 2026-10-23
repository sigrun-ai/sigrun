/**
 * The host context (spec: docs/approval-ux-seams.md, "What this asks of
 * core"): the object sigrun hands an extension factory so the extension can
 * use the interaction/ambient seams — and its scoped extension-stores
 * handle (`stores`: secrets/settings get/set on its own section/file plus
 * its own raw data/cache/state paths) — without importing anything from
 * core.
 *
 * Factories run BEFORE `Harness.open` (spec §3 boot order), so the context
 * binds the harness lazily: boot assigns `bindHarness` right after open,
 * and every seam call awaits that assignment. A seam call that arrives
 * before the harness exists waits — never a silent drop.
 *
 * Failure posture: every method throws `SeamError` on misuse (bad record,
 * unowned key, unknown kind) — fail-loud, matching the loader's quarantine
 * posture for shape violations. A throw inside a factory quarantines the
 * extension; a throw later (tool execute) surfaces to the caller.
 */

import type { Context } from "@earendil-works/chord";
import type { ConversationId, Harness } from "@earendil-works/pi-durable";
import type { HostBridge } from "../server/host-bridge.js";
import type { SigrunHost } from "../extension.js";
import {
	AmbientDoc,
	AmbientOwnersDoc,
	validateAmbient,
	type AmbientBody,
	type AmbientPlace,
	type AmbientRecord,
} from "./ambient.js";
import {
	InteractionDoc,
	InteractionsIndexDoc,
	applyAnswer,
	indexPending,
	indexSettled,
	validateInteraction,
	type InteractionAnswer,
	type InteractionRecord,
} from "./interactions.js";
import {
	scopedExtensionStores,
	type ExtensionStores,
	type SharedExtensionStores,
} from "./stores.js";

/** One seam violation. Name carries the surface ("interaction"/"ambient"). */
export class SeamError extends Error {
	constructor(
		readonly surface: "interaction" | "ambient",
		message: string,
	) {
		super(`${surface}: ${message}`);
		this.name = "SeamError";
	}
}

/** How the host context identifies the calling extension (owner/creator). */
export interface HostIdentity {
	/** The pi-durable extension name (`sigrun.warden`, …). */
	readonly name: string;
}

/** Kinds an extension declared for each seam (validated at load). */
export interface DeclaredKinds {
	readonly interaction?: readonly string[];
	readonly ambient?: readonly string[];
}

/** The seam surface handed to extension factories. */
export interface SeamHost {
	/**
	 * The scoped extension-stores handle (spec §5): secrets/settings
	 * get/set on THIS extension's section/file (server-mediated, no
	 * paths) plus this slug's raw data/cache/state directories. Rebuilt
	 * by `rekey` when identity changes — always keyed on the CURRENT
	 * slug. Cheap at construction; the cache dir is created lazily on
	 * first `paths.cache` access, never at boot.
	 */
	readonly stores: ExtensionStores;
	/**
	 * Boot-owned two-phase re-key (the loader calls the host factory once
	 * with the PROVISIONAL identity before the extension name/kinds are
	 * known — the slug derived from the load specifier, `""` when nothing
	 * derives — then again after the factory result resolves, handing the
	 * same instance back): mutates identity,
	 * kind sets, AND the scoped stores view IN PLACE so the object the
	 * extension factory captured IS the final host — a second instance
	 * would orphan every inbound handler the factory registered on its
	 * captured host (review M2). Extensions never call this; it is not
	 * part of the extension-facing surface.
	 */
	rekey(identity: HostIdentity, kinds: DeclaredKinds): void;
	/**
	 * Seed (or fully replace) one interaction record. The callId must be
	 * pending-or-absent; seeding an already-terminal record is a no-op
	 * (first-write wins, crash-idempotent).
	 */
	seedInteraction(
		conversationId: ConversationId,
		record: InteractionRecord,
		context: Context,
	): Promise<void>;
	/**
	 * Answer a pending interaction from the extension side. `opts.user`
	 * (gateway C5) stamps the answer HUMAN and names the user — who
	 * answered matters to every participant a conversation is shared
	 * with; access checks stay the caller's job (the host is trusted
	 * in-process code). Without it the extension answered itself.
	 */
	answerInteraction(
		conversationId: ConversationId,
		callId: string,
		answer: InteractionAnswer,
		context: Context,
		opts?: { readonly user?: string },
	): Promise<boolean>;
	/** Mark a pending interaction expired/cancelled/skipped (extension-owned semantics). */
	settleInteraction(
		conversationId: ConversationId,
		callId: string,
		status: "skipped" | "expired" | "cancelled",
		context: Context,
	): Promise<boolean>;
	/** Read one interaction record (the poll loop's read). */
	snapshotInteraction(
		conversationId: ConversationId,
		callId: string,
		context: Context,
	): Promise<Readonly<InteractionRecord> | undefined>;
	/**
	 * Fully replace one ambient surface's state (write = replacement). The
	 * key must be unowned or owned by THIS extension; a body-less write
	 * clears the surface. Owner registration happens on first write.
	 */
	setAmbient(
		conversationId: ConversationId,
		record: {
			readonly key: string;
			readonly place: AmbientPlace;
			readonly maxRows?: number;
			readonly overflow?: "drop" | "wrap" | "summarize";
			readonly refreshMs?: number;
			readonly body?: AmbientBody;
			readonly details?: import("@earendil-works/pi-durable").JsonObject;
		},
		context: Context,
	): Promise<void>;
	/** Clear one ambient surface (empty replacement; keeps ownership). */
	clearAmbient(
		conversationId: ConversationId,
		key: string,
		context: Context,
	): Promise<void>;
	/**
	 * Drive conversations in-process over the SAME code paths the HTTP
	 * routes run (spec §9.5): create/submit/watch/list/meta. Extensions
	 * are trusted in-process code — they may act for any user, and
	 * mapping a channel's users to sigrun users is the extension's own
	 * config. Binds lazily (the harness promise + the server-provided
	 * bridge): a call before the boot completes and the server exists
	 * WAITS, exactly like the seam methods above.
	 */
	readonly conversations: SigrunHost["conversations"];
	/** The user directory (§9.7): list/get in admin wire form. */
	readonly users: SigrunHost["users"];
	/** Resolve one principal's access to one shared resource (§9.7). */
	readonly access: SigrunHost["access"];
	/** The conversation's owner — who the agent acts for (§9.7). */
	readonly identity: SigrunHost["identity"];
	/** The served model catalog (gateway C4b): `GET /v1/models`' list. */
	readonly models: SigrunHost["models"];
	/** The slash-command surface (gateway C4b): catalog + in-process run. */
	readonly commands: SigrunHost["commands"];
	/**
	 * Bind the server-provided host bridge (W5 Task 5): `createServer`
	 * calls `OpenedHarness.bindHostBridge` once its `ServerContext`
	 * exists, which sets the ONE bridge on every seam host — the
	 * `conversations`/`users`/`access`/`identity` members above then run
	 * the server's shared conversation ops. Extensions never call this;
	 * it is not part of the extension-facing surface.
	 */
	bindBridge(bridge: HostBridge): void;
}

/**
 * Build the seam host for one extension. `kinds` gates writes: a record
 * whose `kind`/`key` the extension never declared is rejected — the
 * declaration is what channels use to inventory capabilities, so an
 * undeclared write would silently falsify it. `sharedStores` is the
 * boot-built store trio (one per boot, from the resolved roots); the
 * host scopes it to its identity's slug — `rekey` re-scopes in place.
 */
export function createSeamHost(
	identity: HostIdentity,
	kinds: DeclaredKinds,
	bind: {
		/** Assign the opened harness; boot calls this right after `Harness.open`. */
		readonly bindHarness: (harness: Harness) => void;
		/** Resolve the harness or wait for it (bounded by the caller's context). */
		readonly harness: () => Promise<Harness>;
	},
	sharedStores: SharedExtensionStores,
): SeamHost {
	const interactionKinds = new Set(kinds.interaction ?? []);
	const ambientKinds = new Set(kinds.ambient ?? []);
	// The scoped stores view, keyed on the CURRENT identity — the same
	// closed-over `let` pattern as `identity` itself: rekey re-points it
	// and the `stores` getter below reads through the closure, so the
	// factory-captured host object re-scopes IN PLACE (never a second
	// host, never a stale view).
	let stores = scopedExtensionStores(sharedStores, identity.name);

	async function harness(context: Context): Promise<Harness> {
		const h = await bind.harness();
		// The caller's context gates the wait: an aborted request/tool call
		// unwinds instead of waiting forever for a harness that never opens.
		context.abortSignal?.throwIfAborted();
		return h;
	}

	// The server-provided host bridge (W5 Task 5): the conversation/
	// identity/users/access surface binds LATER than the harness — the
	// bridge only exists once `createServer` builds it — so the same
	// lazy-promise discipline applies: every call awaits the harness
	// assignment AND the bridge assignment, so a factory-body call waits
	// (never a silent drop, never an early resolution before the server
	// exists), and a call after the binding resolves immediately.
	let bridgeReleased!: (bridge: HostBridge) => void;
	const bridgePromise = new Promise<HostBridge>((resolve) => {
		bridgeReleased = resolve;
	});
	const hostBridge = async (): Promise<HostBridge> => {
		await bind.harness();
		return bridgePromise;
	};

	return {
		get stores() {
			return stores;
		},

		rekey(nextIdentity, nextKinds) {
			// In place, by design: the factory already captured THIS object, so
			// the reassign below is visible to every closure reading it and no
			// second host instance ever exists. The stores view re-points to the
			// rekeyed slug the same way — same host object, corrected scope.
			identity = nextIdentity;
			stores = scopedExtensionStores(sharedStores, nextIdentity.name);
			interactionKinds.clear();
			for (const kind of nextKinds.interaction ?? []) interactionKinds.add(kind);
			ambientKinds.clear();
			for (const kind of nextKinds.ambient ?? []) ambientKinds.add(kind);
		},

		async seedInteraction(conversationId, record, context) {
			if (!interactionKinds.has(record.kind)) {
				throw new SeamError(
					"interaction",
					`kind ${JSON.stringify(record.kind)} is not declared by ${identity.name} (declare it in the factory result's interactionKinds)`,
				);
			}
			const problem = validateInteraction(record);
			if (problem !== null) throw new SeamError("interaction", problem);
			const h = await harness(context);
			await h.commit(async (tx) => {
				// Maintain the index in the SAME commit as the record.
				const existing = await tx.doc(
					InteractionDoc,
					conversationId,
					record.callId,
					record.callId,
				);
				if (existing.status !== "pending") return; // first-write wins
				Object.assign(existing, record);
				const index = await tx.doc(InteractionsIndexDoc);
				indexPending(index, conversationId, record.callId);
			}, context);
		},

		async answerInteraction(conversationId, callId, answer, context, opts) {
			const h = await harness(context);
			return await h.commit(async (tx) => {
				const draft = await tx.doc(
					InteractionDoc,
					conversationId,
					callId,
					callId,
				);
				if (draft.status !== "pending") return false;
				// Gateway C5: a host caller naming a user answers AS that human
				// (the route's path — the same applyAnswer line); without a user
				// the extension answered itself.
				const applied = applyAnswer(
					draft,
					answer,
					opts?.user === undefined ? "extension" : "human",
					Date.now(),
					opts?.user,
				);
				if (applied) {
					const index = await tx.doc(InteractionsIndexDoc);
					indexSettled(index, conversationId, callId);
				}
				return applied;
			}, context);
		},

		async settleInteraction(conversationId, callId, status, context) {
			const h = await harness(context);
			return await h.commit(async (tx) => {
				const draft = await tx.doc(
					InteractionDoc,
					conversationId,
					callId,
					callId,
				);
				if (draft.status !== "pending") return false;
				const mutable = draft as unknown as Record<string, unknown>;
				mutable.status = status;
				mutable.settledAt = Date.now();
				const index = await tx.doc(InteractionsIndexDoc);
				indexSettled(index, conversationId, callId);
				return true;
			}, context);
		},

		async snapshotInteraction(conversationId, callId, context) {
			const h = await harness(context);
			return await h.snapshot(
				InteractionDoc,
				conversationId,
				callId,
				context,
			);
		},

		async setAmbient(conversationId, record, context) {
			if (!ambientKinds.has(record.key)) {
				throw new SeamError(
					"ambient",
					`surface key ${JSON.stringify(record.key)} is not declared by ${identity.name} (declare it in the factory result's ambientKinds)`,
				);
			}
			const h = await harness(context);
			await h.commit(async (tx) => {
				// Allocation: one owner per key. The claim happens in the same
				// commit as the first write, so a race between two extensions
				// serializes and the loser throws.
				const owners = await tx.doc(AmbientOwnersDoc);
				const owner = owners.owners[record.key];
				if (owner === undefined) {
					const claimed = owners.owners as unknown as Record<string, string>;
					claimed[record.key] = identity.name;
				} else if (owner !== identity.name) {
					throw new SeamError(
						"ambient",
						`key ${JSON.stringify(record.key)} is owned by ${owner}; ${identity.name} cannot write it`,
					);
				}
				const draft = await tx.doc(
					AmbientDoc,
					conversationId,
					record.key,
					record.key,
				);
				const full: AmbientRecord = {
					...record,
					owner: identity.name,
					expires: record.body === undefined ? draft.expires : "never",
					updatedAt: Date.now(),
				};
				const problem = validateAmbient(full);
				if (problem !== null) throw new SeamError("ambient", problem);
				Object.assign(draft, full);
			}, context);
		},

		async clearAmbient(conversationId, key, context) {
			if (!ambientKinds.has(key)) {
				throw new SeamError(
					"ambient",
					`surface key ${JSON.stringify(key)} is not declared by ${identity.name}`,
				);
			}
			const h = await harness(context);
			await h.commit(async (tx) => {
				const draft = await tx.doc(AmbientDoc, conversationId, key, key);
				// Empty replacement: body undefined, everything else refreshed.
				const mutable = draft as unknown as Record<string, unknown>;
				mutable.updatedAt = Date.now();
				mutable.body = undefined;
				mutable.details = undefined;
			}, context);
		},

		// The host conversation/identity/users/access surface (W5 Task 5,
		// spec §9.5/§9.7): each member awaits the harness + bridge bindings
		// (the lazy discipline above) and delegates to the server bridge —
		// the SAME code paths the HTTP routes run. `create` injects the
		// source default: the CALLING extension's slug (identity.name — the
		// re-keyed current slug, read at call time).
		conversations: {
			async create(opts = {}) {
				const bridge = await hostBridge();
				return bridge.conversations.create({
					...(opts.owner === undefined ? {} : { owner: opts.owner }),
					...(opts.sharing === undefined ? {} : { sharing: opts.sharing }),
					...(opts.name === undefined ? {} : { name: opts.name }),
					...(opts.agent === undefined ? {} : { agent: opts.agent }),
					// The source default: the CALLING extension's slug (spec §9.5).
					source: opts.source ?? identity.name,
				});
			},
			async submit(id, input, opts) {
				const bridge = await hostBridge();
				return bridge.conversations.submit(id, input, opts);
			},
			async watch(id, listener) {
				const bridge = await hostBridge();
				return bridge.conversations.watch(id, listener);
			},
			async list(opts) {
				const bridge = await hostBridge();
				return bridge.conversations.list(opts);
			},
			async meta(id) {
				const bridge = await hostBridge();
				return bridge.conversations.meta(id);
			},
			// The C4a ops: straight delegation (the bridge resolves the id and
			// runs the op its HTTP twin runs).
			async abort(id) {
				return (await hostBridge()).conversations.abort(id);
			},
			async configure(id, opts) {
				return (await hostBridge()).conversations.configure(id, opts);
			},
			async compact(id) {
				return (await hostBridge()).conversations.compact(id);
			},
			async fork(id, opts) {
				return (await hostBridge()).conversations.fork(id, opts);
			},
			async patchMeta(id, patch) {
				return (await hostBridge()).conversations.patchMeta(id, patch);
			},
			// The C4b ops: same straight delegation.
			async upload(id, file) {
				return (await hostBridge()).conversations.upload(id, file);
			},
			async readFile(id, path) {
				return (await hostBridge()).conversations.readFile(id, path);
			},
		},
		users: {
			async list() {
				return (await hostBridge()).users.list();
			},
			async get(user) {
				return (await hostBridge()).users.get(user);
			},
		},
		access: {
			async accessOf(principal, resource) {
				return (await hostBridge()).access.accessOf(principal, resource);
			},
		},
		identity: {
			async actingUser(conversationId) {
				return (await hostBridge()).identity.actingUser(conversationId);
			},
		},
		// Gateway C4b: straight delegation (the bridge owns both bodies).
		models: {
			async list() {
				return (await hostBridge()).models.list();
			},
		},
		commands: {
			async list() {
				return (await hostBridge()).commands.list();
			},
			async run(conversationId, name, args, opts) {
				return (await hostBridge()).commands.run(
					conversationId,
					name,
					args,
					opts,
				);
			},
		},

		bindBridge(bridge) {
			bridgeReleased(bridge);
		},
	};
}
