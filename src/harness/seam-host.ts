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
import type { ConversationId, Harness, ToolRegistration } from "@earendil-works/pi-durable";
import type { HostBridge } from "../server/host-bridge.js";
import type { SigrunHost } from "../extension.js";
import type { Tree } from "@sigrun/shared/blocks";
import {
	AmbientDoc,
	AmbientOwnersDoc,
	validateAmbient,
	type AmbientPlace,
	type AmbientRecord,
	type StoredAmbientRecord,
} from "./ambient.js";
import {
	InteractionDoc,
	InteractionsIndexDoc,
	applyAnswer,
	asInteractionRecord,
	indexPending,
	indexSettled,
	sweepSecretDelivery,
	takeSecretDelivery,
	validateInteraction,
	type InteractionAnswer,
	type InteractionRecord,
} from "./interactions.js";
import { toDurableContext } from "./context.js";
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
	/** Multi-user M2: per-user publication, gated by the factory declaration. */
	readonly tools: SigrunHost["tools"];
	readonly services: SigrunHost["services"];
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
	/** Inspect one record WITHOUT consuming the one-shot secret delivery
	 *  (the stored projection, masked; safe to repeat). */
	peekInteraction(
		conversationId: ConversationId,
		callId: string,
		context: Context,
	): Promise<Readonly<InteractionRecord> | undefined>;
	/** The owning extension's delivery read (first applicable read merges
	 *  the raw secrets once; later reads are masked). */
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
			readonly body?: Tree;
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
	/** Read-only lookup of live jobs (A5); binds lazily with the bridge. */
	readonly jobs: SigrunHost["jobs"];
	/** Send one explicit extension notice; validates, then enqueues delivery. */
	readonly notify: SigrunHost["notify"];
	/** The user directory (§9.7): list/get in admin wire form. */
	readonly users: SigrunHost["users"];
	/**
	 * External-identity links (multi-user §11.3): chat senders and login
	 * subjects in one core-owned table. Binds lazily like every other
	 * bridged member.
	 */
	readonly accounts: SigrunHost["accounts"];
	/** Resolve one principal's access to one shared resource (§9.7). */
	readonly access: SigrunHost["access"];
	/** The conversation's owner — who the agent acts for (§9.7). */
	readonly identity: SigrunHost["identity"];
	/**
	 * The curation surface (curator P6, A9): the curator's read APIs
	 * and run producers. Delegates to the boot-built host through the
	 * bridge (the same lazy-bind discipline as `conversations`) — a
	 * factory-body call WAITS, never a silent drop.
	 */
	readonly curation: SigrunHost["curation"];
	/** The served model catalog (gateway C4b): `GET /v1/models`' list. */
	readonly models: SigrunHost["models"];
	/** The slash-command surface (gateway C4b): catalog + in-process run. */
	readonly commands: SigrunHost["commands"];
	/**
	 * Publish a surface-instance change (UI-blocks U3 Task 4, spec §7.3):
	 * `changed(id, key, update?)` bumps the instance's rev and publishes
	 * ONE `surface.changed {slug, id, k, rev, treeRev}` hub event (the
	 * hashed `k`, no params, no data). Binds lazily (the same discipline
	 * as `conversations`): a factory-body call WAITS for the surface
	 * bridge, bound when the server exists — never an early resolution,
	 * never a silent drop, never a boot crash (Review Focus 4). The
	 * extension's own slug fills the event's `slug` at bind time.
	 */
	readonly surfaces: SigrunHost["surfaces"];
	/**
	 * Bind the server-provided host bridge (W5 Task 5): `createServer`
	 * calls `OpenedHarness.bindHostBridge` once its `ServerContext`
	 * exists, which sets the ONE bridge on every seam host — the
	 * `conversations`/`users`/`access`/`identity` members above then run
	 * the server's shared conversation ops. Extensions never call this;
	 * it is not part of the extension-facing surface.
	 */
	bindBridge(bridge: HostBridge): void;
	/**
	 * Declare that a server WILL bind this host's bridge (polish A1, spec
	 * §5.2): `OpenedHarness.expectHostBridge` fans this out to every seam
	 * host — `createServer` calls it synchronously on entry, and the
	 * `expectHostBridge: true` open option marks it at boot. While set, a
	 * bridge call on an unbound host keeps the bounded pre-bind wait;
	 * while clear, an unbound call rejects immediately with
	 * {@link HostBridgeUnavailableError}. Idempotent.
	 */
	expectBridge(): void;
}

