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
 * and the submission lifecycle routes (`routes/submissions.ts`).
 *
 * Routes still registered inline below: `GET /v1/auth/check` (the
 * secret-free per-provider auth readiness report), the interaction +
 * ambient seam routes (docs/approval-ux-seams.md), the workspace file
 * routes (`POST .../uploads`, `GET .../files`, `GET .../files/content`),
 * `GET /v1/models`, and `GET`/`PATCH /v1/settings`.
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
import {
	AmbientDoc,
	AmbientOwnersDoc,
	type AmbientRecord,
} from "../harness/ambient.js";
import {
	InteractionDoc,
	InteractionsIndexDoc,
	applyAnswer,
	indexSettled,
	type InteractionAnswer,
	type InteractionRecord,
} from "../harness/interactions.js";
import type { SigrunConfig } from "../config.js";
import type { OpenedHarness } from "../harness/boot.js";
import { SettingsValidationError } from "../harness/settings.js";
import { OPENAI_API_KEY_ENV } from "../harness/providers/index.js";
import { DEFAULT_AUTH_KEY } from "../harness/auth.js";
import type { ServerContext } from "./context.js";
import {
	storeAgentChange,
	ID_PARAMS_SCHEMA,
	settingsResponse,
	conversationId,
	conversationEnv,
	FILE_CONTENT_MAX_BYTES,
	decodeBase64Strict,
} from "./helpers.js";
import { registerConversationRoutes } from "./routes/conversations.js";
import { registerMetaRoutes } from "./routes/meta.js";
import { registerProbeRoutes } from "./routes/probes.js";
import { registerStreamRoutes } from "./routes/stream.js";
import { registerSubmissionRoutes } from "./routes/submissions.js";
import {
	resolveWebuiBundle,
	serveWebuiBundle,
	type ContributedWebuiBundle,
} from "./static.js";
import { isConfinedPath } from "./content-parts.js";
import {
	type AmbientList,
	type AuthCheckProvider,
	type AuthCheckResponse,
	type AuthStatus,
	type InteractionAnswered,
	type InteractionList,
	type FileContentResponse,
	type FileListResponse,
	type ModelEntry,
	type ModelsResponse,
	type SettingsResponse,
	type UploadResponse,
} from "./views.js";

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
	// The shared context every route module receives: the opened harness,
	// the config, the root id (computed once, never per request), and the
	// resolved webui bundle.
	const ctx: ServerContext = { opened, config, rootId, webuiBundle };
	registerProbeRoutes(app, ctx);
	registerMetaRoutes(app, ctx);
	registerConversationRoutes(app, ctx);
	registerStreamRoutes(app, ctx);
	registerSubmissionRoutes(app, ctx);

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
