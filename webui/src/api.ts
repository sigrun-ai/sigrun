/**
 * Typed client for the sigrun §5 HTTP API (Task 20 scaffold subset:
 * `GET /v1/meta`, `GET /v1/conversations`, `GET /v1/models`).
 *
 * `src/server/views.ts` is sigrun's channel contract: every wire type the
 * server serves is declared there, and this facade RE-EXPORTS the
 * contract types from it (no hand-maintained mirrors — the webui
 * typechecks against the server sources; views.ts's enforced purity —
 * `import type` only, no `node:` imports — keeps the client bundle free
 * of server runtime code). The `*Wire` suffixes on the re-exported shapes
 * below are stable export names so consumers (`./stream`,
 * `./useConversationView`, the entry renderers) are unchanged.
 *
 * Types that stay declared locally: the client-NARROWED view projections
 * (`ContentBlockWire`/`UsageWire`/`MessageWire`/`ConversationEntryWire`/
 * `ConversationViewWire`/`ToolSlotWire` — views.ts DOES
 * export a `ConversationViewWire`, pi-durable's full `ConversationView`
 * plus `steer`; the webui keeps its own declaration under the same name
 * because its renderers read deliberately narrowed `entries`/`docs`
 * shapes, so the name is shadowed here on purpose), and the client-side
 * request inputs (`ConversationMetaPatch`, `SettingsPatchWire`,
 * `ConfigureInput`, `UploadFileInput`, `SubmissionInputPart`,
 * `SubmitOptions`, `SigrunClient`, `FetchLike`, `SigrunClientOptions`).
 *
 * The client is fail-loud: a non-2xx response rejects with an error naming
 * the status and path (never a silent `undefined` the UI could misrender as
 * empty state).
 */

// ─── Contract re-exports (the channel contract — src/server/views.ts) ─────

import type {
	MetaResponse,
	InteractionWire,
	InteractionList as InteractionListWire,
	InteractionAnswered as InteractionAnsweredWire,
	AmbientList as AmbientListWire,
	ConversationSummary,
	ConversationList,
	ModelsResponse,
	SettingsResponse as SettingsWire,
	SteerField as SteerWire,
	FileListResponse as FileListResponseWire,
	FileContentResponse as FileContentResponseWire,
	UploadResponse as UploadResponseWire,
	CompactResponse as CompactResponseWire,
	ConversationCreateResponse as ConversationCreatedWire,
	SubmissionResponse as SubmissionResponseWire,
	ConfigureResponse as ConfigureResponseWire,
	CommandsResponse as CommandsResponseWire,
	CommandRunResponse as CommandRunResponseWire,
	SlashCommand as CommandWire,
	SessionMeta as ConversationMeta,
	OnboardingState,
	ClaimResponse,
	WhoamiResponse,
	ExtensionsResponse as ExtensionsResponseWire,
	ExtensionInfo as ExtensionInfoWire,
	ExtensionSecret as ExtensionSecretWire,
	ExtensionSecretsResponse as ExtensionSecretsResponseWire,
	ExtensionSettingsResponse as ExtensionSettingsWire,
	SettingsSectionsResponse as SettingsSectionsResponseWire,
	SettingsSectionEntry as SettingsSectionEntryWire,
	SettingsSectionIndexEntry as SettingsSectionIndexEntryWire,
	AuthCheckProvider as AuthCheckProviderWire,
	ProvidersResponse as ProvidersResponseWire,
	JobsResponse,
	JobRunResponse,
} from "@sigrun/shared/views";
import type {
	JobRevisionWire,
	JobRunWire,
	JobWire,
} from "@sigrun/shared/jobs";
import type { Sharing } from "@sigrun/shared/access";

export type {
	MetaResponse,
	InteractionWire,
	InteractionList as InteractionListWire,
	InteractionAnswered as InteractionAnsweredWire,
	AmbientWire,
	AmbientList as AmbientListWire,
	ConversationSummary,
	ConversationList,
	ModelEntry,
	ModelsResponse,
	SettingsResponse as SettingsWire,
	SteerField as SteerWire,
	FileEntry as FileEntryWire,
	FileListResponse as FileListResponseWire,
	FileContentResponse as FileContentResponseWire,
	UploadResponse as UploadResponseWire,
	CompactResponse as CompactResponseWire,
	ConversationCreateResponse as ConversationCreatedWire,
	SubmissionResponse as SubmissionResponseWire,
	ConfigureResponse as ConfigureResponseWire,
	CommandsResponse as CommandsResponseWire,
	CommandRunResponse as CommandRunResponseWire,
	SlashCommand as CommandWire,
	SessionMeta as ConversationMeta,
	OnboardingState,
	ClaimResponse,
	WhoamiResponse,
	ExtensionsResponse as ExtensionsResponseWire,
	ExtensionInfo as ExtensionInfoWire,
	ExtensionSecret as ExtensionSecretWire,
	ExtensionSecretsResponse as ExtensionSecretsResponseWire,
	ExtensionSettingsResponse as ExtensionSettingsWire,
	SettingsSectionsResponse as SettingsSectionsResponseWire,
	SettingsSectionEntry as SettingsSectionEntryWire,
	SettingsSectionIndexEntry as SettingsSectionIndexEntryWire,
	AuthCheckProvider as AuthCheckProviderWire,
	ProvidersResponse as ProvidersResponseWire,
	JobsResponse,
	JobRunResponse,
} from "@sigrun/shared/views";

