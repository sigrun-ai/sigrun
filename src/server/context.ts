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
import type { Principal } from "./auth/principal.js";
import type { WebuiBundle } from "./static.js";

/** Boot-time shared state handed to every route module. */
export interface ServerContext {
	readonly opened: OpenedHarness;
	readonly config: SigrunConfig;
	/**
	 * The reserved root conversation's id, computed once in `createServer`
	 * (never recomputed per request — the list route's `root` flag and
	 * `/readyz`'s storage check both read this).
	 */
	readonly rootId: ConversationId;
	/** The resolved webui bundle; `undefined` on an API-only deploy. */
	readonly webuiBundle: WebuiBundle | undefined;
	/**
	/**
	 * The listen host the server binds (W1 Task 3): the pipeline's Host
	 * check is strict on loopback binds, and `createServer` derives the
	 * default method list from it. Defaults to `"0.0.0.0"`.
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
}
