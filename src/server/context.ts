/**
 * The shared server context (server restructure W0): what every route
 * module receives from `createServer` instead of capturing harness or
 * config state directly — one immutable record, so route modules stay
 * pure functions of `(app, ctx)`.
 *
 * This module also owns the Fastify request augmentation (`declare
 * module "fastify"`): the pipeline's `principal` and the
 * conversation pre-handler's `conversation` decoration are declared
 * here once, so every module that imports this context (a type-only
 * import suffices) sees the augmented fields.
 */

import type {
	Conversation,
	ConversationId,
} from "@earendil-works/pi-durable";
import type { Env, SigrunConfig } from "../config.js";
import type { OpenedHarness } from "../harness/boot.js";
import type { CommandCatalog } from "./commands.js";
import type { Principal } from "./auth/principal.js";
import type { WebuiBundle } from "./static.js";
import type { SurfaceService } from "./surfaces/service.js";
import { SseRegistry } from "./sse-registry.js";
import type { GatewayHandle } from "./gateway.js";

/** Boot-time shared state handed to every route module. */
export interface ServerContext {
	readonly opened: OpenedHarness;
	readonly config: SigrunConfig;
	/**
	 * The live-SSE registry (the ctrl+c fix): hijacked event streams never
	 * end on their own, so shutdown drains this BEFORE app.close() — the
	 * fastify drain would otherwise wait on every open webui tab forever.
	 */
	readonly sse: SseRegistry;
	/**
	 * The reserved root conversation's id, computed once in `createServer`
	 * (never recomputed per request — the list route's `root` flag and
	 * `/readyz`'s storage check both read this).
	 */
	readonly rootId: ConversationId;
	/** The resolved webui bundle; `undefined` on an API-only deploy. */
	readonly webuiBundle: WebuiBundle | undefined;
	/**
	 * The merged slash-command catalog (core hardening W5 Task 3):
	 * `buildCommandCatalog`'s one-time result over the core table and
	 * `opened.extensionCommands` — the served `/v1/commands` list, the
	 * `/v1/meta` `collisions.commands` record, and the invoke route's
	 * name→run resolution. A boot constant (computed once in
	 * `createServer`, warned once there), like the rest of this record.
	 */
	readonly commandCatalog: CommandCatalog;
	/**
	/**
	 * The listen host the server binds (W1 Task 3): the pipeline's Host
	 * check is strict on loopback binds, and `createServer` derives the
	 * default method list from it. `serve()` passes its own default
	 * (`DEFAULT_LISTEN_HOST`, the dual-stack `::`); `createServer`'s
	 * fallback when the option is omitted is `"0.0.0.0"`.
	 */
	readonly listenHost: string;
	/**
	 * The effective authenticator list (W1 Task 3), resolved once in
	 * `createServer` via `effectiveMethods(config.auth, listenHost)` —
	 * the pipeline tries these in order; `[]` is the naive workstation
	 * path.
	 */
	readonly methods: readonly ("token" | "proxy")[];
	/**
	 * The boot env (the deploy entry's `process.env`; the CLI passes the
	 * same env `serve` resolved). The `/v1/settings` `effective` block
	 * classifies env-sourced server keys against it (spec §6.6) — the
	 * one consumer today; it is the env boot actually resolved, never a
	 * per-request read.
	 */
	readonly env: Env;
	/**
	 * Live `/stream` watchers per conversation (core hardening W5 Task 6,
	 * spec §9.6): the stream route increments on attach and decrements in
	 * its exactly-once `finish` cleanup. The notifications surface's
	 * `"unwatched"` runSettled rule reads it — a conversation with an
	 * attached client is watched, and the away-from-desk notification is
	 * suppressed.
	 */
	readonly watchersByConversation: Map<ConversationId, number>;
	/**
	 * Publish one `settings.changed` event (UI-blocks U4, spec §13.2):
	 * the opened harness's fan-out seam — the hub publication
	 * (/v1/events, admins only) plus the extension
	 * `onSettingsChanged` fan-out and the scheduler re-arm. Both write
	 * routes (PATCH /v1/settings, PUT /v1/extensions/:slug/settings)
	 * call this AFTER the write commits.
	 */
	readonly publishSettingsChanged: (
		scope: "server" | { extension: string },
		keys: readonly string[],
	) => void;
	/**
	 * The restart callback (UI-blocks U4 Task 2, spec §13.3): the serve
	 * composition's graceful shutdown + `process.exit(0)`. `POST
	 * /v1/admin/restart` schedules it on the next tick (the 202 flushes
	 * first). PRESENT only in the serve composition — a hand-built test
	 * server omits it; the route then answers supervised posts with a
	 * loud composition error (never a silent no-op). Absent or present,
	 * an unsupervised config never reaches it (409 first).
	 */
	readonly requestRestart?: () => Promise<void> | void;
	/**
	 * The gateway handle (gateway C2): created by the serve composition
	 * BEFORE `createServer` and threaded through the `gateway` option so
	 * the meta route reads the wrapped engine health. ABSENT on hand-built
	 * test servers (the meta route then omits `health.gateway` — its
	 * presence keys on `opened.gatewayEngine`, and the handle only reaches
	 * it through this field).
	 */
	readonly gateway?: GatewayHandle;
	/**
	 * The extension-surface render/data service (UI-blocks U3 Task 2,
	 * spec §7.2/§7.3): over `opened.extensionSurfaces`, holding the
	 * per-principal access cache and the per-instance revision/op state.
	 * Built once in `createServer`; the surface routes (`routes/surfaces.ts`)
	 * and Task 4's watcher registry read it.
	 */
	readonly surfaces: SurfaceService;
}

declare module "fastify" {
	interface FastifyRequest {
		/**
		 * The caller the auth pipeline resolved (spec §5.2/§5.8). Set on
		 * every authenticated request by the pipeline's onRequest hook;
		 * route handlers behind the pipeline always read a value.
		 */
		principal: Principal;
		/**
		 * The conversation resolved by the `loadConversation` pre-handler;
		 * only read on routes that declare that pre-handler.
		 */
		conversation: Conversation;
	}

	/**
		 * The per-route config the extension-route mount stamps (W5 Task 2,
		 * spec §9.2): the route contribution's declared `auth`, read by the
		 * auth pipeline — `public` skips the authentication stage ONLY
		 * (Host/Origin and the unclaimed gate still ran). Absent on every
		 * core route and on unrouted (`/v1/ext/...` paths no extension
		 * declared) requests.
		 */
	interface FastifyContextConfig {
		extAuth?: "user" | "admin" | "public";
	}

	/** The SSE registry decoration (createServer decorates it): the
	 * shutdown path ends every live event stream before app.close()'s
	 * drain — hijacked streams never end on their own, so the drain
	 * would hang on each open webui tab. */
	interface FastifyInstance {
		sse: SseRegistry;
		/** The surface service decoration (createServer decorates it) — Task 4's watcher registry reaches it from the app handle in tests. */
		surfaces: SurfaceService;
	}
}