/** The jobs channel wire shapes (W4, spec §8.2/§8.4) — the shared leaf's
 *  contract module, re-exported so the jobs UI and the server agree. */
export type {
	JobSpec,
	JobSchedule,
	JobAction,
	JobWire,
	JobRunWire,
	JobRevisionWire,
} from "@sigrun/shared/jobs";

/** `GET /v1/jobs/:id/runs`: the job's runs, newest first. */
export interface JobRunsResponse {
	readonly runs: readonly JobRunWire[];
}

/** `GET /v1/jobs/:id/revisions`: the job's revisions, newest first. */
export interface JobRevisionsResponse {
	readonly revisions: readonly JobRevisionWire[];
}

/** A conversation's sharing grant (spec §5.9) — the shared leaf's shape,
 *  re-exported so the share UI and the patch type agree with the server. */
export type { Sharing } from "@sigrun/shared/access";

// The interaction/ambient seam records ARE the wire (never projected);
// their bodies are block trees (`@sigrun/shared/blocks` — the tree types
// are the contract). The legacy body sub-shape aliases are gone (ruling
// 16: the legacy shapes are rejected server-side).

/** The queue modes (`steeringMode`/`followUpMode`; pi-durable `QueueMode`). */
export type QueueModeWire = "all" | "one-at-a-time";

/**
 * A non-2xx §5 response, fail-loud: carries the HTTP `status` and the
 * body's `error` code (when it spoke one) so callers can branch on both —
 * the auth gate keys on `status === 401`, the forms surface `error`.
 * Today's plain `Error` rejections lose the status (W1 Task 8's brief).
 */
export class ApiError extends Error {
	readonly status: number;
	readonly error?: string;

	constructor(init: {
		readonly method: string;
		readonly path: string;
		readonly status: number;
		readonly error?: string;
	}) {
		super(
			`sigrun api: ${init.method} ${init.path} failed with status ${init.status}` +
				(init.error === undefined ? "" : ` (${init.error})`),
		);
		this.name = "ApiError";
		this.status = init.status;
		this.error = init.error;
	}
}

/** The `POST /v1/onboarding/claim` body (spec §5.8): every field optional —
 *  the route picks by trust posture (proxy vouch, loopback bind, code). */
export interface ClaimInput {
	readonly code?: string;
	readonly user?: string;
	readonly name?: string;
	readonly email?: string;
	readonly issueToken?: boolean;
	readonly tokenName?: string;
}

/** The `POST /v1/auth/login` body's success reply: `{user}` (the cookie is
 *  the credential — set by the response, never the body). */
export interface LoginResponse {
	readonly user: string;
}

/**
 * A PATCH body for `/v1/settings`: a merge where an explicit `null` CLEARS
 * the key. The server validates per key (unknown key / wrong type → 400
 * `invalid_field`). `toolRoster` and `effective` are deliberately
 * OMITTED — both are server-computed per request, not settable keys;
 * sending either would 400 (`is not a settable field`), and the
 * type-level Omit makes that unrepresentable here.
 */
export type SettingsPatchWire = {
	readonly [K in keyof Omit<
		SettingsWire,
		"toolRoster" | "effective"
	>]?: SettingsWire[K] | null;
};

/**
 * A PATCH body for `/v1/conversations/:id/meta`: a merge where an explicit
 * `null` CLEARS the field (spec §5 + the server's validateSessionMetaPatch).
 * `draft` sub-merges (a draft patch with only `text` preserves
 * `attachments`); `draft: null` resets the whole draft.
 */
export type ConversationMetaPatch = {
	readonly pinned?: boolean | null;
	readonly tagged?: readonly string[] | null;
	readonly archived?: boolean | null;
	readonly draft?:
		| { readonly text?: string | null; readonly attachments?: readonly string[] | null }
		| null;
	readonly source?: "user" | "cron" | null;
	readonly owner?: string | null;
	readonly name?: string | null;
	/** The §5.9 sharing grant (owner-only server-side); `null` clears it
	 *  (back to private). */
	readonly sharing?: Sharing | null;
};

