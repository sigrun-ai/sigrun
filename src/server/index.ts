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
 * (`routes/providers.ts`), the settings store routes
 * (`routes/settings.ts`), and the Prometheus text exposition
 * (`routes/metrics.ts`, W2 Task 8). This module only composes: the Fastify
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
import { buildCommandCatalog, SLASH_COMMANDS } from "./commands.js";
import { effectiveMethods, type Env, type SigrunConfig } from "../config.js";
import type { OpenedHarness } from "../harness/boot.js";
import { registerAuthPipeline } from "./auth/pipeline.js";
import { isLoopbackHost } from "./auth/loopback.js";
import type { ServerContext } from "./context.js";
import { SseRegistry } from "./sse-registry.js";
import { storeAgentChange } from "./helpers.js";
import { registerCoreOwnershipParticipant } from "./ownership.js";
import { createHostBridge } from "./host-bridge.js";
import { registerJobsOwnershipParticipant } from "../jobs/transfer.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerConversationRoutes } from "./routes/conversations.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerExtensionRoutes as registerExtensionSettingsRoutes } from "./routes/extensions.js";
import { registerExtensionRoutes as mountExtensionRoutes } from "./routes/extension-routes.js";
import { registerFileRoutes } from "./routes/files.js";
import { registerJobRoutes } from "./routes/jobs.js";
import { registerInteractionRoutes } from "./routes/interactions.js";
import { registerMetaRoutes } from "./routes/meta.js";
import { registerMetricsRoutes } from "./routes/metrics.js";
import { registerOnboardingRoutes } from "./routes/onboarding.js";
import { registerProbeRoutes } from "./routes/probes.js";
import { registerProviderRoutes } from "./routes/providers.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerStreamRoutes } from "./routes/stream.js";
import type { GatewayHandle } from "./gateway.js";
import { startNotifications } from "./notifications.js";
import { registerSubmissionRoutes } from "./routes/submissions.js";
import { registerUserRoutes } from "./routes/users.js";
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
 * presence (the §5 backup affordance gate). Identity is the W1 request
 * pipeline (`auth/pipeline.ts`, registered FIRST below): Host/Origin
 * checks, the public surface, the env service token, the setup gate,
 * then the configured methods — the resolved principal stamps
 * `SessionMeta.owner` at create/fork/import.
 * @param options.listenHost the host the server will bind (default
 * `"0.0.0.0"`); the pipeline's Host check and the default method list
 * (`effectiveMethods`) both derive from it.
 * @param contributedBundles the extension-contributed webui-bundle registry
 * (build-and-webui Task 6 threads it here from boot; the serve-time
 * resolution (Task 5) selects a NAME selector against it — an empty
 * registry is the no-extension deploy).
 * @param options.env the boot env (`process.env` at the deploy entry) — the
 * `/v1/settings` `effective` block classifies env-sourced server keys
 * against it (spec §6.6). Defaults to `{}` for hand-built test servers
 * (every key then reports file/default, which is accurate for an
 * env-less boot).
 */
