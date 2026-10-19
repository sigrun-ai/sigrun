/**
 * The §5 HTTP server foundation (spec §5).
 *
 * `createServer` builds a Fastify app over one `OpenedHarness` — a thin
 * layer: conversation endpoints serialize pi-durable's native
 * `ConversationView` (via `views.ts`), `GET /v1/meta` reports boot facts.
 * The factory registers routes and returns; it never listens (the deploy
 * entry listens; tests use `app.inject()`).
 *
 * Route modules registered here, each a pure `(app, ctx)` registrar over
 * the shared `ServerContext`: the deploy probes (`routes/probes.ts`),
 * the boot-fact routes (`routes/meta.ts`), the conversation lifecycle +
 * session-meta routes incl. the JSONL import parser
 * (`routes/conversations.ts`), the SSE view stream (`routes/stream.ts`),
 * the submission lifecycle routes (`routes/submissions.ts`), the
 * interaction + ambient seam routes (docs/approval-ux-seams.md,
 * `routes/interactions.ts`), the workspace file routes
 * (`routes/files.ts`), the provider surface routes
 * (`routes/providers.ts`), and the settings store routes
 * (`routes/settings.ts`). This module only composes: the Fastify
 * instance, the identity hook, the webui mount, the reserved-root
 * ensure, and the register calls — no route handler lives here.
 *
 * **Conversation listing (durable):** `GET /v1/conversations` (in
 * `routes/conversations.ts`) scans storage — `scanConversations` over the
 * handle `openHarness` exposes — so the listing is the DURABLE set:
 * conversations other processes or earlier servers created (a restart
 * forgets nothing), and conversations tasks/tools created inside
 * pi-durable (the cron case) all list. The harness itself has no
 * enumeration; the storage scan is authoritative.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { SigrunConfig } from "../config.js";
import type { OpenedHarness } from "../harness/boot.js";
import type { ServerContext } from "./context.js";
import { storeAgentChange } from "./helpers.js";
import { registerConversationRoutes } from "./routes/conversations.js";
import { registerFileRoutes } from "./routes/files.js";
import { registerInteractionRoutes } from "./routes/interactions.js";
import { registerMetaRoutes } from "./routes/meta.js";
import { registerProbeRoutes } from "./routes/probes.js";
import { registerProviderRoutes } from "./routes/providers.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerStreamRoutes } from "./routes/stream.js";
import { registerSubmissionRoutes } from "./routes/submissions.js";
import {
	resolveWebuiBundle,
	serveWebuiBundle,
	type ContributedWebuiBundle,
} from "./static.js";

/**
 * Build the §5 server over one opened harness.
 *
 * Ensures the reserved root conversation exists at factory time (the §5
 * default), so the first list serves it.
 *
 * @param opened the booted harness (from `openHarness`) — the server serves
 * exactly this harness's conversations.
 * @param config parsed sigrun config; the listen entry consumes
 * `config.port`, the meta route derives `health.backup` from
 * `config.backup` presence, and `capabilities.backup` from the same
 * presence (the §5 backup affordance gate). Identity is the naive seam —
 * `X-Sigrun-User` resolves per request and stamps `SessionMeta.owner` at
 * create/fork/import; VERIFICATION (actual auth) arrives with a later
 * slice.
 * @param contributedBundles the extension-contributed webui-bundle registry
 * (build-and-webui Task 6 threads it here from boot; the serve-time
 * resolution (Task 5) selects a NAME selector against it — an empty
 * registry is the no-extension deploy).
 */
export async function createServer(
	opened: OpenedHarness,
	config: SigrunConfig,
	contributedBundles: readonly ContributedWebuiBundle[] = [],
): Promise<FastifyInstance> {
	const app = Fastify({ logger: false });
	// The one body-limit error shape (spec §6.2): Fastify's
	// `FST_ERR_CTP_BODY_TOO_LARGE` (raised by any route's `bodyLimit` — the
	// raw upload PUT, the base64 POST, the JSONL import) becomes the
	// sigrun `413 {error: "too_large", maxBytes}` with the limit the
	// failing route actually enforced. Everything else passes through the
	// default error serialization unchanged.
	app.setErrorHandler((error: { code?: string }, request, reply) => {
		if (error.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
			return reply.code(413).send({
				error: "too_large",
				maxBytes: request.routeOptions.bodyLimit,
			});
		}
		return reply.send(error);
	});
	// The identity seam (spec §5 / TUI plan): resolve the caller on EVERY
	// request — the trimmed `X-Sigrun-User` header, `undefined` when absent
	// or empty. Naive mode: the hook VERIFIES nothing (trusted-network
	// posture; no auth flow in v1) — an absent header is not an error, the
	// request proceeds exactly as before. Registered first, before any
	// route, so every handler sees the resolved identity; it only reads a
	// header, so content-type parsing (the JSONL parser below) and any later
	// deploy-auth onRequest hook keep their semantics.
	app.addHook("onRequest", async (request) => {
		const header = request.headers["x-sigrun-user"];
		const value = Array.isArray(header) ? header[0] : header;
		request.sigrunUser = value?.trim() || undefined;
	});
	// The webui channel bundle (Task 20, spec §4.1/§6; serve-time resolution
	// is build-and-webui Task 5): resolve enabled-gate → contributed NAME →
	// PATH → default against `config.webui` and the contributed registry,
	// then mount the static bundle + SPA fallback when one resolves. An
	// explicit-but-unresolvable selector rejects here (fail loud, per the
	// deploy entry's boot contract). Explicit routes win over the static
	// wildcard, so the /v1 API + probes are unaffected by the mount.
	const webuiBundle = await resolveWebuiBundle(config, contributedBundles);
	if (webuiBundle !== undefined) {
		await serveWebuiBundle(app, webuiBundle);
	}
	// The reserved root is ensured before any route runs. The listing is
	// durable (the module docstring's "Conversation listing (durable)"
	// section): it scans storage, so this server serves every recorded
	// conversation, not only its own creates.
	// The root conversation's agent carries the settings store's
	// sigrun-resolved fields too (Task 8b): the root is created once, so its
	// tool filter / thinking override snapshot at factory time — later
	// creates re-read the store.
	const root = await opened.harness.root(BACKGROUND_CONTEXT, {
		agent: storeAgentChange(opened, opened.defaultModel),
	});
	const rootId = root.id;
	// The shared context every route module receives: the opened harness,
	// the config, the root id (computed once, never per request), and the
	// resolved webui bundle.
	const ctx: ServerContext = { opened, config, rootId, webuiBundle };
	registerProbeRoutes(app, ctx);
	registerMetaRoutes(app, ctx);
	registerConversationRoutes(app, ctx);
	registerStreamRoutes(app, ctx);
	registerSubmissionRoutes(app, ctx);
	registerInteractionRoutes(app, ctx);
	registerFileRoutes(app, ctx);
	registerProviderRoutes(app, ctx);
	registerSettingsRoutes(app, ctx);

	return app;
}