/* -------------------------------------------------------------------------
 * Conversation view stream wire types (Task 21): the pi-durable native
 * view's inner shapes — published over the §5 stream (`snapshot` + `view`
 * frames; every frame is a FULL immutable revision: replace, never
 * accumulate) but never named by a sigrun wire type, so declared here.
 * ---------------------------------------------------------------------- */

/** One content block of a message (`{type: "text", text}`, `{type:
 * "thinking", thinking}`, image/file parts, tool calls). */
export interface ContentBlockWire {
	readonly type: string;
	readonly text?: string;
	/** The thinking text on `{type: "thinking"}` blocks (pi-ai
	 * ThinkingContent). Absent on every other block type. */
	readonly thinking?: string;
	readonly path?: string;
}

/** Token usage + cost on an assistant message (mirrors the §5 usage shape). */
export interface UsageWire {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly totalTokens: number;
	readonly cost: {
		readonly input: number;
		readonly output: number;
		readonly cacheRead: number;
		readonly cacheWrite: number;
		readonly total: number;
	};
}

/** One model message carried by a §5 entry. */
export interface MessageWire {
	readonly role: string;
	readonly content: string | readonly ContentBlockWire[];
	readonly api?: string;
	readonly provider?: string;
	readonly model?: string;
	readonly usage?: UsageWire;
	readonly stopReason?: string;
	readonly timestamp?: number;
	/** Tool correlation — present on `toolResult`-role messages. */
	readonly toolName?: string;
	readonly toolCallId?: string;
	/**
	 * Tool execution details (`ToolResultMessage.details`), when the tool
	 * reported any — e.g. the edit tool's `{ diff, patch }`. Narrowed by the
	 * consumers that read it (ToolResultEntry's diff view).
	 */
	readonly details?: unknown;
}

/**
 * One §5 conversation entry. Renderers dispatch on `kind` (`pi.user`,
 * `pi.assistant`, `pi.tool-result`, `pi.system`, …) — kept as `string` so the
 * client stays forward-compatible with new kinds.
 */
export interface ConversationEntryWire {
	readonly id: number;
	readonly conversationId: number;
	readonly kind: string;
	/**
	 * The entry's kind-specific JSON payload (`EntryRecord.data` — e.g.
	 * `pi.compaction`'s `{ reason }`, `pi.tool-result`'s diagnostics).
	 * Absent on kinds that carry none; narrowed by the renderers that read
	 * it.
	 */
	readonly data?: unknown;
	/**
	 * The entry's message payload. ABSENT on some kinds (pi-durable's
	 * `pi.reset` carries no model — dist/entries.d.ts:20-22), so optional,
	 * never assumed.
	 */
	readonly model?: readonly MessageWire[];
	readonly byTaskId?: number;
}

/**
 * The §5 conversation view frame (`snapshot` and `view` events carry the same
 * shape — every frame is a FULL revision: replace, never accumulate). `docs`
 * holds the named LiveDocs (`pi.live`, `pi.inbox`, `pi.usage`, …); their
 * shapes are narrowed by the consumers that read them. `steer` reflects the
 * run state the composer needs (busy flips send→steer; queued = inbox depth).
 */
export interface ConversationViewWire {
	readonly conversation: { readonly id: number };
	readonly entries: readonly ConversationEntryWire[];
	readonly docs: Readonly<Record<string, unknown>>;
	readonly steer: SteerWire;
}

/** One live tool slot of `docs["pi.live"]` (the LiveState tools list). */
export interface ToolSlotWire {
	readonly callId: string;
	readonly name: string;
	readonly status: string;
	readonly output?: string;
}

/**
 * The `docs["pi.live"]` LiveState doc — the shared leaf's narrowing
 * (`@sigrun/shared/live`), re-exported under the stable webui name: the doc
 * shape AND its read functions live in the shared package now (gateway
 * plan 1, Task 1) so the gateway engine and every channel narrow `pi.live`
 * identically. `ToolSlotWire` above stays the webui's spelling of the
 * shared `LiveToolSlotWire` (structurally identical).
 */
export type { LiveDocWire } from "@sigrun/shared/live";

/** The configure body (`POST .../configure`): exactly one field per call. */
export interface ConfigureInput {
	readonly model?: string;
	readonly thinking?: string;
}

/**
 * The minimal file surface `upload` consumes — the browser's `File`/`Blob`
 * satisfy this structurally; tests pass a plain object.
 */