/**
 * A bridge-backed `host.*` member was called in a process that will never
 * bind the host bridge (no `createServer`, no `expectHostBridge: true`).
 * Fails fast instead of waiting out the bind deadline: the member and the
 * calling extension are named so the embedder can either start a server
 * or stop calling bridged members.
 */
export class HostBridgeUnavailableError extends Error {
	readonly member: string;
	readonly caller: string;
	constructor(member: string, caller: string) {
		super(
			`seam host: ${member} — no server will bind the host bridge (caller: ${caller}); ` +
				`start createServer or pass expectHostBridge: true to wait for a bind`,
		);
		this.name = "HostBridgeUnavailableError";
		this.member = member;
		this.caller = caller;
	}
}

/**
 * Build the seam host for one extension. `kinds` gates writes: a record
 * whose `kind`/`key` the extension never declared is rejected — the
 * declaration is what channels use to inventory capabilities, so an
 * undeclared write would silently falsify it. `sharedStores` is the
 * boot-built store trio (one per boot, from the resolved roots); the
 * host scopes it to its identity's slug — `rekey` re-scopes in place.
 */
/**
 * The pre-bind forwarder for the curation surface's SYNC store members
 * (`skills(user)`, `overlays(user)`): returns the store handle at once;
 * every method call awaits the bridge first (the shared pending promise
 * carries the bind deadline). Method names are read off the resolved
 * store at call time, so the forwarder stays shape-stable.
 */
