/**
 * The shared server context (server restructure W0): what every route
 * module receives from `createServer` instead of capturing harness or
 * config state directly — one immutable record, so route modules stay
 * pure functions of `(app, ctx)`.
 *
 * This module also owns the Fastify request augmentation (`declare
 * module "fastify"`): the identity hook's `sigrunUser` and the
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
		 * The resolved caller identity (spec §5 owner seam): the trimmed
		 * `X-Sigrun-User` header, or `undefined` when absent/empty. Naive
		 * mode — nothing is verified (trusted-network posture, v1).
		 */
		sigrunUser: string | undefined;
		/**
		 * The conversation resolved by the `loadConversation` pre-handler;
		 * only read on routes that declare that pre-handler.
		 */
		conversation: Conversation;
	}
}