export interface UploadFileInput {
	readonly name: string;
	arrayBuffer(): Promise<ArrayBuffer>;
}

/** One content part of a submission input (spec §5: text + workspace-relative path parts). */
export interface SubmissionInputPart {
	readonly type: string;
	readonly text?: string;
	readonly path?: string;
	readonly mime?: string;
}

/** `submit` options (spec §5: `requestId` idempotence; T23b's steer). */
export interface SubmitOptions {
	readonly requestId?: string;
	/**
	 * `whenBusy: "steer"` injects the input into the running session
	 * (the composer's steer toggle; pi-durable maps it to the steering
	 * queue). Omitted = the default busy-queue semantics.
	 */
	readonly whenBusy?: "steer";
}

/** The §5 client surface. */
export interface SigrunClient {
	getMeta(): Promise<MetaResponse>;
	/**
	 * The raw fetch the settings surfaces' transports ride (U4 Task 4,
	 * the `ExtFetchLike` shape): non-2xx does NOT throw — the surface
	 * transport reads status itself. The same auth/cookie posture as
	 * every other call (the ambient fetch carries the session cookie).
	 */
	rawFetch(
		input: string,
		init?: {
			readonly method?: string;
			readonly headers?: Record<string, string>;
			readonly body?: string | Uint8Array;
		},
	): Promise<{
		readonly ok: boolean;
		readonly status: number;
		json(): Promise<unknown>;
	}>;
	/**
	 * `POST /v1/admin/restart` (admin; U4 Task 2, spec §13.3): resolves
	 * once the server answered 202 (the restart begins after the reply);
	 * rejects fail-loud on 403/409 (the shell shows the error and stays
	 * up — no restart began).
	 */
	requestRestart(): Promise<void>;
	/**
	 * `GET /readyz` readiness probe (U4 Task 2): `true` only on a 200.
	 * The restart-recovery poll rides this; a connection-level failure
	 * (the process mid-restart) resolves `false`, never throws.
	 */
	checkReady(): Promise<boolean>;
	listConversations(): Promise<ConversationList>;
	listModels(): Promise<ModelsResponse>;
	getConversationMeta(conversationId: number): Promise<ConversationMeta>;
	patchConversationMeta(
		conversationId: number,
		patch: ConversationMetaPatch,
	): Promise<void>;
	createConversation(): Promise<ConversationSummary>;
	submit(
		conversationId: number,
		input: readonly SubmissionInputPart[],
		options?: SubmitOptions,
	): Promise<SubmissionResponseWire>;
	/**
	 * List a workspace directory (`GET .../files?path=`; `path` defaults to
	 * the workspace root `"."`).
	 */
	listFiles(conversationId: number, path?: string): Promise<FileListResponseWire>;
	/** Read a workspace file (`GET .../files/content?path=`). */
	readFile(
		conversationId: number,
		path: string,
	): Promise<FileContentResponseWire>;
	/**
	 * Materialize an upload (`PUT .../uploads/<name>` with the raw bytes as
	 * `application/octet-stream` — no base64 inflation, so a phone photo
	 * fits the server's `server.maxUploadBytes`); resolves to the
	 * workspace-relative path a submission part consumes.
	 */
	upload(
		conversationId: number,
		file: UploadFileInput,
	): Promise<UploadResponseWire>;
	/**
	 * Admit a manual compaction (`POST .../compact`): resolves with the
	 * durable task's id once the server admits it (202); the summary entry
	 * arrives later as a view revision. `instructions` (the `/compact`
	 * command's arg) rides the optional body field.
	 */
	compact(
		conversationId: number,
		instructions?: string,
	): Promise<CompactResponseWire>;
	/** The slash-command catalog (`GET /v1/commands` — a boot constant). */
	listCommands(): Promise<CommandsResponseWire>;
	/**
	 * Invoke an extension slash command (`POST .../commands/:name`, W5
	 * Task 3): the server runs the winning extension declaration and
	 * resolves with its optional `{notice}` — rendered as a transient
	 * banner.
	 */
	runCommand(
		conversationId: number,
		name: string,
		args?: string,
	): Promise<CommandRunResponseWire>;
	/** Fork at an entry (`POST .../fork`; absent `at` = the newest entry). */
	fork(conversationId: number, at?: number): Promise<ConversationCreatedWire>;
	/** The whole history as JSONL text (`GET .../export`). */
	exportConversation(conversationId: number): Promise<string>;
	/** Create a conversation from raw JSONL (`POST /v1/conversations/import`). */
	importConversation(jsonl: string): Promise<ConversationCreatedWire>;
	/** Change the model and/or thinking level (`POST .../configure`). */
	configure(
		conversationId: number,
		input: ConfigureInput,
	): Promise<ConfigureResponseWire>;
	/** Pending interactions for a conversation (`GET .../interactions`). */
	listInteractions(conversationId: number): Promise<InteractionListWire>;
	/**
	 * One interaction record in ANY status (`GET .../interactions/:callId`,
	 * U6 Task 2) — the channel's settle-refetch path: an answer that lands
	 * on an already-settled record (404 not_pending) refetches here and
	 * renders the settled record read-only.
	 */
	getInteraction(
		conversationId: number,
		callId: string,
	): Promise<InteractionWire>;
	/**
	 * Answer a pending interaction (the ONE generic route). `answer` is
	 * `{values}` (ruling 20: every field's value under its name);
	 * resolution semantics stay extension-owned.
	 */
	answerInteraction(
		conversationId: number,
		callId: string,
		answer: {
			readonly values: Readonly<Record<string, unknown>>;
		},
	): Promise<InteractionAnsweredWire>;
	/** The conversation's ambient surfaces (`GET .../ambient`). */
	listAmbient(conversationId: number): Promise<AmbientListWire>;
	/** The effective settings (`GET /v1/settings`; absent file = `{}`). */
	getSettings(): Promise<SettingsWire>;
	/**
	 * The settings sections list + search index (`GET
	 * /v1/settings/sections`, UI-blocks U4 Task 4): the panel's nav and
	 * its label search build from one payload.
	 */
	listSettingsSections(): Promise<SettingsSectionsResponseWire>;
	/**
	 * Merge a settings patch (`PATCH /v1/settings`); an explicit `null`
	 * clears a key. Resolves to the new effective settings.
	 */
	patchSettings(patch: SettingsPatchWire): Promise<SettingsWire>;
	/** The onboarding state (`GET /v1/onboarding` — public; the boot probe). */
	getOnboarding(): Promise<OnboardingState>;
	/**
	 * Claim the server (`POST /v1/onboarding/claim`). With
	 * `issueToken: true` the server ALSO sets the `sigrun_session` cookie
	 * — the browser keeps the cookie and discards the returned token.
	 */
	claim(body: ClaimInput): Promise<ClaimResponse>;
	/** Token login (`POST /v1/auth/login` — the cookie lands in the response). */
	login(token: string): Promise<LoginResponse>;
	/** Log out (`POST /v1/auth/logout` — expires the cookie). */
	logout(): Promise<void>;
	/** The resolved principal (`GET /v1/auth/whoami`). */
	whoami(): Promise<WhoamiResponse>;
	/** The loaded-extension inventory (`GET /v1/extensions`). */
	listExtensions(): Promise<ExtensionsResponseWire>;
	/** One extension's settings (`GET /v1/extensions/:slug/settings`; U4 §13.2 shape). */
	getExtensionSettings(
		slug: string,
	): Promise<ExtensionSettingsWire>;
	/** Replace one extension's settings object (`PUT`, admin). */
	putExtensionSettings(
		slug: string,
		value: Record<string, unknown>,
	): Promise<ExtensionSettingsWire>;
	/** One extension's secret keys with their sources (`GET .../secrets`). */
	listExtensionSecrets(
		slug: string,
	): Promise<ExtensionSecretsResponseWire>;
	/** Set one secret (`PUT .../secrets/:key`, admin; values are never read back). */
	putExtensionSecret(
		slug: string,
		key: string,
		value: string,
	): Promise<ExtensionSecretsResponseWire>;
	/** Delete one secret (`DELETE .../secrets/:key`, admin). */
	deleteExtensionSecret(
		slug: string,
		key: string,
	): Promise<ExtensionSecretsResponseWire>;
	/** The per-provider readiness report (`GET /v1/providers`). */
	listProviders(): Promise<ProvidersResponseWire>;
	/**
	 * Write one provider's credential (`PUT .../credential`, admin): the
	 * key rides the body and is never read back — the response is the
	 * provider's readiness entry after the server's one post-write
	 * refresh.
	 */
	putProviderCredential(
		id: string,
		apiKey: string,
	): Promise<AuthCheckProviderWire>;
	/** Remove one provider's credential (`DELETE .../credential`, admin). */
	deleteProviderCredential(id: string): Promise<AuthCheckProviderWire>;
	/** One bounded refresh of the named provider (`POST .../refresh`). */
	refreshProvider(id: string): Promise<AuthCheckProviderWire>;
	/** The caller-visible jobs (`GET /v1/jobs`; access-stamped per row). */
	listJobs(): Promise<JobsResponse>;
	/** Fire a job now (`POST /v1/jobs/:id/run`; write access). */
	runJob(id: string): Promise<JobRunResponse>;
	/** One job's runs, newest first (`GET /v1/jobs/:id/runs?limit=`). */
	listJobRuns(
		id: string,
		limit?: number,
	): Promise<JobRunsResponse>;
	/** One job's revisions, newest first (`GET /v1/jobs/:id/revisions`). */
	listJobRevisions(id: string): Promise<JobRevisionsResponse>;
}