export async function createServer(
	opened: OpenedHarness,
	config: SigrunConfig,
	contributedBundles: readonly ContributedWebuiBundle[] = [],
	options?: {
		listenHost?: string;
		env?: Env;
		/**
		 * The gateway handle (gateway C2): the serve composition creates it
		 * (startGateway) BEFORE this call and starts the engine after
		 * `app.listen` — threading it here puts the wrapped engine health on
		 * `ServerContext` for the meta route. Optional: a hand-built test
		 * server (no handle) serves meta WITHOUT `health.gateway` even when
		 * an engine loaded — the field is the serve composition's report.
		 */
		gateway?: GatewayHandle;
	},
): Promise<FastifyInstance> {
	const app = Fastify({ logger: false });
	const listenHost = options?.listenHost ?? "0.0.0.0";
	const env = options?.env ?? {};
	// The one body-limit error shape (spec §6.2, W2): Fastify's
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
	// The merged slash-command catalog (W5 Task 3): ONE build here — the
	// core table plus every loaded extension's `commands` declarations —
	// so the catalog route, the meta collision record, and the invoke
	// route share one merge (and its warnings fire once, not per route).
	const commandCatalog = buildCommandCatalog(
		SLASH_COMMANDS,
		opened.extensionCommands,
	);
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
	// the config, the root id (computed once, never per request), the
	// resolved webui bundle, the auth-derivation inputs (listenHost + the
	// effective method list), and the boot env (the settings routes'
	// `effective` block reads it).
	const sse = new SseRegistry();
	// Decorated for the shutdown path (serve.ts): fastify's own drain waits
	// on in-flight requests, so the SSE registry must be endable from the
	// OUTSIDE before app.close() — a decoration is the typed, discoverable
	// way to hand that handle up without widening ServerContext's consumers.
	app.decorate("sse", sse);
	const ctx: ServerContext = {
		opened,
		config,
		rootId,
		webuiBundle,
		commandCatalog,
		listenHost,
		methods,
		env,
		watchersByConversation: new Map(),
		sse,
		...(options?.gateway === undefined ? {} : { gateway: options.gateway }),
	};
	// The host bridge (W5 Task 5, spec §9.5/§9.7): ONE bridge over this
	// server's context, bound onto every seam host — the extension-facing
	// conversations/users/access/identity surface then runs the SAME
	// conversation ops the routes below run (never a second
	// implementation). Bound here, after the context exists and before any
	// route or extension code can serve a request; calls issued earlier
	// (a factory body) have been waiting on exactly this assignment.
	opened.bindHostBridge(createHostBridge(ctx));
	// The notifications surface (W5 Task 6, spec §9.6): one hub
	// subscription turning host events into per-recipient
	// NotificationEvents for every collected notifier contribution,
	// delivered on the event bus's bounded side lane. Started after the
	// host bridge binds (a notify ctx's `host` serves real calls from
	// the first event) and never stopped — the surface rides the server
	// lifetime, like the routes above.
	startNotifications(ctx);
	// The pipeline is registered FIRST (W1 Task 3): it replaces the naive
	// `X-Sigrun-User` hook — Host/Origin checks, the public surface, the
	// env service token, the setup gate, and method resolution stamp
	// `request.principal` before any route runs.
	registerAuthPipeline(app, ctx);
	registerAuthRoutes(app, ctx);
	registerOnboardingRoutes(app, ctx);
	registerUserRoutes(app, ctx);
	registerProbeRoutes(app, ctx);
	registerMetaRoutes(app, ctx);
	registerMetricsRoutes(app, ctx);
	registerConversationRoutes(app, ctx);
	registerStreamRoutes(app, ctx);
	registerEventRoutes(app, ctx);
	registerSubmissionRoutes(app, ctx);
	registerInteractionRoutes(app, ctx);
	registerFileRoutes(app, ctx);
	registerProviderRoutes(app, ctx);
	registerSettingsRoutes(app, ctx);
	registerExtensionSettingsRoutes(app, ctx);
	// The extension HTTP routes (W5 Task 2, spec §9.2): every collected
	// `routes` contribution mounted at `/v1/ext/<slug>/<path>` behind the
	// web-standard Request/Response adapter — per-route auth rides the
	// pipeline's stage-4b public skip and this module's admin check.
	mountExtensionRoutes(app, ctx);
	// The jobs routes (W4 Task 4, spec §8.4): the access-scoped CRUD +
	// run-now + history surface over `OpenedHarness.jobs` (Task 3's
	// service). Hidden-is-404 per §5.9; `file:`/`ext:` ids are immutable
	// (409 `job_declared`); the history routes answer for retired jobs
	// until retention trims them.
	registerJobRoutes(app, ctx);
	// The core ownership participant (W1 Task 4): registered FIRST so
	// conversations transfer before any extension's `userDeleted`
	// observer runs (W4's jobs participant registers behind it).
	registerCoreOwnershipParticipant(ctx);
	// The jobs ownership participant (W4 Task 3, spec §5.8/§8.3): every
	// `api` job record owned by the deleted user moves to the transferee
	// through `writeJobChange` (a NEW hash — the owner rides the spec
	// identity — so version bumps + a `changedBy:"transfer"` revision,
	// and the follow-up reconcile recreates the executor task). File jobs
	// whose DECLARED owner was the deleted user are not touched here; the
	// next boot's reconciliation warns (the declared owner no longer
	// exists — the job runs ownerless until the file is edited).
	registerJobsOwnershipParticipant(ctx);

	return app;
}
