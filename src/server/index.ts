/**
 * The §5 HTTP server foundation (spec §5, Task 9a).
 *
 * `createServer` builds a Fastify app over one `OpenedHarness` — a thin
 * layer: conversation endpoints serialize pi-durable's native
 * `ConversationView` (via `views.ts`), `GET /v1/meta` reports boot facts.
 * The factory registers routes and returns; it never listens (the deploy
 * entry listens; tests use `app.inject()`).
 *
 * Endpoints in THIS slice: `POST /v1/conversations`, `GET
 * /v1/conversations`, `GET /v1/conversations/:id`, `GET /v1/meta` (T9a);
 * `POST .../submissions` (content-part resolution), `POST .../uploads`, `GET
 * .../files`, `GET .../files/content`, `GET /v1/models` (T9b); `POST
 * .../configure`, `POST .../abort` (T9c-i); `GET .../stream` — the SSE view
 * stream (T9d); `GET /v1/meta` real health aggregation (T9e); `GET/PATCH
 * .../meta` — the session-meta sidebar resource (T10); `GET /healthz` +
 * `GET /readyz` — the deploy probes, liveness vs readiness (T13);
 * `GET /v1/auth/check` — the secret-free per-provider auth readiness
 * report (T6); `GET /v1/commands` — the slash-command catalog (Task 7,
 * pi parity: thin metadata over the endpoints Tasks 4–6 built).
 *
 * NOTE (T9d): the SSE endpoint is exercised over a REAL socket — it hijacks
 * the reply and writes raw frames, which `app.inject()` cannot observe
 * (light-my-request settles only on `end()`). Deploy listens; the SSE tests
 * listen on an ephemeral loopback port.
 *
 * **Conversation listing (durable):** `GET /v1/conversations` scans
 * storage — `scanConversations` over the handle `openHarness` exposes —
 * so the listing is the DURABLE set: conversations other processes or
 * earlier servers created (a restart forgets nothing), and conversations
 * tasks/tools created inside pi-durable (the cron case) all list. The
 * harness itself has no enumeration; the storage scan is authoritative.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	AmbientDoc,
	AmbientOwnersDoc,
	validateAmbient,
	type AmbientRecord,
} from "../harness/ambient.js";
import {
	InteractionDoc,
	InteractionsIndexDoc,
	applyAnswer,
	indexSettled,
	validateInteraction,
	type InteractionAnswer,
	type InteractionRecord,
} from "../harness/interactions.js";
import type {
	AgentChange,
	Conversation,
	ConversationId,
	ConversationView,
	Cursor,
	EntryDraft,
	EntryId,
	InputSubmissionDraft,
	ModelRef,
	ToolRegistration,
	ToolSlot,
} from "@earendil-works/pi-durable";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { SigrunConfig } from "../config.js";
import type { OpenedHarness } from "../harness/boot.js";
import { touchActivity } from "../harness/activity.js";
import { aggregateHealth } from "../harness/health.js";
import { SettingsStore, SettingsValidationError } from "../harness/settings.js";
import { OPENAI_API_KEY_ENV, UnservedModelError } from "../harness/providers/index.js";
import { resolveServedModelRefreshing } from "../harness/providers/refresh.js";
import { DEFAULT_AUTH_KEY } from "../harness/auth.js";
import { SLASH_COMMANDS, type CommandsResponse } from "./commands.js";
import { HARNESS_VERSION, SCHEMA_VERSION } from "./schema-fixture.js";
import {
	resolveWebuiBundle,
	serveWebuiBundle,
	type ContributedWebuiBundle,
} from "./static.js";
import {
	isConfinedPath,
	parseSubmissionInput,
	resolveParts,
} from "./content-parts.js";
import {
	applySessionMetaPatch,
	DEFAULT_SESSION_META,
	SessionMetaDoc,
	validateSessionMetaPatch,
	type SessionMeta,
} from "./session-meta.js";
import {
	serializeConversationView,
	type AmbientList,
	type AuthCheckProvider,
	type AuthCheckResponse,
	type AuthStatus,
	type InteractionAnswered,
	type InteractionList,
	type AbortResponse,
	type ConversationCreateResponse,
	type ConversationImportResponse,
	type ConversationList,
	type ConversationSummary,
	type ConversationViewWire,
	type ConfigureResponse,
	type CompactResponse,
	type FileContentResponse,
	type FileListResponse,
	JSONL_CONTENT_TYPE,
	type MetaResponse,
	type ModelEntry,
	type ModelsResponse,
	type SettingsResponse,
	type SubmissionResponse,
	type UploadResponse,
} from "./views.js";

/** The `thinking` values `configure` accepts (pi-ai `ModelThinkingLevel`). */
const THINKING_LEVELS: readonly string[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

/**
 * The `whenBusy` values a submission accepts (pi-durable `SubmissionDraft`'s
 * full input union, T26a — the §5 client sends "steer"; "followUp" and
 * "reject" are upstream's other busy semantics).
 */
const WHEN_BUSY_MODES: readonly string[] = ["steer", "followUp", "reject"];
/** The validated `whenBusy` type (pi-durable `InputSubmissionDraft`). */
type WhenBusyMode = NonNullable<InputSubmissionDraft["whenBusy"]>;

declare module "fastify" {
	interface FastifyRequest {
		/**
		 * The resolved caller identity (spec §5 owner seam): the trimmed
		 * `X-Sigrun-User` header, or `undefined` when absent/empty. Naive
		 * mode — nothing is verified (trusted-network posture, v1).
		 */
		sigrunUser: string | undefined;
	}
}

/**
 * The agent change every server-side conversation create applies (Task 8b):
 * the boot default model, plus the settings store's sigrun-resolved fields —
 * `defaultTools` (a tool-NAME filter mapped to pi-durable 1.2.0's
 * `AgentChange.modelTools`, the MODEL-OFFERED filter — NOT
 * `AgentChange.tools`, the enabled filter: filtering the offered set never
 * disables a tool for nested calls, the two-layer-filter ruling) and
 * `perModelThinking`'s override for THAT model (applied at create because
 * the model is known here; configure re-applies on every model change).
 * Both come from the STORE (re-read here), so a PATCHed settings file
 * reaches conversations created afterwards without a restart. Applies at
 * CREATES only — configure never re-applies the tool filter, so a
 * `control.addTools`-loaded deferred tool in a LIVE conversation's stored
 * filter is never clobbered (the Task 3 hazard pin).
 */
function storeAgentChange(
	opened: OpenedHarness,
	model: ModelRef | undefined,
): AgentChange {
	const settings = opened.settings.read();
	const filter = settings.defaultTools;
	// `AgentChange.modelTools` takes ToolRegistration OBJECTS (pi-durable's
	// applyChange maps `item.name`), so resolve the store's names against
	// the registry snapshot's composed tool set. An unregistered name in
	// the filter is a config drift: dropped here (resolveAgent's own
	// behavior for an unknown stored name), never a boot failure — but
	// dropped LOUDLY: a user writing `"my-ext-tool"` into the settings
	// file deserves to know the name resolved to nothing.
	let modelTools: ToolRegistration[] | undefined;
	if (filter !== undefined) {
		const registered = new Set(
			opened.registry
				.snapshot()
				.tools()
				.map((entry) => entry.tool.name),
		);
		const dropped = filter.filter((name) => !registered.has(name));
		if (dropped.length > 0) {
			console.warn(
				`settings: dropping unregistered defaultTools name(s): ${dropped.join(", ")} (not in the composed tool set)`,
			);
		}
		modelTools = opened.registry
			.snapshot()
			.tools()
			.filter((entry) => filter.includes(entry.tool.name))
			.map((entry) => entry.tool);
	}
	const thinking =
		model !== undefined
			? settings.perModelThinking?.[`${model.provider}/${model.modelId}`]
			: undefined;
	return {
		...(model === undefined ? {} : { model }),
		// An EMPTY stored array keeps every tool (an empty emit would offer
		// the model nothing — the same guard the panel's none-on note leans
		// on), so the emit is skipped when nothing resolved.
		...(modelTools === undefined || modelTools.length === 0
			? {}
			: { modelTools }),
		// The store validates every level against pi-ai's union, so this
		// unsound-looking cast is checked at every write.
		...(thinking === undefined
			? {}
			: { thinkingLevel: thinking as ModelThinkingLevel }),
	};
}

/** Integer path params for `/v1/conversations/:id`. */
const ID_PARAMS_SCHEMA = {
	type: "object",
	properties: { id: { type: "integer" } },
	required: ["id"],
	additionalProperties: false,
} as const;

/** The settings response over the live store + registry snapshot. */
function settingsResponse(opened: OpenedHarness): SettingsResponse {
	const names = opened.registry
		.snapshot()
		.tools()
		.map((entry) => entry.tool.name);
	// Names may repeat across extensions (RegistrySnapshot.tools); the
	// panel keys checkboxes by name, so dedupe.
	return {
		...opened.settings.read(),
		toolRoster: [...new Set(names)],
	};
}

/** Re-brand a route id as a ConversationId (the branded Id type is a number). */
function conversationId(id: number): ConversationId {
	return id as ConversationId;
}

/** Read one conversation's current view frame; disposes the state handle. */
async function readView(conversation: Conversation) {
	const state = await conversation.viewState(BACKGROUND_CONTEXT);
	const view = serializeConversationView(state.value);
	await state.dispose();
	return view;
}

/**
 * Stamp the resolved caller identity onto a fresh conversation's
 * session-meta doc as `owner` (spec §5 seam; the auth hook's only writer).
 * Undefined (naive mode — no header) is a NO-OP: the doc stays
 * unmaterialized and reads serve the defaults (defaults are free; only a
 * PATCH or a stamped owner writes). A fork's doc carries the parent's
 * copied state (`fork: "current"`), so the caller's identity OVERWRITES
 * the source's.
 */
async function stampSessionOwner(
	conversation: Conversation,
	owner: string | undefined,
): Promise<void> {
	if (owner === undefined) return;
	await conversation.commit(async (tx) => {
		const draft = await tx.doc(SessionMetaDoc, conversation.id);
		draft.owner = owner;
	}, BACKGROUND_CONTEXT);
}

/**
 * Build the conversation's workspace `ExecutionEnv` the same way
 * `Harness.buildEnv` does for tool calls (dist/harness/harness.js:133-139):
 * resolve the committed `agent.cwd` and hand it, with the harness as the
 * doc `read` line, to the boot `envBuilder`. The §5 file/upload/submission
 * endpoints resolve through this — one seam, so a workspace-service swap
 * moves them all at once.
 */
async function conversationEnv(
	opened: OpenedHarness,
	conversation: Conversation,
): Promise<ExecutionEnv> {
	const agent = await conversation.agent(BACKGROUND_CONTEXT);
	const built = await opened.envBuilder(
		{
			conversationId: conversation.id,
			...(agent.cwd === undefined ? {} : { cwd: agent.cwd }),
			read: opened.harness,
		},
		BACKGROUND_CONTEXT,
	);
	// `HarnessOptions.env` types as optional; sigrun always passes one, so a
	// missing env is a boot-invariant violation — fail loud, never null-check.
	if (built === undefined) {
		throw new Error("envBuilder returned no ExecutionEnv");
	}
	return built;
}

/** The upload read cap for `files/content` (binary-safe; 1 MiB). */
const FILE_CONTENT_MAX_BYTES = 1024 * 1024;

/**
 * One `scanConversations` page size for the listing route. Not a client
 * limit — the route walks the continuation cursor to completion (v1 is
 * unpaginated); a larger page only trades per-page round-trips.
 */
const SCAN_PAGE_SIZE = 1_000;

/**
 * Decode a base64 body strictly: Node's `Buffer.from(s, "base64")` is
 * LENIENT (invalid characters are skipped, so `"!!!"` decodes to empty), so
 * uploads validate the alphabet and round-trip — invalid base64 is a client
 * error, never a silent partial decode.
 */
function decodeBase64Strict(value: string): Buffer | undefined {
	const trimmed = value.trim();
	if (trimmed.length === 0 || trimmed.length % 4 !== 0) return undefined;
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(trimmed)) return undefined;
	const bytes = Buffer.from(trimmed, "base64");
	if (bytes.toString("base64") !== trimmed) return undefined;
	return bytes;
}

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

	// Liveness probe (Task 13, spec §4.4 "distinguishes process-up from
	// harness-ready"): 200 ALWAYS once listening — no aggregation, no
	// storage; the dead-simple "the event loop answers" signal. The body is
	// a single Prometheus-exposition gauge line so the endpoint is
	// scrape-compatible (the M1 metrics story — /v1/meta is JSON and cannot
	// be scraped; see the task report's scoping decision). A degraded-but-alive
	// process must NOT fail liveness — the kubelet would restart a process
	// that is merely degraded.
	app.get("/healthz", async (_request, reply) => {
		return await reply
			.code(200)
			.type("text/plain; version=0.0.4; charset=utf-8")
			.send("sigrun_liveness 1\n");
	});

	// Readiness probe (Task 13): 200 only when the harness is GENUINELY ready.
	// The honest v1 derivation, evaluated per request:
	//  1. booted — trivially true while this route answers (the server only
	//     exists after `openHarness` completed); documented, not probed.
	//  2. T9e health not degraded — `health.memory` (the loaded memory
	//     extension's §3 producer, else ok) AND `health.providers`
	//     (aggregated §3 producer statuses). Quarantined extensions do NOT
	//     fail readiness: boot continues by design (spec §3
	//     quarantined-never-aborts), memory falls back to the no-op default,
	//     and no v1 surface hard-depends on a quarantined package —
	//     quarantines surface via /v1/meta `extensions[].status`.
	//  3. a cheap REAL storage read — resolve the reserved root conversation
	//     through the session line (`storage.conversation()` under
	//     `harness.conversation`): one real sqlite record fetch proving the db
	//     file + session answer right now. Chosen as the cheapest real read
	//     available (a snapshot round-trip needs a doc type + token; this is a
	//     single record fetch on an id the server already holds). A closed
	//     harness throws here (assertOpen) — caught, reported as "failed".
	// Not ready ⇒ 503 + a small JSON body naming the failing check (so a
	// `kubectl get endpoints` gap has a story). Ready ⇒ the exposition line,
	// scrape-compatible for the same reason as /healthz.
	app.get("/readyz", async (_request, reply) => {
		const memory = opened.memoryHealth?.() ?? "ok";
		const providers = aggregateHealth(opened.providerHealth);
		let storage: "ok" | "failed";
		try {
			const conversation = await opened.harness.conversation(
				conversationId(rootId),
				BACKGROUND_CONTEXT,
			);
			// undefined = storage answered but the root record is gone — not a
			// harness anyone should route traffic to.
			storage = conversation === undefined ? "failed" : "ok";
		} catch {
			storage = "failed";
		}
		if (memory !== "ok" || providers !== "ok" || storage !== "ok") {
			return await reply.code(503).send({
				ready: false,
				checks: { memory, providers, storage },
			});
		}
		return await reply
			.code(200)
			.type("text/plain; version=0.0.4; charset=utf-8")
			.send("sigrun_readiness 1\n");
	});

	app.get("/v1/meta", async (): Promise<MetaResponse> => {
		// Idle-worker projection (Task 5): re-derived per request (statuses
		// change over the process lifetime); quarantined extensions never
		// registered, so a name miss just yields no workers.
		const workerStatuses = opened.workerStatuses();
		return {
			harnessVersion: HARNESS_VERSION,
			schemaVersion: SCHEMA_VERSION,
			extensions: opened.extensionOutcomes.map((outcome) => {
				const workers = workerStatuses.get(outcome.name);
				return {
					name: outcome.name,
					status: outcome.status,
					...(outcome.error === undefined ? {} : { error: outcome.error }),
					...(workers === undefined || workers.length === 0
						? {}
						: { workers }),
				};
			}),
			// §5 health (Task 9e): pure aggregation over boot-retained §3
			// producers — backup from config presence ("configured" iff set;
			// no runtime backup health signal exists in v1 — the CronJob is
			// external, so "degraded" is deliberately NOT introduced), memory
			// from the memory extension's producer ("ok" for the no-op default
			// — quarantines surface via extensions[].status, never
			// double-reported here), providers aggregated across contributors
			// (empty → "ok").
			health: {
				backup: config.backup === undefined ? "unconfigured" : "configured",
				memory: opened.memoryHealth?.() ?? "ok",
				providers: aggregateHealth(opened.providerHealth),
			},
			// §5 capabilities: backup affordances exist iff a target is
			// configured (Task 11 — the badge, not an error, when absent).
			capabilities: {
				backup: config.backup !== undefined,
			// §4.1/§6 channels: the SELECTED bundle's name ("webui" for the
			// built-in default and explicit paths; a contributed selection's own
			// name) exactly while the channel bundle is mounted; an API-only
			// deploy (gate off or absent default) reports [].
			channels:
				webuiBundle === undefined ? [] : [webuiBundle.channel],
			},
			// The seam inventory: declaration-derived, no doc reads.
			seam: {
				interactions: [...opened.seamKinds]
					.filter(([, kinds]) => (kinds.interaction?.length ?? 0) > 0)
					.map(([name, kinds]) => ({
					extension: name,
					kinds: [...(kinds.interaction ?? [])],
				})),
				ambient: [...opened.seamKinds]
					.filter(([, kinds]) => (kinds.ambient?.length ?? 0) > 0)
					.map(([name, kinds]) => ({
					extension: name,
					keys: [...(kinds.ambient ?? [])],
				})),
			},
			// Boot-merge collisions (build-and-webui Task 6): name collisions
			// among extension-contributed webui bundles, plus the provider-merge
			// sink (retained since Task 6 of the provider plan but never read —
			// the same field carries both). Last-registered-wins everywhere; the
			// record is operator visibility, never an error.
			collisions: {
				webui: opened.webuiBundleCollisions,
				providers: opened.providerCollisions,
			},
		};
	});

	// The slash-command catalog (Task 7): the thin metadata list the
	// composer's `/` menu consumes — name, description, args hint, and the
	// endpoint each command drives. A boot constant (like /v1/models), so a
	// client may cache it. See `commands.ts` for the scope rulings.
	app.get("/v1/commands", async (): Promise<CommandsResponse> => {
		return { commands: [...SLASH_COMMANDS.values()] };
	});

	app.post(
		"/v1/conversations",
		async (request, reply): Promise<ConversationCreateResponse> => {
			// T9a create takes no fields (model/thinking changes arrive with
			// the configure endpoint, T9c): an absent body is valid, an
			// object with any field is a fail-loud 400.
			const body: unknown = request.body;
			if (
				body !== undefined &&
				(typeof body !== "object" ||
					Object.keys(body as Record<string, unknown>).length > 0)
			) {
				return await reply.code(400).send({ error: "invalid_body" });
			}
			const conversation = await opened.harness.createConversation(
				{
					ownership: { kind: "ownerless" },
					// A conversation with no agent model cannot generate
					// (no_model): server-created conversations start on the
					// boot default model, like the root conversation, and
					// carry the store's defaultTools/perModelThinking (Task
					// 8b) — re-read per create, so PATCHes reach new
					// conversations without a restart.
					agent: storeAgentChange(opened, opened.defaultModel),
				},
				BACKGROUND_CONTEXT,
			);
			// The identity seam: stamp the caller as owner when the request
			// carried one (naive mode — no header, no write).
			await stampSessionOwner(conversation, request.sigrunUser);
			const view = await readView(conversation);
			return await reply.code(201).send({ id: conversation.id, view });
		},
	);

	// Auth readiness (T6, spec §6.4: "The API never accepts or returns
	// credentials"): a SECRET-FREE report. The response carries ONLY a
	// per-provider status (+ optional tracker detail) — no env values, no
	// key material, no hints beyond the status itself. The status is a
	// pure synchronous derivation over boot-retained state (same
	// discipline as /v1/meta), per provider in catalog order (provider
	// plugins Task 6: enumeration is over PROVIDERS — `getProviders()` —
	// not models, so an empty-catalog boot contribution still appears):
	//  1. readiness tracker registered by the owning contributor
	//     (`contribution.readiness`): reported verbatim — the three-state
	//     vocabulary `not_configured` (no credential resolved — an
	//     unconfigured optional plugin, not a degraded process) |
	//     `degraded` (configured, last refresh failed) | `ready` (refresh
	//     succeeded / static catalog), plus its optional `detail`.
	//  2. contributor-owned WITHOUT a tracker: the legacy producer mapping
	//     is preserved — "ok" → `ready`, "degraded" → `invalid` (the §3
	//     union is exactly ok | degraded; "degraded" is the known-bad
	//     signal). A producer is per-contributor, not per-provider, so
	//     every provider a contributor owns shares its status. No producer
	//     → `not_ready` (nothing to verify).
	//  3. env-degenerate provider (no contributor owns it — the collector's
	//     ownership map has no entry): the legacy env-presence mapping is
	//     preserved — `ready` iff a key resolves (`auth.json` `"default"`
	//     or the provider's own entry, or a non-empty `OPENAI_API_KEY` in
	//     the boot-retained provider env), else `not_ready`. (The
	//     degenerate provider reports §3 health "ok" by absence, so key
	//     presence is the honest readiness check for it; the three-state
	//     vocabulary applies to plugin trackers only.)
	app.get("/v1/auth/check", async (): Promise<AuthCheckResponse> => {
		const producersByName = new Map(
			opened.providerHealth.map((producer) => [producer.name, producer]),
		);
		const providers: AuthCheckProvider[] = [];
		for (const { id: providerId } of opened.models.getProviders()) {
			let status: AuthStatus;
			let detail: string | undefined;
			const tracker = opened.providerReadiness.get(providerId);
			if (tracker !== undefined) {
				// Priority 1: the owning contributor's three-state tracker,
				// consulted per request (plugin-owned state — never a boot
				// snapshot).
				const readiness = tracker();
				status = readiness.status;
				detail = readiness.detail;
			} else {
				const owner = opened.providerOwnership.get(providerId);
				if (owner !== undefined) {
					// Priority 2: legacy producer mapping, preserved for
					// tracker-less contributors.
					const producer = producersByName.get(owner);
					status =
						producer === undefined
							? "not_ready"
							: producer.health() === "ok"
								? "ready"
								: "invalid";
				} else {
					// Priority 3: ruling 6 — the degenerate provider's key resolves
					// auth.json (the "default" magic key or the provider's own
					// entry) BEFORE the OPENAI_API_KEY env fallback. Presence
						// only — key material never leaves the store. A malformed
						// auth file marks the provider not_ready rather than failing
						// the route (boot-time fail-loud covers the genuinely-broken
						// deploy).
					let storedKey = false;
					try {
						const authFile = opened.auth.read();
						storedKey =
							authFile[DEFAULT_AUTH_KEY]?.apiKey !== undefined ||
							authFile[providerId]?.apiKey !== undefined;
					} catch {
						storedKey = false;
					}
					status =
						storedKey ||
						(opened.providerEnv[OPENAI_API_KEY_ENV] ?? "").trim() !== ""
							? "ready"
							: "not_ready";
				}
			}
			providers.push(
				detail === undefined
					? { provider: providerId, status }
					: { provider: providerId, status, detail },
			);
		}
		return { providers };
	});

	app.get("/v1/conversations", async (): Promise<ConversationList> => {
		// Durable enumeration (Task 3): the storage scan is authoritative —
		// conversations this process never created (before a restart, in
		// another process, or by tasks/tools inside pi-durable) all list.
		// `scanConversations` pages ascending by id (creation order); this
		// route is unpaginated v1, so one page at a generous limit covers a
		// deployment-scale set, and the loop below walks the continuation
		// cursor to completion so nothing truncates silently.
		const conversations: ConversationSummary[] = [];
		let cursor: Cursor | undefined = undefined;
		do {
			const page = await opened.storage.scanConversations(
				{ order: "ascending" },
			SCAN_PAGE_SIZE,
			cursor,
			BACKGROUND_CONTEXT,
			);
			for (const record of page.items) {
				const conversation = await opened.harness.conversation(
					record.id,
					BACKGROUND_CONTEXT,
				);
				// Unresolvable ids (dropped elsewhere) are skipped, not listed.
				if (conversation === undefined) continue;
				const view = await readView(conversation);
				// The session-meta owner rides the summary when stamped (Task
				// 2's doc; defaults serve nothing — no owner key when unset),
				// and so do the sidebar fields (UI refresh A1): the display
				// name (user name over auto name), the activity stamp, and the
				// archive/pin flags — one request, no per-row meta fetch.
				const meta = await opened.harness.snapshot(
					SessionMetaDoc,
					conversation.id,
					BACKGROUND_CONTEXT,
				);
				const name = meta?.name ?? meta?.autoName;
				conversations.push({
					id: conversation.id,
					root: conversation.id === rootId,
					entryCount: view.entries.length,
					...(meta?.owner === undefined ? {} : { owner: meta.owner }),
					...(name === undefined ? {} : { name }),
					...(meta?.lastActivityAt === undefined
						? {}
						: { lastActivityAt: meta.lastActivityAt }),
					// Fork lineage from the durable record (the scan page item);
					// a root or plainly created conversation has none.
					...(record.parent === undefined
						? {}
						: {
								parent: {
									id: record.parent.conversationId,
									at: record.parent.at,
								},
							}),
					archived: meta?.archived ?? false,
					pinned: meta?.pinned ?? false,
				});
			}
			cursor = page.next;
		} while (cursor !== undefined);
		return { conversations };
	});

	app.get(
		"/v1/conversations/:id",
		{ schema: { params: ID_PARAMS_SCHEMA } },
		async (request, reply) => {
			const { id } = request.params as { id: number };
			const conversation = await opened.harness.conversation(
				conversationId(id),
				BACKGROUND_CONTEXT,
			);
			if (conversation === undefined) {
				return await reply
					.code(404)
					.send({ error: "conversation_not_found" });
			}
			return readView(conversation);
		},
	);

	// SSE view stream (T9d, spec §5 "Views + watch frames over SSE"): one
	// Server-Sent Events stream per conversation, hand-rolled over `reply.raw`
	// (no @fastify/sse dependency). Event shape: `event: snapshot` with the
	// wire view on connect, then `event: view` per watch revision — every
	// frame is a FULL immutable ConversationView, so a reconnect's fresh
	// snapshot subsumes any missed frame (the spec's reconnect contract
	// collapses to "fresh snapshot on (re)connect"; see the Appendix C
	// named-verification record). `Last-Event-ID` is therefore accepted and
	// deliberately ignored. Heartbeat: a `: ping` comment every 15s (proxy/
	// LB idle-timeout survival). Lifecycle: exactly one owner (`finish` below)
	// stops the watch and clears the interval on client disconnect or watch
	// termination.
	app.get(
		"/v1/conversations/:id/stream",
		{ schema: { params: ID_PARAMS_SCHEMA } },
		async (request, reply) => {
			const { id } = request.params as { id: number };
			const conversation = await opened.harness.conversation(
				conversationId(id),
				BACKGROUND_CONTEXT,
			);
			if (conversation === undefined) {
				// Before the SSE upgrade: plain JSON 404, the shared pattern.
				return await reply
					.code(404)
					.send({ error: "conversation_not_found" });
			}
			// Acquire the watch BEFORE hijacking: an acquisition failure then
			// lands on Fastify's fail-loud 500 path — a hijacked stream has no
			// error event. `value` is the acquisition revision (the snapshot
			// source); frames published between here and start() are held by the
			// watch's bounded pending delivery, so nothing is lost.
			const watch = await conversation.watch(BACKGROUND_CONTEXT);
			reply.hijack();
			const raw = reply.raw;
			raw.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				"connection": "keep-alive",
				"x-accel-buffering": "no",
			});
			raw.flushHeaders();
			// Socket-level write errors after teardown have no consumer (the
			// close path owns teardown); swallow them so a mid-write disconnect
			// cannot crash the process with an unhandled 'error' event.
			raw.on("error", () => {});
			let nextId = 1;
			const send = (event: string, view: ConversationViewWire): void => {
				// Single data line: JSON.stringify escapes newlines in strings.
				raw.write(
					`id: ${nextId++}\nevent: ${event}\ndata: ${JSON.stringify(view)}\n\n`,
				);
			};
			let finished = false;
			const heartbeat = setInterval(() => {
				raw.write(": ping\n\n");
			}, 15_000);
			// The single cleanup owner: client disconnect (response close =
			// socket termination — NOT `request.raw.on("close")`, which on
			// Node 26 fires at request-message completion, i.e. immediately for
			// a bodyless GET) or watch termination (`watch.closed`). The flag
			// makes it exactly-once even though both paths can race.
			const finish = (fromWatchEnd: boolean): void => {
				if (finished) return;
				finished = true;
				clearInterval(heartbeat);
				if (!fromWatchEnd) {
					// stop() is idempotent upstream; fire-and-forget because the
					// stream is ending regardless and a stop() rejection after a
					// dead socket has no consumer to fail loud to.
					void watch.stop().catch(() => {});
				}
				raw.end();
			};
			raw.on("close", () => finish(false));
			// Upstream resolves `closed` with a WatchEnd for every terminal
			// state (failures included); a rejection would be an upstream
			// contract violation — catch it so one stream's anomaly ends that
			// stream instead of taking the process down as an unhandled
			// rejection.
			void watch.closed.then(
				() => finish(true),
				() => finish(true),
			);
			// The client may have disconnected while the watch was being
			// acquired (before the close listener existed): `destroyed` covers
			// that window — stop the just-acquired watch instead of leaking it.
			if (raw.destroyed) {
				finish(false);
				return;
			}
			// Snapshot FIRST (from the acquisition revision), then install the
			// listener — pending frames flow after the snapshot because start
			// never invokes the listener inline.
			send("snapshot", serializeConversationView(watch.value));
			watch.start(async (value) => {
				if (finished) return; // the stream is over; drop the frame
				send("view", serializeConversationView(value));
			});
		},
	);

	// Submissions: content-part resolution + upstream idempotence (T9b);
	// `whenBusy` pass-through + memory-wiring submit (T26a).
	// Conversation resolution is storage-backed (`harness.conversation`),
	// so any durable id works — the listing's scan sees it too (Task 3).
	app.post(
		"/v1/conversations/:id/submissions",
		{ schema: { params: ID_PARAMS_SCHEMA } },
		async (request, reply): Promise<SubmissionResponse> => {
			const { id } = request.params as { id: number };
			const conversation = await opened.harness.conversation(
				conversationId(id),
				BACKGROUND_CONTEXT,
			);
			if (conversation === undefined) {
				return await reply
					.code(404)
					.send({ error: "conversation_not_found" });
			}
			const body = request.body as Record<string, unknown> | undefined;
			if (
				body === undefined ||
				typeof body !== "object" ||
				Array.isArray(body)
			) {
				return await reply.code(400).send({ error: "invalid_body" });
			}
			const parsed = parseSubmissionInput(body.input);
			if (!parsed.ok) {
				return await reply.code(400).send({ error: "invalid_input" });
			}
			// Spec §2/§3 binding contract (Review Focus #2): a conversation
			// pinned to an unserved model fails explicitly AT SUBMIT — 4xx with
			// the available ids — never a silent fallback, and never a settled
			// no_model run surfaced only later. Resolution goes through the
			// refresh-on-miss wrapper (provider plugins Task 4): ONE bounded
			// refresh of the named provider + re-resolve on the miss, so a
			// model gained upstream since the last interval tick is
			// immediately usable; still absent → the UnservedModelError
			// carrying the catalog maps to 400. The auto-namer's resolution
			// deliberately stays on bare `requireServedModel` (background
			// lane — no refresh there).
			const agent = await conversation.agent(BACKGROUND_CONTEXT);
			try {
				if (agent.model !== undefined) {
					await resolveServedModelRefreshing(opened.models, agent.model);
				}
			} catch (error) {
				if (error instanceof UnservedModelError) {
					return await reply.code(400).send({
						error: "unserved_model",
						model: `${error.ref.provider}/${error.ref.modelId}`,
						available: error.available,
					});
				}
				throw error;
			}
			const requestId =
				body.requestId === undefined ? undefined : String(body.requestId);
			// T26a: `whenBusy` is the steer affordance (spec §7 item 3) — validate
			// it against pi-durable's union and pass it through; unknown values
			// are a client error, never a silent default.
			const whenBusy = body.whenBusy;
			if (
				whenBusy !== undefined &&
				(typeof whenBusy !== "string" || !WHEN_BUSY_MODES.includes(whenBusy))
			) {
				return await reply
					.code(400)
					.send({ error: "invalid_field", field: "whenBusy" });
			}
			// Resolve path-parts to inline content NOW, against the live
			// workspace (Review Focus #1: missing paths become explicit error
			// parts; other workspace failures throw → Fastify 500, fail-loud).
			const env = await conversationEnv(opened, conversation);
			const content = await resolveParts(
				parsed.parts,
				env,
				BACKGROUND_CONTEXT,
			);
			const draft: InputSubmissionDraft = {
				type: "input",
				content,
				...(requestId === undefined ? {} : { requestId }),
				...(whenBusy === undefined
					? {}
					: { whenBusy: whenBusy as WhenBusyMode }),
			};
			// T26a Fix B: submit through the memory extension's wiring when one
			// is loaded — its submit binds the conversation as the memory_recall
			// source at the submit boundary (degenerate.js). No memory wiring →
			// submit directly (the no-op default carries no submit).
			const submission =
				opened.memorySubmit === undefined
					? await conversation.submit(draft, BACKGROUND_CONTEXT)
					: await opened.memorySubmit(conversation, draft, BACKGROUND_CONTEXT);
			// Admission stamps activity (UI refresh A1): the sidebar's activity
			// sort must move the moment a prompt lands — before the run settles.
			await touchActivity(
				opened.harness,
				conversation.id,
				opened.now,
				BACKGROUND_CONTEXT,
			);
			// v1 waits for settlement server-side (the watch stream is T9d);
			// `wait()` resolves with the settled record either way.
			const settled = await submission.wait(BACKGROUND_CONTEXT);
			return await reply.code(202).send(settled);
		},
	);

	// Configure: change the conversation's model and/or thinking level (T9c-i).
	// v1 accepts EXACTLY `model` + `thinking` — any other key is a fail-loud
	// 400 (the agent's other knobs are not wire surface yet).
	app.post(
		"/v1/conversations/:id/configure",
		{ schema: { params: ID_PARAMS_SCHEMA } },
		async (request, reply): Promise<ConfigureResponse> => {
			const { id } = request.params as { id: number };
			const conversation = await opened.harness.conversation(
				conversationId(id),
				BACKGROUND_CONTEXT,
			);
			if (conversation === undefined) {
				return await reply
					.code(404)
					.send({ error: "conversation_not_found" });
			}
			const body = request.body as Record<string, unknown> | undefined;
			if (
				body === undefined ||
				body === null ||
				typeof body !== "object" ||
				Array.isArray(body)
			) {
				return await reply.code(400).send({ error: "invalid_body" });
			}
			const unknownKey = Object.keys(body).find(
				(key) => key !== "model" && key !== "thinking",
			);
			if (unknownKey !== undefined) {
				return await reply
					.code(400)
					.send({ error: "invalid_field", field: unknownKey });
			}
			const model = body.model;
			const thinking = body.thinking;
			if (model === undefined && thinking === undefined) {
				// A configure that changes nothing is a client error, not a no-op.
				return await reply.code(400).send({ error: "invalid_body" });
			}
			// `model` is `"provider/modelId"`, split on the FIRST `/` (a modelId
			// may itself contain slashes); both parts must be non-empty.
			let parsedModel: ModelRef | undefined;
			if (model !== undefined) {
				if (typeof model !== "string" || !model.includes("/")) {
					return await reply
						.code(400)
						.send({ error: "invalid_field", field: "model" });
				}
				const slash = model.indexOf("/");
				const provider = model.slice(0, slash);
				const modelId = model.slice(slash + 1);
				if (provider.length === 0 || modelId.length === 0) {
					return await reply
						.code(400)
						.send({ error: "invalid_field", field: "model" });
				}
				parsedModel = { provider, modelId };
			}
			if (
				thinking !== undefined &&
				(typeof thinking !== "string" ||
					!THINKING_LEVELS.includes(thinking))
			) {
				return await reply
					.code(400)
					.send({ error: "invalid_field", field: "thinking" });
			}
			// perModelThinking (Task 8b): a model change re-applies the store's
			// override for the NEW model unless the request pins `thinking` —
			// the map is the deployment default, the explicit field the caller's
			// win. Read from the store here, so a PATCH reaches later configures.
			const storeThinking =
				parsedModel === undefined
					? undefined
					: opened.settings.read().perModelThinking?.[
							`${parsedModel.provider}/${parsedModel.modelId}`
					];
			await conversation.configure(
				{
					...(parsedModel === undefined ? {} : { model: parsedModel }),
					...(thinking !== undefined
						? { thinkingLevel: thinking as ModelThinkingLevel }
						: storeThinking === undefined
							? {}
							: { thinkingLevel: storeThinking as ModelThinkingLevel }),
				},
				BACKGROUND_CONTEXT,
			);
			// Read the agent back and project the configured surface only —
			// resolved extensions/tools/sections stay server-side.
			const agent = await conversation.agent(BACKGROUND_CONTEXT);
			return {
				...(agent.model === undefined ? {} : { model: agent.model }),
				thinkingLevel: agent.thinkingLevel,
			};
		},
	);

	// Abort: withdraw/settle the conversation's active submission (T9c-i).
	// `inspect()` is the read-only union of placed run inputs and queued inbox
	// items (all conversations); filtered to this conversation, the LOWEST id
	// is the active one — anything queued behind a busy conversation was
	// admitted later and has a higher id.
	app.post(
		"/v1/conversations/:id/abort",
		{ schema: { params: ID_PARAMS_SCHEMA } },
		async (request, reply): Promise<AbortResponse> => {
			const { id } = request.params as { id: number };
			const conversation = await opened.harness.conversation(
				conversationId(id),
				BACKGROUND_CONTEXT,
			);
			if (conversation === undefined) {
				return await reply
					.code(404)
					.send({ error: "conversation_not_found" });
			}
			const inspection = await opened.harness.inspect(BACKGROUND_CONTEXT);
			// Lowest live id = oldest admitted = the placed run input over later-
			// queued inbox items. reduce() with a first-element seed is ordering-
			// independent (a future pi-durable inspect() ordering change cannot
			// silently target the wrong submission); empty → undefined.
			const active = inspection.submissions
				.filter((s) => s.conversationId === conversation.id)
				.reduce<(typeof inspection.submissions)[number] | undefined>(
					(min, s) => (min === undefined || s.id < min.id ? s : min),
					undefined,
				);
			if (active === undefined) {
				return await reply
					.code(404)
					.send({ error: "no_active_submission" });
			}
			const result = await opened.harness.abortSubmission(
				active.id,
				BACKGROUND_CONTEXT,
				conversation.id,
			);
			// `not_found` means the submission's record vanished between `inspect`
			// and `abort` — the conversation is no longer busy, so the honest answer
			// is the same as nothing-active.
			if (result === "not_found") {
				return await reply
					.code(404)
					.send({ error: "no_active_submission" });
			}
			// `already_placed`/`settled` are still 200: abort is idempotent and
			// the body reports which state the submission was found in.
			return { result, submissionId: active.id };
		},
	);

	// ─── Interaction seam (docs/approval-ux-seams.md) ────────────────────
	// One generic surface shared by every extension: pending interactions
	// (list) and answers (the ONE generic route). Resolution semantics stay
	// extension-owned — the route only writes the envelope's answer field.

	/** The list route's wire record: envelope + body + details, unmodified. */
	app.get(
		"/v1/conversations/:id/interactions",
		{ schema: { params: ID_PARAMS_SCHEMA } },
		async (request, reply): Promise<InteractionList> => {
			const { id } = request.params as { id: number };
			const convId = conversationId(id);
			// Absent conversation → empty list (the ambient list's convention:
			// a channel polling a torn-down conversation must not error).
			const index = await opened.harness.snapshot(
				InteractionsIndexDoc,
				BACKGROUND_CONTEXT,
			);
			const pending = index?.pending[String(convId)] ?? [];
			const records: InteractionRecord[] = [];
			for (const callId of pending) {
				const record = await opened.harness.snapshot(
					InteractionDoc,
					convId,
					callId,
					BACKGROUND_CONTEXT,
				);
				if (record !== undefined && record.status === "pending") {
					records.push(record);
				}
			}
			return { interactions: records };
		},
	);

	// The ONE generic answer route: writes `answer` into the envelope with
	// first-answer-wins inside the commit. 404 for unknown/not-pending;
	// 400 for a malformed answer. `by` is "human" (the only v1 caller).
	app.post(
		"/v1/conversations/:id/interactions/:callId/answer",
		async (request, reply): Promise<InteractionAnswered> => {
			const { id, callId } = request.params as {
				id: number;
				callId: string;
			};
			const conversation = await opened.harness.conversation(
				conversationId(id),
				BACKGROUND_CONTEXT,
			);
			if (conversation === undefined) {
				return await reply
					.code(404)
					.send({ error: "conversation_not_found" });
			}
			const body: unknown = request.body;
			const answer = {
				...(undefined as unknown as InteractionAnswer),
			} as {
				ids?: string[];
				values?: Record<string, string | number | boolean>;
				text?: string;
			};
			if (body !== undefined && body !== null) {
				if (typeof body !== "object" || Array.isArray(body)) {
					return await reply.code(400).send({ error: "invalid_body" });
				}
				const b = body as Record<string, unknown>;
				const known = new Set(["ids", "values", "text"]);
				const unknownKey = Object.keys(b).find((k) => !known.has(k));
				if (unknownKey !== undefined) {
					return await reply
						.code(400)
						.send({ error: "invalid_field", field: unknownKey });
				}
				if (b.ids !== undefined) {
					if (
						!Array.isArray(b.ids) ||
						b.ids.some((v) => typeof v !== "string")
					) {
						return await reply
							.code(400)
							.send({ error: "invalid_body" });
					}
					answer.ids = b.ids as string[];
					// (mutable local; the wire type stays readonly)
				}
				if (b.values !== undefined) {
					if (typeof b.values !== "object" || b.values === null) {
						return await reply.code(400).send({ error: "invalid_body" });
					}
					const values: Record<string, string | number | boolean> = {};
					for (const [k, v] of Object.entries(
						b.values as Record<string, unknown>,
					)) {
						if (
							typeof v !== "string" &&
							typeof v !== "number" &&
							typeof v !== "boolean"
						) {
							return await reply
								.code(400)
								.send({ error: "invalid_field", field: `values.${k}` });
						}
						values[k] = v;
					}
					answer.values = values;
				}
				if (b.text !== undefined) {
					if (typeof b.text !== "string") {
						return await reply.code(400).send({ error: "invalid_body" });
					}
					answer.text = b.text;
				}
			}
			// The commit returns a plain outcome; reply shaping happens
			// AFTER the commit (a Fastify reply must never travel through
			// the harness mutation line).
			const committed = await conversation.commit(async (tx) => {
				const draft = await tx.doc(
					InteractionDoc,
					conversation.id,
					callId,
					callId,
				);
				// Unknown callId: the doc materializes empty — detect via kind
				// never having been seeded (an empty seed has kind "").
				if (draft.kind === "") return { found: false } as const;
				const applied = applyAnswer(draft, answer, "human", Date.now());
				if (!applied) return { found: true, applied: false } as const;
				// NEVER re-read a mutated draft field (even before the next
				// await): reading a newly-set nested value off the tracked
				// draft trips chord's settled-overlay check. The response
				// projects the INPUT answer — identical to what was written.
				const index = await tx.doc(InteractionsIndexDoc);
				indexSettled(index, conversation.id, callId);
				return {
					found: true,
					applied: true,
					answer,
				} as const;
			}, BACKGROUND_CONTEXT);
			if (!committed.found) {
				return await reply.code(404).send({ error: "no_such_interaction" });
			}
			if (!committed.applied) {
				return await reply.code(404).send({ error: "not_pending" });
			}
			return {
				callId,
				status: "answered",
				answer: committed.answer,
			};
		},
	);

	// ─── Ambient seam ────────────────────────────────────────────────────
	// The conversation's ambient surfaces, replacement-state reads.

	app.get(
		"/v1/conversations/:id/ambient",
		{ schema: { params: ID_PARAMS_SCHEMA } },
		async (request, reply): Promise<AmbientList> => {
			const { id } = request.params as { id: number };
			const convId = conversationId(id);
			const index = await opened.harness.snapshot(
				AmbientOwnersDoc,
				BACKGROUND_CONTEXT,
			);
			const keys = Object.keys(index?.owners ?? {});
			const surfaces: AmbientRecord[] = [];
			for (const key of keys) {
				const surface = await opened.harness.snapshot(
					AmbientDoc,
					convId,
					key,
					BACKGROUND_CONTEXT,
				);
				// A surface owned but never written in THIS conversation is
				// absent (owner registration is session-global; surfaces are
				// conversation-scoped).
				if (surface !== undefined && surface.body !== undefined) {
					surfaces.push(surface);
				}
			}
			return { ambient: surfaces };
		},
	);

	// Manual compaction: `POST .../compact` (Task 4, pi parity).
	// `Conversation.compact(instructions)` (pi-durable's own manual-
	// compaction admission, dist/harness/types.d.ts) creates a
	// conversation-owned durable compaction task with `reason: "manual"`:
	// it compacts even when the conversation is idle — a user's explicit
	// intent — and places its summary through a write submission (at the
	// next boundary when busy). Manual compaction ignores the policy's
	// `enabled` (upstream doc: "manual compaction ignores `enabled`");
	// `compact()` resumes the scheduler itself. The task id is handed back —
	// the SSE stream carries the `pi.compaction` entry when the summary
	// lands.
	app.post(
		"/v1/conversations/:id/compact",
		{ schema: { params: ID_PARAMS_SCHEMA } },
		async (request, reply): Promise<CompactResponse> => {
			const { id } = request.params as { id: number };
			const conversation = await opened.harness.conversation(
				conversationId(id),
				BACKGROUND_CONTEXT,
			);
			if (conversation === undefined) {
				return await reply
					.code(404)
					.send({ error: "conversation_not_found" });
			}
			// Absent body is valid (no instructions); an object may carry
			// ONLY `instructions` — any other key is a fail-loud 400, the
			// configure convention.
			const body: unknown = request.body;
			let instructions: string | undefined;
			if (body !== undefined && body !== null) {
				if (typeof body !== "object" || Array.isArray(body)) {
					return await reply.code(400).send({ error: "invalid_body" });
				}
				const record = body as Record<string, unknown>;
				const unknownKey = Object.keys(record).find(
					(key) => key !== "instructions",
				);
				if (unknownKey !== undefined) {
					return await reply
						.code(400)
						.send({ error: "invalid_field", field: unknownKey });
				}
				if (
					record.instructions !== undefined &&
					typeof record.instructions !== "string"
				) {
					return await reply
						.code(400)
						.send({ error: "invalid_field", field: "instructions" });
				}
				instructions =
					record.instructions === undefined || record.instructions === ""
						? undefined
						: record.instructions;
			}
			const taskId = await conversation.compact(
				instructions,
				BACKGROUND_CONTEXT,
			);
			// 202: like submissions, the compaction is admitted, not settled —
			// the task runs asynchronously and its summary lands as a view
			// revision (the SSE stream).
			return await reply.code(202).send({ taskId });
		},
	);

	// Fork: a history fork at one visible entry (Task 5a, spec §5 session
	// management). `at` is the LAST entry id the fork keeps; absent = the
	// newest entry (resolved through the entries query — never 0, which is
	// not a real entry id). The fork inherits the parent's agent model and
	// the same ownerless ownership the create route uses; the response is
	// the create shape: 201 `{id, view}`.
	app.post(
		"/v1/conversations/:id/fork",
		{ schema: { params: ID_PARAMS_SCHEMA } },
		async (
			request,
			reply,
		): Promise<ConversationCreateResponse> => {
			const { id } = request.params as { id: number };
			const conversation = await opened.harness.conversation(
				conversationId(id),
				BACKGROUND_CONTEXT,
			);
			if (conversation === undefined) {
				return await reply
					.code(404)
					.send({ error: "conversation_not_found" });
			}
			// Absent body is valid (`at` defaults to the newest entry); the
		// object may carry ONLY `at` — the compact/configure convention.
			const body: unknown = request.body;
			let at: number | undefined;
			if (body !== undefined && body !== null) {
				if (typeof body !== "object" || Array.isArray(body)) {
					return await reply.code(400).send({ error: "invalid_body" });
				}
				const record = body as Record<string, unknown>;
				const unknownKey = Object.keys(record).find((key) => key !== "at");
				if (unknownKey !== undefined) {
					return await reply
						.code(400)
						.send({ error: "invalid_field", field: unknownKey });
				}
				if (
					record.at !== undefined &&
					typeof record.at !== "number"
				) {
					return await reply
						.code(400)
						.send({ error: "invalid_field", field: "at" });
				}
				at = record.at;
			}
			if (at === undefined) {
				// The entries query is newest-first: the first item of the first
				// page is the newest entry. An empty page means there is nothing
				// to fork — the parent conversation has no history at all.
				const page = await conversation.entries(
					{},
					1,
					undefined,
					BACKGROUND_CONTEXT,
				);
				if (page.items.length === 0) {
					return await reply.code(400).send({ error: "empty_conversation" });
				}
				at = page.items[0].id;
			} else {
				// Validate `at` against the parent's own history: `fork()` accepts
				// any EntryId, but an id this conversation never had is a client
				// error, not a silent empty fork.
				const page = await conversation.entries(
					{ maxEntryId: at as EntryId },
					1,
					undefined,
					BACKGROUND_CONTEXT,
				);
				const newest = page.items[0];
				if (newest === undefined || newest.id !== at) {
					return await reply
						.code(400)
						.send({ error: "invalid_field", field: "at" });
				}
			}
			// The fork inherits the parent's agent model — read the resolved
			// agent, fall back to the boot default like create.
			const agent = await conversation.agent(BACKGROUND_CONTEXT);
			const fork = await conversation.fork(
				at as EntryId,
				{
					ownership: { kind: "ownerless" },
					agent: { model: agent.model ?? opened.defaultModel },
				},
				BACKGROUND_CONTEXT,
			);
			// The fork's sidebar identity (UI refresh A2): the copied meta doc
			// carries the source's name/autoName and the namer's attempt count;
			// ONE commit drops all three (a fork is a new conversation, not the
			// source's name — and it starts naming-fresh: inheriting an exhausted
			// attempt count would make the fork forever unnameable, the plan's
			// Task D deviation (c)), re-seeds it with "<source display name> (fork)"
			// as its AUTO name when the source had one, and stamps activity so
			// the fresh fork sorts where it happened.
			const sourceMeta = await opened.harness.snapshot(
				SessionMetaDoc,
				conversation.id,
				BACKGROUND_CONTEXT,
			);
			const sourceName = sourceMeta?.name ?? sourceMeta?.autoName;
			await fork.commit(async (tx) => {
				const draft = await tx.doc(SessionMetaDoc, fork.id);
				delete draft.name;
				delete draft.autoName;
				delete draft.autoNameAttempts;
				if (sourceName !== undefined) draft.autoName = `${sourceName} (fork)`;
				draft.lastActivityAt = opened.now().toISOString();
			}, BACKGROUND_CONTEXT);
			// The fork's identity is the CALLER's, not the source's: the doc
			// copied the parent's owner ("current" fork semantics), the stamp
			// overwrites it; no header → the copy stands.
			await stampSessionOwner(fork, request.sigrunUser);
			const view = await readView(fork);
			return await reply.code(201).send({ id: fork.id, view });
		},
	);

	// Export: the conversation's history as JSONL (Task 5b) — pi's portable
	// format. One entry JSON object per line (the same per-entry
	// serialization the view serves), OLDEST-first (the reverse of the
	// newest-first entries query), so an import replays the transcript in
	// order. All history pages, not just the active view.
	app.get(
		"/v1/conversations/:id/export",
		{ schema: { params: ID_PARAMS_SCHEMA } },
		async (request, reply) => {
			const { id } = request.params as { id: number };
			const conversation = await opened.harness.conversation(
				conversationId(id),
				BACKGROUND_CONTEXT,
			);
			if (conversation === undefined) {
				return await reply
					.code(404)
					.send({ error: "conversation_not_found" });
			}
			const lines: string[] = [];
			let cursor: Cursor | undefined;
			// Newest-first pages accumulate reversed; emit oldest-first.
			const collected: unknown[] = [];
			do {
				const page = await conversation.entries(
					{},
					200,
					cursor,
					BACKGROUND_CONTEXT,
				);
				collected.push(...page.items);
				cursor = page.next;
			} while (cursor !== undefined);
			for (let i = collected.length - 1; i >= 0; i--) {
				lines.push(JSON.stringify(collected[i]));
			}
			return await reply
				.header("content-type", JSONL_CONTENT_TYPE)
				.send(lines.join("\n") + "\n");
		},
	);

	// Import: create a new conversation from JSONL (Task 5c). The body is
	// the RAW JSONL text (the export format, round-tripped); parse line by
	// line, create the conversation the create-route way, then append each
	// parsed entry IN ORDER (oldest-first) inside one commit — fresh entry
	// ids are assigned by storage (`EntryDraft` carries no id).
	app.post(
		"/v1/conversations/import",
		async (
			request,
			reply,
		): Promise<ConversationImportResponse> => {
			const raw = request.body;
			if (typeof raw !== "string") {
				return await reply.code(400).send({ error: "invalid_body" });
			}
			const textLines = raw.split("\n");
			// A trailing newline is the export terminator, not an empty line.
			const lines =
				textLines[textLines.length - 1] === ""
					? textLines.slice(0, -1)
					: textLines;
			if (lines.length === 0) {
					return await reply.code(400).send({ error: "invalid_body" });
			}
			const drafts: EntryDraft[] = [];
			for (const [index, line] of lines.entries()) {
				if (line.trim() === "") {
					return await reply.code(400).send({ error: "invalid_body" });
				}
				let parsed: unknown;
				try {
					parsed = JSON.parse(line);
				} catch {
					return await reply
						.code(400)
						.send({ error: "invalid_body", line: index + 1 });
				}
				if (typeof parsed !== "object" || parsed === null) {
					return await reply
						.code(400)
						.send({ error: "invalid_body", line: index + 1 });
			}
				const record = parsed as Record<string, unknown>;
				// An entry line carries `kind` plus the optional model/data/
				// edits payloads — the EntryDraft shape. Stale identity fields
				// (id/conversationId/byTaskId) are dropped: storage assigns
				// fresh ones. A stale `head` EntryId would point at the OLD
				// numbering — drop it too; the default active-context pointer
				// starts at the newest appended entry.
				const draft: EntryDraft = {
					kind: String(record.kind),
					...(Array.isArray(record.model)
						? { model: record.model as EntryDraft["model"] }
						: {}),
					...("data" in record
						? { data: record.data as EntryDraft["data"] }
						: {}),
					...(Array.isArray(record.edits)
						? { edits: record.edits as EntryDraft["edits"] }
						: {}),
			};
				if (draft.kind === "") {
					return await reply
						.code(400)
						.send({ error: "invalid_body", line: index + 1 });
				}
				drafts.push(draft);
			}
			const conversation = await opened.harness.createConversation(
				{
					ownership: { kind: "ownerless" },
					agent: storeAgentChange(opened, opened.defaultModel),
				},
				BACKGROUND_CONTEXT,
			);
			// One commit appends every entry in order; the conversation's own
			// commit binds the transaction to this conversation.
			await conversation.commit(async (tx) => {
				for (const draft of drafts) {
					await tx.appendEntry(conversation.id, draft);
				}
			}, BACKGROUND_CONTEXT);
			// The imported conversation is the IMPORTER's, not the source's
			// (the JSONL never carries meta — the stamp is the only owner).
			await stampSessionOwner(conversation, request.sigrunUser);
			const view = await readView(conversation);
			return await reply.code(201).send({ id: conversation.id, view });
		},
	);

	// JSONL bodies (the import route above): raw text, never JSON-parsed —
	// the route itself parses line by line so a bad line is a 400
	// invalid_body, not Fastify's 415 Unsupported Media Type. Content-type-
	// only: onRequest hooks (deploy auth etc.) keep their hook semantics.
	for (const type of [JSONL_CONTENT_TYPE, "text/plain"]) {
		app.addContentTypeParser(
			type,
			{ parseAs: "string" },
			(_request, body, done) => done(null, body),
		);
	}

	// Session meta: the conversation-scoped sidebar resource (T10, spec §5).
	// GET serves the doc — or the defaults when it was never written; a read
	// NEVER materializes the doc (defaults are free; a write-per-read would
	// churn a doc revision on every sidebar poll). PATCH merges per the spec
	// table (null clears, draft sub-merges, tagged replaces wholesale) inside
	// ONE commit callback — the read-modify-write pattern keeps concurrent
	// patches from losing each other's fields (the mutation line serializes
	// commits, mirroring the T9c-ii decide pattern).
	app.get(
		"/v1/conversations/:id/meta",
		{ schema: { params: ID_PARAMS_SCHEMA } },
		async (request, reply): Promise<SessionMeta> => {
			const { id } = request.params as { id: number };
			const conversation = await opened.harness.conversation(
				conversationId(id),
				BACKGROUND_CONTEXT,
			);
			if (conversation === undefined) {
				return await reply
					.code(404)
					.send({ error: "conversation_not_found" });
			}
			// Absent doc → DEFAULT_SESSION_META: served, not written.
			return (
				(await opened.harness.snapshot(
					SessionMetaDoc,
					conversation.id,
					BACKGROUND_CONTEXT,
				)) ?? DEFAULT_SESSION_META
			);
		},
	);

	app.patch(
		"/v1/conversations/:id/meta",
		{ schema: { params: ID_PARAMS_SCHEMA } },
		async (request, reply): Promise<SessionMeta> => {
			const { id } = request.params as { id: number };
			const conversation = await opened.harness.conversation(
				conversationId(id),
				BACKGROUND_CONTEXT,
			);
			if (conversation === undefined) {
				return await reply
					.code(404)
					.send({ error: "conversation_not_found" });
			}
			// Validate FIRST — a rejected patch never touches the doc.
			const validated = validateSessionMetaPatch(request.body);
			if ("error" in validated) {
				return await reply.code(400).send(validated);
			}
			// Read-modify-write inside ONE commit: tx.doc materializes the doc
			// (initial()) when absent, the patch mutates the tracked draft, and the
			// return value — a plain projection, since the draft handle dies at
			// callback return — is exactly what the commit stores.
			return await conversation.commit(async (tx) => {
				const draft = await tx.doc(SessionMetaDoc, conversation.id);
				applySessionMetaPatch(draft, validated);
				return {
					pinned: draft.pinned,
					tagged: [...draft.tagged],
					archived: draft.archived,
					source: draft.source,
					draft: {
						text: draft.draft.text,
						attachments: [...draft.draft.attachments],
					},
					...(draft.owner === undefined ? {} : { owner: draft.owner }),
					...(draft.name === undefined ? {} : { name: draft.name }),
					// The server-owned trio rides the projection when present —
					// a patch must never lose them from the served doc.
					...(draft.autoName === undefined
						? {}
						: { autoName: draft.autoName }),
					...(draft.autoNameAttempts === undefined
						? {}
						: { autoNameAttempts: draft.autoNameAttempts }),
					...(draft.lastActivityAt === undefined
						? {}
						: { lastActivityAt: draft.lastActivityAt }),
				};
			}, BACKGROUND_CONTEXT);
		},
	);

	// Uploads: materialize a base64 body into the conversation's upload
	// namespace via the workspace env (spec §5: correct for remote workspaces).
	app.post(
		"/v1/conversations/:id/uploads",
		{ schema: { params: ID_PARAMS_SCHEMA } },
		async (request, reply): Promise<UploadResponse> => {
			const { id } = request.params as { id: number };
			const conversation = await opened.harness.conversation(
				conversationId(id),
				BACKGROUND_CONTEXT,
			);
			if (conversation === undefined) {
				return await reply
					.code(404)
					.send({ error: "conversation_not_found" });
			}
			const body = request.body as Record<string, unknown> | undefined;
			const name = body?.name;
			const contentBase64 = body?.contentBase64;
			if (
				body === undefined ||
				typeof name !== "string" ||
				name.length === 0 ||
				name.includes("/") ||
				name.includes("\\") ||
				name === "." ||
				name === ".." ||
				typeof contentBase64 !== "string"
			) {
				return await reply.code(400).send({ error: "invalid_body" });
			}
			let bytes: Buffer | undefined;
			try {
				bytes = decodeBase64Strict(contentBase64);
			} catch {
				bytes = undefined;
			}
			if (bytes === undefined) {
				return await reply.code(400).send({ error: "invalid_body" });
			}
			// v1 namespaces uploads per conversation: workspaces are static and
			// shared in v1, so un-namespaced names would clobber across
				// conversations. The returned path is exactly what a content part
			// takes.
			const path = `uploads/${conversation.id}/${name}`;
			const env = await conversationEnv(opened, conversation);
			const written = await env.writeFile(
				path,
				new Uint8Array(bytes),
				BACKGROUND_CONTEXT,
			);
			if (!written.ok) {
				// A failed upload is a server-side fault: fail loud.
				throw written.error;
			}
			return await reply.code(201).send({ path });
		},
	);

	// Files: read-only workspace listing through the conversation env.
	app.get(
		"/v1/conversations/:id/files",
		{ schema: { params: ID_PARAMS_SCHEMA } },
		async (request, reply): Promise<FileListResponse> => {
			const { id } = request.params as { id: number };
			const conversation = await opened.harness.conversation(
				conversationId(id),
				BACKGROUND_CONTEXT,
			);
			if (conversation === undefined) {
				return await reply
					.code(404)
					.send({ error: "conversation_not_found" });
			}
			const query = request.query as { path?: string };
			const path = query.path ?? ".";
			if (!isConfinedPath(path)) {
				return await reply.code(400).send({ error: "invalid_path" });
			}
			const env = await conversationEnv(opened, conversation);
			const listed = await env.listDir(path, BACKGROUND_CONTEXT);
			if (!listed.ok) {
				if (listed.error.code === "not_found") {
					return await reply.code(404).send({ error: "not_found" });
				}
				throw listed.error;
			}
			// pi-durable's listDir returns ABSOLUTE paths (resolve(cwd, name)),
			// but the §5 files/content endpoint requires workspace-RELATIVE
			// paths (isConfinedPath rejects absolute). Relativize each entry
			// against the workspace root so the tree's paths feed back into the
			// content endpoint (a listed file can be read).
			const workspaceRoot = config.workspace.path;
			const entries = listed.value.map((entry) => ({
				...entry,
				path: entry.path.startsWith(`${workspaceRoot}/`)
					? entry.path.slice(workspaceRoot.length + 1)
					: entry.path,
			}));
			return { entries };
		},
	);

	// Files content: text when strictly valid UTF-8, else base64; size-capped.
	app.get(
		"/v1/conversations/:id/files/content",
		{ schema: { params: ID_PARAMS_SCHEMA } },
		async (request, reply): Promise<FileContentResponse> => {
			const { id } = request.params as { id: number };
			const conversation = await opened.harness.conversation(
				conversationId(id),
				BACKGROUND_CONTEXT,
			);
			if (conversation === undefined) {
				return await reply
					.code(404)
					.send({ error: "conversation_not_found" });
			}
			const query = request.query as { path?: string };
			const path = query.path ?? "";
			if (!isConfinedPath(path)) {
				return await reply.code(400).send({ error: "invalid_path" });
			}
			if (path.length === 0 || path === ".") {
				return await reply.code(400).send({ error: "invalid_path" });
			}
			const env = await conversationEnv(opened, conversation);
			const info = await env.fileInfo(path, BACKGROUND_CONTEXT);
			if (!info.ok) {
				if (info.error.code === "not_found") {
					return await reply.code(404).send({ error: "not_found" });
				}
				throw info.error;
			}
			if (info.value.size > FILE_CONTENT_MAX_BYTES) {
				return await reply
					.code(413)
					.send({
							error: "file_too_large",
						maxBytes: FILE_CONTENT_MAX_BYTES,
					});
			}
			const read = await env.readBinaryFile(path, BACKGROUND_CONTEXT);
			if (!read.ok) {
				if (read.error.code === "not_found") {
					return await reply.code(404).send({ error: "not_found" });
				}
				throw read.error;
			}
			const bytes = read.value;
			// Text when strictly valid UTF-8, else base64 — the same rule as
			// file-part inlining, applied at the read boundary.
			try {
				const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
				return { encoding: "text", content: text, size: bytes.length };
			} catch {
				return {
					encoding: "base64",
					content: Buffer.from(bytes).toString("base64"),
					size: bytes.length,
				};
			}
		},
	);

	// Models: the merged chat-model catalog as picker entries (no provider
	// internals — baseUrl/headers/auth stay server-side).
	app.get("/v1/models", async (): Promise<ModelsResponse> => {
		const models: ModelEntry[] = opened.models.getModels().map((model) => ({
			id: `${model.provider}/${model.id}`,
			provider: model.provider,
			modelId: model.id,
			name: model.name,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			reasoning: model.reasoning,
			input: model.input,
			// Project the four rate fields explicitly (ModelCostRates); `tiers` is
			// dropped for v1 (the picker doesn't use them) — no unsound cast.
			cost: {
				input: model.cost.input,
				output: model.cost.output,
				cacheRead: model.cost.cacheRead,
				cacheWrite: model.cost.cacheWrite,
			},
		}));
		return { models };
	});

	// Settings: the file-backed store over the harness's live settings
	// (Task 8b, pi parity). GET serves the current effective settings
	// (absent file = `{}` — every default); PATCH validates + merges +
	// persists through the store, and the harness picks the change up on
	// the next resolution (steeringMode on the next submission's admission,
	// because pi-durable re-reads `HarnessSettings` per boundary). Errors
	// follow the repo's PATCH conventions: 400 `invalid_field` naming the
	// key (unknown key, wrong type), 400 `invalid_body` for a non-object.
	app.get("/v1/settings", async (): Promise<SettingsResponse> => {
		return settingsResponse(opened);
	});

	app.patch("/v1/settings", async (request, reply): Promise<SettingsResponse> => {
		const body = request.body as Record<string, unknown> | undefined;
		if (
			body === undefined ||
			body === null ||
			typeof body !== "object" ||
			Array.isArray(body)
		) {
			return await reply.code(400).send({ error: "invalid_body" });
		}
		try {
			opened.settings.update(body);
			return settingsResponse(opened);
		} catch (error) {
			if (error instanceof SettingsValidationError) {
				return await reply
					.code(400)
					.send({ error: "invalid_field", field: error.field });
			}
			throw error;
		}
	});

	return app;
}