/** The fetch surface the client needs (the real thing or a test stub). */
export type FetchLike = (
	input: string,
	init?: {
		readonly method?: string;
		readonly headers?: Record<string, string>;
		/** Raw upload bodies are bytes (the octet-stream PUT); everything else is text. */
		readonly body?: string | Uint8Array;
	},
) => Promise<{
	readonly ok: boolean;
	readonly status: number;
	json(): Promise<unknown>;
	/** The JSONL export path needs raw text (the ambient fetch has it). */
	text(): Promise<string>;
}>;

export interface SigrunClientOptions {
	/**
	 * URL prefix for the API, default "" — the bundle is served by the sigrun
	 * server itself, so same-origin relative paths are the default. A deploy
	 * serving the bundle elsewhere passes the server's origin.
	 */
	readonly baseUrl?: string;
	/** Injected for tests; defaults to the ambient `fetch`. */
	readonly fetch?: FetchLike;
	/**
	 * The RAW fetch the settings surfaces' transports ride (U4 Task 4):
	 * the `ExtFetchLike` shape (non-2xx does NOT throw — the surface
	 * transport reads status itself). Absent → the ambient `fetch`.
	 * Tests pass the same stub as `fetch`.
	 */
	readonly rawFetch?: (
		input: string,
		init?: {
			readonly method?: string;
			readonly headers?: Record<string, string>;
			readonly body?: string | Uint8Array;
		},
	) => Promise<{
		readonly ok: boolean;
		readonly status: number;
		json(): Promise<unknown>;
	}>;
}