function syncStoreForwarder(
	pending: Promise<unknown>,
	member: "skills" | "overlays",
	user: string,
): Record<string, (...args: readonly unknown[]) => Promise<unknown>> {
	return new Proxy(
		{},
		{
			get(_t, method) {
				return async (...args: readonly unknown[]) => {
					const resolvedHost = (await pending) as Record<string, unknown>;
					const store = (resolvedHost[member] as (u: string) => unknown)(user) as Record<
						string,
						(...call: readonly unknown[]) => unknown
					>;
					const fn = store[method as string];
					if (typeof fn !== "function") {
						throw new Error(
							`curation: store ${member}(${user}) method ${String(method)} is not callable`,
						);
					}
					return fn.apply(store, [...args]);
				};
			},
		},
	);
}

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
	perUserTools?: {
		readonly declared: (slug: string) => boolean;
		readonly set: (slug: string, user: string, tools: readonly ToolRegistration[]) => void;
	},
	services?: {
		connect(slug: string, name: string, user: string, ctx: Parameters<SigrunHost["services"]["connect"]>[2]): ReturnType<SigrunHost["services"]["connect"]>;
		settingsChanged(slug: string, user: string): void;
	},
): SeamHost {
	const interactionKinds = new Set(kinds.interaction ?? []);
	const ambientKinds = new Set(kinds.ambient ?? []);
	// The scoped stores view, keyed on the CURRENT identity — the same
	// closed-over `let` pattern as `identity` itself: rekey re-points it
	// and the `stores` getter below reads through the closure, so the
	// factory-captured host object re-scopes IN PLACE (never a second
	// host, never a stale view).
	let stores = scopedExtensionStores(sharedStores, identity.name);
	const userStores = (user: string): ReturnType<SigrunHost["stores"]["user"]> => {
		const scoped = stores.user(user);
		return {
			...scoped,
			settings: {
				get: scoped.settings.get,
				set: async (value) => {
					await scoped.settings.set(value);
					services?.settingsChanged(identity.name, user);
				},
			},
		};
	};

	async function harness(context: Context): Promise<Harness> {
		const h = await bind.harness();
		// The caller's context gates the wait: an aborted request/tool call
		// unwinds instead of waiting forever for a harness that never opens.
		// Normalize here too so this accessor remains safe for future callers;
		// each method below also normalizes its own binding for h.* forwarding.
		toDurableContext(context).abortSignal?.throwIfAborted();
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
	// Fail-fast vs wait (polish A1, spec §5.2): `expectBridge()` declares a
	// server WILL bind (fanned out from `OpenedHarness.expectHostBridge`,
	// which `createServer` calls synchronously on entry). Until then a
	// bridge-less process is treated as a serverless embed — calls reject
	// at once instead of stalling the full hook deadline.
	let bridgeBound = false;
	let bridgeExpected = false;
	// The pre-bind bound: a bridge call that waits PAST this long fails
	// loud instead of hanging forever (the jobs-task fake-clock hang's
	// lesson). Only reachable when a server is expected — `createServer`
	// binds the bridge at boot, long inside the bound.
	const bridgeDeadlineMs = 60_000;
	const hostBridge = async (member: string): Promise<HostBridge> => {
		await bind.harness();
		if (bridgeBound) return await bridgePromise;
		if (!bridgeExpected) {
			throw new HostBridgeUnavailableError(member, identity.name);
		}
		return await Promise.race([
			bridgePromise,
			new Promise<never>((_, reject) => {
				const timer = setTimeout(() => {
					reject(
						new Error(
								`seam host: ${member} — the bridge never bound after ${bridgeDeadlineMs}ms; is createServer running? (caller: ${identity.name})`,
						),
					);
				}, bridgeDeadlineMs);
				// The rejection timer never keeps the process alive.
				if (typeof timer === "object" && "unref" in timer) timer.unref();
			}),
		]);
	};
	// The curation surface's settled bridge host (curator P6/A9): memoized
	// HERE — in the host closure — so every `host.curation` getter call (a
	// FRESH proxy per read) shares one settled reference. See the getter's
	// own comment for the sync-member discipline this serves.
	let curationHost: SeamHost["curation"] | undefined;

	// The surfaces fire-and-forget lane logs an unavailable bridge ONCE per
	// member (polish A1): the same fail-fast error every call, so repeats
	// are noise — other failures keep their per-call console.error.
	let surfacesUnavailableLogged = false;

	return {
		get stores() {
			return { ...stores, user: userStores };
		},

		tools: {
			setUserTools(user, tools) {
				if (perUserTools?.declared(identity.name) !== true) {
					throw new Error("perUserTools not declared");
				}
				perUserTools.set(identity.name, user, tools);
			},
		},
		services: {
			connect: (name, user, ctx) => {
				if (services === undefined) return Promise.reject(new Error("user services unavailable"));
				return services.connect(identity.name, name, user, ctx);
			},
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
			context = toDurableContext(context);
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
			context = toDurableContext(context);
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
				// the extension answered itself. The conversationId rides the opts
				// so applyAnswer can record a secret delivery (Review Focus 4).
				const applied = applyAnswer(
					draft,
					answer,
					opts?.user === undefined ? "extension" : "human",
					Date.now(),
					opts?.user,
					{ conversationId },
				);
				if (applied) {
					const index = await tx.doc(InteractionsIndexDoc);
					indexSettled(index, conversationId, callId);
				}
				return applied;
			}, context);
		},

		async settleInteraction(conversationId, callId, status, context) {
			context = toDurableContext(context);
			const h = await harness(context);
			// The sweep (Review Focus 4) is INSIDE the commit, applied only on
			// the terminal transition: sweeping before the pending check would
			// delete a delivery that still belongs to a live answer record
			// (a no-op settle on an already-answered record must not eat the
			// winner's unread secret).
			return await h.commit(async (tx) => {
				const draft = await tx.doc(
					InteractionDoc,
					conversationId,
					callId,
					callId,
				);
				if (draft.status !== "pending") return false;
				// SAFETY: the tracked-draft write pattern mutates through a
				// structural record view; every key exists by construction.
				const mutable = draft as unknown as Record<string, unknown>;
				mutable.status = status;
				mutable.settledAt = Date.now();
				const index = await tx.doc(InteractionsIndexDoc);
				indexSettled(index, conversationId, callId);
				sweepSecretDelivery(conversationId, callId);
				return true;
			}, context);
		},

		async peekInteraction(conversationId, callId, context) {
			// The non-consuming inspection read (release-readiness-2 §1):
			// the SAME stored projection as snapshotInteraction, with NO
			// path to takeSecretDelivery — an inspector (the gateway
			// notifier, outcome edits, answer correlation) can never eat
			// the owning extension's one-shot raw-secret delivery.
			context = toDurableContext(context);
			const h = await harness(context);
			const stored = await h.snapshot(
				InteractionDoc,
				conversationId,
				callId,
				context,
			);
			if (stored === undefined) return undefined;
			return asInteractionRecord(stored);
		},

		async snapshotInteraction(conversationId, callId, context) {
			context = toDurableContext(context);
			const h = await harness(context);
			const stored = await h.snapshot(
				InteractionDoc,
				conversationId,
				callId,
				context,
			);
			if (stored === undefined) return undefined;
			const record = asInteractionRecord(stored);
			// An unanswered record cannot have a delivery — and taking before
			// this check would DELETE a delivery in flight in the
			// record-then-commit-visible window (the poll returns the pending
			// record and the true value is lost). Check the record FIRST.
			if (record.answer === undefined) return record;
			// Review Focus 4 (the extension-only read): a secret delivery for
			// this record merges its TRUE values back ONCE — the take is
			// one-shot, so a second read sees the stored MASK. HTTP GETs never
			// come through here (they serve the stored record verbatim).
			const delivery = takeSecretDelivery(conversationId, callId);
			if (delivery === undefined) return record;
			return {
				...record,
				answer: { values: delivery.values },
			};
		},

		async setAmbient(conversationId, record, context) {
			if (!ambientKinds.has(record.key)) {
				throw new SeamError(
					"ambient",
					`surface key ${JSON.stringify(record.key)} is not declared by ${identity.name} (declare it in the factory result's ambientKinds)`,
				);
			}
			context = toDurableContext(context);
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
				// SAFETY: `full` carries a validated block tree as its body
				// (validateAmbient's validateTree gate just passed); the stored
				// mirror's body differs only in the structural JSON naming.
				Object.assign(draft, full as unknown as StoredAmbientRecord);
			}, context);
		},

		async clearAmbient(conversationId, key, context) {
			if (!ambientKinds.has(key)) {
				throw new SeamError(
					"ambient",
					`surface key ${JSON.stringify(key)} is not declared by ${identity.name}`,
				);
			}
			context = toDurableContext(context);
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
				const bridge = await hostBridge("conversations.create");
				return bridge.conversations.create({
					...(opts.owner === undefined ? {} : { owner: opts.owner }),
					...(opts.sharing === undefined ? {} : { sharing: opts.sharing }),
					...(opts.name === undefined ? {} : { name: opts.name }),
					...(opts.job === undefined ? {} : { job: opts.job }),
					...(opts.agent === undefined ? {} : { agent: opts.agent }),
					// The source default: the CALLING extension's slug (spec §9.5).
					source: opts.source ?? identity.name,
				});
			},
			async submit(id, input, opts) {
				const bridge = await hostBridge("conversations.submit");
				return bridge.conversations.submit(id, input, opts);
			},
			async watch(id, listener) {
				const bridge = await hostBridge("conversations.watch");
				return bridge.conversations.watch(id, listener);
			},
			async list(opts) {
				const bridge = await hostBridge("conversations.list");
				return bridge.conversations.list(opts);
			},
			async meta(id) {
				const bridge = await hostBridge("conversations.meta");
				return bridge.conversations.meta(id);
			},
			async entries(id, query, limit, cursor) {
				return (await hostBridge("conversations.entries")).conversations.entries(
					id,
					query,
					limit,
					cursor,
				);
			},
			async entry(id, entryId) {
				return (await hostBridge("conversations.entry")).conversations.entry(id, entryId);
			},
			// The C4a ops: straight delegation (the bridge resolves the id and
			// runs the op its HTTP twin runs).
			async abort(id) {
				return (await hostBridge("conversations.abort")).conversations.abort(id);
			},
			async configure(id, opts) {
				return (await hostBridge("conversations.configure")).conversations.configure(id, opts);
			},
			async compact(id) {
				return (await hostBridge("conversations.compact")).conversations.compact(id);
			},
			async fork(id, opts) {
				return (await hostBridge("conversations.fork")).conversations.fork(id, opts);
			},
			async patchMeta(id, patch) {
				return (await hostBridge("conversations.patchMeta")).conversations.patchMeta(id, patch);
			},
			// The C4b ops: same straight delegation.
			async upload(id, file) {
				return (await hostBridge("conversations.upload")).conversations.upload(id, file);
			},
			async readFile(id, path) {
				return (await hostBridge("conversations.readFile")).conversations.readFile(id, path);
			},
		},
		jobs: {
			async get(id) {
				return (await hostBridge("jobs.get")).jobs.get(id);
			},
		},
		users: {
			async list() {
				return (await hostBridge("users.list")).users.list();
			},
			async get(user) {
				return (await hostBridge("users.get")).users.get(user);
			},
		},
		accounts: {
			async lookup(provider, subject) {
				return (await hostBridge("accounts.lookup")).accounts.lookup(provider, subject);
			},
			async link(provider, subject, user, via) {
				return (await hostBridge("accounts.link")).accounts.link(
					provider,
					subject,
					user,
					via,
				);
			},
			async unlink(provider, subject) {
				return (await hostBridge("accounts.unlink")).accounts.unlink(provider, subject);
			},
			async listForUser(user) {
				return (await hostBridge("accounts.listForUser")).accounts.listForUser(user);
			},
		},
		access: {
			async accessOf(principal, resource) {
				return (await hostBridge("access.accessOf")).access.accessOf(principal, resource);
			},
		},
		identity: {
			async actingUser(conversationId) {
				return (await hostBridge("identity.actingUser")).identity.actingUser(conversationId);
			},
		},
		// Curator P6 (A9): the boot-built curation host through the bridge —
		// the lazy member discipline (a factory-body call waits for the
		// bridge; a post-bind call resolves at once). Every member of the
		// curation surface is a function, so a Proxy that forwards each
		// property read (and call) to the RESOLVED bridge host implements
		// the whole surface with the same wait semantics as the async
		// delegations above. Members that return SYNCHRONOUS store objects
		// (`skills(user)`, `overlays(user)` — store handles whose own methods
		// are async) must come back UNAWAITED: an `async` wrapper would
		// return a Promise of the store, and the caller's sync `.list()` —
		// the shape the view and the targets use — would read undefined
		// (D1's e2e found the view rendering 500 on exactly this). The
		// settled host is memoized in the HOST closure (not the getter —
		// every `host.curation` read returns a FRESH proxy, and a per-proxy
		// memo would reset on each read, putting the async forwarder back
		// in front of sync members on the second read).
		get curation(): SeamHost["curation"] {
			if (curationHost !== undefined) return curationHost;
			const pending = hostBridge("curation").then((bridge) => {
				curationHost = bridge.curation;
				return bridge.curation;
			});
			// SAFETY: the Proxy target satisfies the structural member shapes
			// because every forwarded call is an `apply` trap on the real host's
			// own member; the cast only bridges the contract's named members.
			return new Proxy(
				{} as unknown as SeamHost["curation"],
				{
					get(_target, property) {
						// The settled-bridge fast path: the member itself, bound — a
						// synchronous member (`skills`) returns its store synchronously,
						// an async one keeps returning its promise. The property read is
						// STILL a function either way (the surface has no data members),
						// so callers observe the contract shape unchanged.
						if (curationHost !== undefined) {
							const member = (curationHost as unknown as Record<string, unknown>)[
								property as string
							];
							if (typeof member !== "function") {
									throw new Error(
												`curation: member ${String(property)} is not callable`,
								);
							}
							return (member as (...call: readonly unknown[]) => unknown).bind(
								curationHost,
							);
						}
						// The pre-bind window: every member becomes a forwarder that
						// waits for the bridge (the factory-body discipline). The
						// surface's SYNC store members — `skills(user)` and
						// `overlays(user)` return store handles whose own methods are
						// async (the shape the view and the steps call: `.list()` with
						// no await on the store itself) — must come back as a STORE,
						// not a promise of one (the eval's idle pass hit exactly this:
						// the archive step read `.list` off a promise). A lazy store
						// whose methods each await the bridge preserves the
						// sync-return contract while keeping the wait: the caller
						// gets the store immediately and its first method call
						// resolves once the bridge lands (or rejects at the bind
						// deadline through the shared pending promise).
						if (property === "skills" || property === "overlays") {
							return (user: string) =>
								syncStoreForwarder(pending, property, user);
						}
						return async (...args: readonly unknown[]) => {
							const resolvedHost = await pending;
							// SAFETY: the property is one of the contract's own function
							// members (the surface has no data members); the bound call is
								// the real host's, typed at the call site.
							const member = (
								resolvedHost as unknown as Record<string, unknown>
							)[property as string];
							if (typeof member !== "function") {
									throw new Error(
									`curation: member ${String(property)} is not callable`,
								);
							}
							return (
									member as (...call: readonly unknown[]) => unknown
							).apply(resolvedHost, [...args]);
						};
					},
				},
			);
		},
		// Gateway C4b: straight delegation (the bridge owns both bodies).
		models: {
			async list() {
				return (await hostBridge("models.list")).models.list();
			},
		},
		commands: {
			async list() {
				return (await hostBridge("commands.list")).commands.list();
			},
			async run(conversationId, name, args, opts) {
				return (await hostBridge("commands.run")).commands.run(
					conversationId,
					name,
					args,
					opts,
				);
			},
		},
		async notify(input) {
			return (await hostBridge("notify")).notify(identity.name, input);
		},
		// The surfaces seam (UI-blocks U3 Task 4): `changed` awaits the
		// bridge (so a factory-body call waits, never resolves early) and
		// delegates to the server-side SurfaceService — the rev bump + the
		// hub event are the service's one code path (the actions route and
		// the host seam share it).
		surfaces: {
			changed(id, key, update) {
				const host = identity; // capture for the async lane
				const ran = (): void => {
					// The Review Focus 4 observability seam (the fixture
					// surfaces-early pattern): a call that WAITED for the
					// bridge is distinguishable from an early no-op. Inert in
					// production (nothing sets it).
					(
						globalThis as {
							__sigrunSurfaceChanged?: (slug: string) => void;
						}
					).__sigrunSurfaceChanged?.(host.name);
				};
				void hostBridge("surfaces.changed")
					.then((bridge) => {
						ran();
						bridge.surfaces.changed(identity.name, id, key, update);
					})
					.catch((error) => {
						if (error instanceof HostBridgeUnavailableError) {
							if (surfacesUnavailableLogged) return;
							surfacesUnavailableLogged = true;
							console.warn(
								`seam host: surfaces.changed (${identity.name}) — ${error.message} (further repeats suppressed)`,
							);
							return;
						}
						console.error(
							`seam host: surfaces.changed (${identity.name}/${id}) failed:`,
							error,
						);
					});
			},
		},

		bindBridge(bridge) {
			bridgeBound = true;
			bridgeReleased(bridge);
		},

		expectBridge() {
			bridgeExpected = true;
		},
	};
}
