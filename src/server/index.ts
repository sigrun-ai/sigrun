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
import { effectiveMethods, type SigrunConfig } from "../config.js";
import type { OpenedHarness } from "../harness/boot.js";
import { registerAuthPipeline } from "./auth/pipeline.js";
import { isLoopbackHost } from "./auth/loopback.js";
import type { ServerContext } from "./context.js";
import { storeAgentChange } from "./helpers.js";
import { registerAuthRoutes } from "./routes/auth.js";
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
	options?: { listenHost?: string },
): Promise<FastifyInstance> {
	const app = Fastify({ logger: false });
	const listenHost = options?.listenHost ?? "0.0.0.0";
	const methods = effectiveMethods(config.auth, listenHost);
	// The auth posture warnings (W1 Task 3, the plan's Global
	// Constraints): once per server, never per request.
	if (methods.length === 0 && !isLoopbackHost(listenHost)) {
		console.warn(
			`sigrun: authentication is DISABLED (methods: []) on a non-loopback bind (${listenHost}) — any reachable client is trusted`,
		);
	}
	const broadTrusted = config.auth.proxy.trustedProxies.some((cidr) => {
		const slash = cidr.indexOf("/");
		if (slash === -1) return false;
		const prefix = Number(cidr.slice(slash + 1));
		const v6 = cidr.includes(":");
		return v6 ? prefix <= 32 : prefix <= 8;
	});
	if (methods.includes("proxy") && broadTrusted) {
		console.warn(
			"sigrun: auth.proxy.trustedProxies includes a very broad range — a forward-auth method trusts every peer it matches",
		);
	}
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
	const ctx: ServerContext = { opened, config, rootId, webuiBundle, listenHost, methods };
	// The pipeline is registered FIRST (W1 Task 3): it replaces the naive
	// `X-Sigrun-User` hook — Host/Origin checks, the public surface, the
	// env service token, the setup gate, and method resolution stamp
	// `request.principal` before any route runs.
	registerAuthPipeline(app, ctx);
	registerAuthRoutes(app, ctx);
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