/**
 * PUT a RAW byte body (the upload route — `application/octet-stream`, the
 * server-side `server.maxUploadBytes` is the limit); fail-loud on
 * non-2xx. Returns the parsed JSON response.
 */
async function putBytes(
	fetchImpl: FetchLike,
	base: string,
	path: string,
	bytes: Uint8Array,
): Promise<unknown> {
	const response = await fetchImpl(`${base}${path}`, {
		method: "PUT",
		headers: {
			accept: "application/json",
			"content-type": "application/octet-stream",
		},
		body: bytes,
	});
	if (!response.ok) {
		throw new Error(
			`sigrun api: PUT ${path} failed with status ${response.status}`,
		);
	}
	return response.json();
}

/**
 * Build the fail-loud rejection for a non-2xx response: an `ApiError`
 * carrying the status plus the body's `error` code when it spoke one (a
 * body that isn't JSON, or lacks a string `error`, still rejects — the
 * status alone is the contract).
 */
async function failure(
	method: string,
	path: string,
	response: Awaited<ReturnType<FetchLike>>,
): Promise<ApiError> {
	let error: string | undefined;
	try {
		const body: unknown = await response.json();
		if (
			typeof body === "object" &&
			body !== null &&
			"error" in body &&
			typeof (body as { error: unknown }).error === "string"
		) {
			error = (body as { error: string }).error;
		}
	} catch {
		// Not JSON (or empty): the status-only ApiError.
	}
	return new ApiError({ method, path, status: response.status, ...(error === undefined ? {} : { error }) });
}

/** Create a §5 client. See {@link SigrunClientOptions} for the seams. */
export function createClient(options: SigrunClientOptions = {}): SigrunClient {
	const baseUrl = options.baseUrl ?? "";
	const fetchImpl: FetchLike =
		options.fetch ??
		(((input, init) =>
			// `Uint8Array` is a valid `BodyInit` at runtime; the lib's newer
			// `Uint8Array<ArrayBufferLike>` generic just can't prove it.
			globalThis.fetch(input, init as RequestInit | undefined)) as FetchLike);
	// The settings surfaces' raw fetch (the ext transport's ExtFetchLike):
	// the options' rawFetch wins, else the ambient fetch. The client's
	// own calls never ride it (they use the fail-loud fetchImpl).
	const rawFetch =
		options.rawFetch ??
		(((input, init) =>
			globalThis.fetch(
				input,
				init as Parameters<typeof globalThis.fetch>[1],
			)) as NonNullable<SigrunClientOptions["rawFetch"]>);

	async function get<T>(path: string): Promise<T> {
		const response = await fetchImpl(`${baseUrl}${path}`, {
			method: "GET",
			headers: { accept: "application/json" },
		});
		if (!response.ok) {
			throw await failure("GET", path, response);
		}
		return (await response.json()) as T;
	}

	/** Send a JSON body with any method; fail-loud on non-2xx. Returns the parsed body. */
	async function send(
		method: "POST" | "PATCH" | "PUT" | "DELETE",
		path: string,
		body: unknown,
	): Promise<unknown> {
		const response = await fetchImpl(`${baseUrl}${path}`, {
			method,
			headers: {
				accept: "application/json",
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
		});
		if (!response.ok) {
			throw await failure(method, path, response);
		}
		return response.json();
	}

	/** GET a non-JSON body (the JSONL export); fail-loud on non-2xx. */
	async function getText(path: string): Promise<string> {
		const response = await fetchImpl(`${baseUrl}${path}`, {
			method: "GET",
			headers: { accept: "application/x-ndjson" },
		});
		if (!response.ok) {
			throw await failure("GET", path, response);
		}
		return await response.text();
	}

	/**
	 * POST a RAW-TEXT body (the JSONL import — the server's own content-type
	 * parser hands the route the unparsed string); fail-loud on non-2xx.
	 */
	async function postText(path: string, body: string): Promise<unknown> {
		const response = await fetchImpl(`${baseUrl}${path}`, {
			method: "POST",
			headers: {
				accept: "application/json",
				"content-type": "application/x-ndjson",
			},
			body,
		});
		if (!response.ok) {
			throw await failure("POST", path, response);
		}
		return response.json();
	}

	/** POST expecting NO body (204); fail-loud on non-2xx. */
	async function sendVoid(method: "POST", path: string, body: unknown): Promise<void> {
		const response = await fetchImpl(`${baseUrl}${path}`, {
			method,
			headers: {
				accept: "application/json",
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
		});
		if (!response.ok) {
			throw await failure(method, path, response);
		}
	}

	return {
		getMeta: () => get<MetaResponse>("/v1/meta"),
		rawFetch: (input, init) => rawFetch(input, init),
		requestRestart: async () => {
			await send("POST", "/v1/admin/restart", {});
		},
		checkReady: async () => {
			try {
				const response = await fetchImpl(`${baseUrl}/readyz`, {
					method: "GET",
					headers: { accept: "application/json" },
				});
				return response.ok;
			} catch {
				// Connection refused while the process is down: not ready.
				return false;
			}
		},
		listConversations: () => get<ConversationList>("/v1/conversations"),
		listModels: () => get<ModelsResponse>("/v1/models"),
		getConversationMeta: (conversationId) =>
			get<ConversationMeta>(`/v1/conversations/${conversationId}/meta`),
		patchConversationMeta: (conversationId, patch) =>
			send("PATCH", `/v1/conversations/${conversationId}/meta`, patch).then(
				() => undefined,
			),
		createConversation: async () =>
			(await send("POST", "/v1/conversations", {})) as ConversationSummary,
		submit: (conversationId, input, options) =>
			send("POST", `/v1/conversations/${conversationId}/submissions`, {
				input,
				...(options?.requestId === undefined
					? {}
					: { requestId: options.requestId }),
				...(options?.whenBusy === undefined
					? {}
					: { whenBusy: options.whenBusy }),
			}) as Promise<SubmissionResponseWire>,
		listFiles: (conversationId, path) =>
			get<FileListResponseWire>(
				`/v1/conversations/${conversationId}/files?path=${encodeURIComponent(path ?? ".")}`,
			),
		readFile: (conversationId, path) =>
			get<FileContentResponseWire>(
				`/v1/conversations/${conversationId}/files/content?path=${encodeURIComponent(path)}`,
			),
		upload: async (conversationId, file) => {
			const bytes = new Uint8Array(await file.arrayBuffer());
			return (await putBytes(
				fetchImpl,
				baseUrl,
				`/v1/conversations/${conversationId}/uploads/${encodeURIComponent(file.name)}`,
				bytes,
			)) as UploadResponseWire;
		},
		compact: (conversationId, instructions) =>
			send("POST", `/v1/conversations/${conversationId}/compact`, {
				...(instructions === undefined || instructions === ""
					? {}
					: { instructions }),
			}) as Promise<CompactResponseWire>,
		listCommands: () => get<CommandsResponseWire>("/v1/commands"),
		runCommand: (conversationId, name, args) =>
			send(
				"POST",
				`/v1/conversations/${conversationId}/commands/${encodeURIComponent(name)}`,
				{ args: args ?? "" },
			) as Promise<CommandRunResponseWire>,
		fork: (conversationId, at) =>
			send("POST", `/v1/conversations/${conversationId}/fork`, {
				...(at === undefined ? {} : { at }),
			}) as Promise<ConversationCreatedWire>,
		exportConversation: (conversationId) =>
			getText(`/v1/conversations/${conversationId}/export`),
		importConversation: (jsonl) =>
			postText("/v1/conversations/import", jsonl) as Promise<ConversationCreatedWire>,
		configure: (conversationId, input) =>
			send("POST", `/v1/conversations/${conversationId}/configure`, input) as Promise<
				ConfigureResponseWire
			>,
		listInteractions: (conversationId) =>
			get<InteractionListWire>(
				`/v1/conversations/${conversationId}/interactions`,
			),
		getInteraction: (conversationId, callId) =>
			get<InteractionWire>(
				`/v1/conversations/${conversationId}/interactions/${encodeURIComponent(callId)}`,
			),
		answerInteraction: (conversationId, callId, answer) =>
			send(
				"POST",
				`/v1/conversations/${conversationId}/interactions/${encodeURIComponent(callId)}/answer`,
				answer,
			) as Promise<InteractionAnsweredWire>,
		listAmbient: (conversationId) =>
			get<AmbientListWire>(`/v1/conversations/${conversationId}/ambient`),
		getSettings: () => get<SettingsWire>("/v1/settings"),
		listSettingsSections: () =>
			get<SettingsSectionsResponseWire>("/v1/settings/sections"),
		patchSettings: (patch) =>
			send("PATCH", "/v1/settings", patch) as Promise<SettingsWire>,
		getOnboarding: () => get<OnboardingState>("/v1/onboarding"),
		claim: (body) =>
			send("POST", "/v1/onboarding/claim", body) as Promise<ClaimResponse>,
		login: (token) =>
			send("POST", "/v1/auth/login", { token }) as Promise<LoginResponse>,
		logout: () => sendVoid("POST", "/v1/auth/logout", {}),
		whoami: () => get<WhoamiResponse>("/v1/auth/whoami"),
		listExtensions: () => get<ExtensionsResponseWire>("/v1/extensions"),
		getExtensionSettings: (slug) =>
			get<ExtensionSettingsWire>(
				`/v1/extensions/${encodeURIComponent(slug)}/settings`,
			),
		putExtensionSettings: (slug, value) =>
			send(
				"PUT",
				`/v1/extensions/${encodeURIComponent(slug)}/settings`,
				value,
			) as Promise<ExtensionSettingsWire>,
		listExtensionSecrets: (slug) =>
			get<ExtensionSecretsResponseWire>(
				`/v1/extensions/${encodeURIComponent(slug)}/secrets`,
			),
		putExtensionSecret: (slug, key, value) =>
			send(
				"PUT",
				`/v1/extensions/${encodeURIComponent(slug)}/secrets/${encodeURIComponent(key)}`,
				{ value },
			) as Promise<ExtensionSecretsResponseWire>,
		deleteExtensionSecret: (slug, key) =>
			send(
				"DELETE",
				`/v1/extensions/${encodeURIComponent(slug)}/secrets/${encodeURIComponent(key)}`,
				{},
			) as Promise<ExtensionSecretsResponseWire>,
		listProviders: () => get<ProvidersResponseWire>("/v1/providers"),
		putProviderCredential: (id, apiKey) =>
			send(
				"PUT",
				`/v1/providers/${encodeURIComponent(id)}/credential`,
				{ apiKey },
			) as Promise<AuthCheckProviderWire>,
		deleteProviderCredential: (id) =>
			send(
				"DELETE",
				`/v1/providers/${encodeURIComponent(id)}/credential`,
				{},
			) as Promise<AuthCheckProviderWire>,
		refreshProvider: (id) =>
			send(
				"POST",
				`/v1/providers/${encodeURIComponent(id)}/refresh`,
				{},
			) as Promise<AuthCheckProviderWire>,
		listJobs: () => get<JobsResponse>("/v1/jobs"),
		runJob: (id) =>
			send("POST", `/v1/jobs/${encodeURIComponent(id)}/run`, {}) as Promise<
				JobRunResponse
		>,
		listJobRuns: (id, limit) =>
			get<JobRunsResponse>(
				`/v1/jobs/${encodeURIComponent(id)}/runs` +
					(limit === undefined ? "" : `?limit=${limit}`),
			),
		listJobRevisions: (id) =>
			get<JobRevisionsResponse>(
				`/v1/jobs/${encodeURIComponent(id)}/revisions`,
			),
	};
}
