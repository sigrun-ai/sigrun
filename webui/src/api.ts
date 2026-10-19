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
 * `ConversationViewWire`/`ToolSlotWire`/`LiveDocWire` — views.ts DOES
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
	SlashCommand as CommandWire,
	SessionMeta as ConversationMeta,
} from "@sigrun/shared/views";

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
	SlashCommand as CommandWire,
	SessionMeta as ConversationMeta,
} from "@sigrun/shared/views";

// The interaction/ambient seam sub-shapes — the seam records ARE the wire
// (never projected), so their constituent primitives are the contract too.
// The `*Wire` aliases keep the stable export names the seam renderers use.
export type {
	InteractionStatus,
	InteractionOption as InteractionOptionWire,
	InteractionField as InteractionFieldWire,
	InteractionDiff as InteractionDiffWire,
	InteractionBody as InteractionBodyWire,
	AmbientMetrics as AmbientMetricsWire,
	AmbientRow as AmbientRowWire,
	AmbientLine as AmbientLineWire,
	AmbientGauge as AmbientGaugeWire,
	AmbientLedgerEntry as AmbientLedgerEntryWire,
	AmbientBody as AmbientBodyWire,
} from "@sigrun/shared/views";

/** The queue modes (`steeringMode`/`followUpMode`; pi-durable `QueueMode`). */
export type QueueModeWire = "all" | "one-at-a-time";

/**
 * A PATCH body for `/v1/settings`: a merge where an explicit `null` CLEARS
 * the key. The server validates per key (unknown key / wrong type → 400
 * `invalid_field`). `toolRoster` is deliberately OMITTED — it is
 * server-computed, not a settable key; sending it would 400 (`is not a
 * settable field`), and the type-level Omit makes that unrepresentable
 * here.
 */
export type SettingsPatchWire = {
	readonly [K in keyof Omit<SettingsWire, "toolRoster">]?: SettingsWire[K] | null;
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
 * The `docs["pi.live"]` LiveState doc, narrowed to what the webui reads.
 * Shape per pi-durable dist/harness/live.d.ts: `run` (present exactly while
 * busy — the steer field derives from it server-side), `generation.message`
 * (the committed throttled partial of the in-flight response), `tools`
 * (live tool slots), `compactions` (live compaction tasks),
 * `compactionFailure` (the newest failure — a completed compaction clears
 * it; nothing-to-compact or a fault leaves it).
 */
export interface LiveDocWire {
	readonly run?: unknown;
	readonly generation?: { readonly message?: unknown };
	readonly tools?: readonly ToolSlotWire[];
	readonly compactions?: readonly unknown[];
	readonly compactionFailure?: { readonly error?: unknown };
}

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
	 * Materialize an upload (`POST .../uploads` with `{name, contentBase64}`);
	 * resolves to the workspace-relative path a submission part consumes.
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
	 * Answer a pending interaction (the ONE generic route). `answer` is
	 * `{ids?, values?, text?}`; resolution semantics stay extension-owned.
	 */
	answerInteraction(
		conversationId: number,
		callId: string,
		answer: {
			readonly ids?: readonly string[];
			readonly values?: Readonly<Record<string, string | number | boolean>>;
			readonly text?: string;
		},
	): Promise<InteractionAnsweredWire>;
	/** The conversation's ambient surfaces (`GET .../ambient`). */
	listAmbient(conversationId: number): Promise<AmbientListWire>;
	/** The effective settings (`GET /v1/settings`; absent file = `{}`). */
	getSettings(): Promise<SettingsWire>;
	/**
	 * Merge a settings patch (`PATCH /v1/settings`); an explicit `null`
	 * clears a key. Resolves to the new effective settings.
	 */
	patchSettings(patch: SettingsPatchWire): Promise<SettingsWire>;
}

/** The fetch surface the client needs (the real thing or a test stub). */
export type FetchLike = (
	input: string,
	init?: {
		readonly method?: string;
		readonly headers?: Record<string, string>;
		readonly body?: string;
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
}

/**
 * Bytes → base64 for the uploads body's `contentBase64`. Chunked: spreading
 * the full array into `String.fromCharCode` blows the call stack on large
 * files. `btoa` is a global in browsers AND in Node ≥16 (the test runner).
 */
function bytesToBase64(bytes: Uint8Array): string {
	const CHUNK = 0x8000;
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
	}
	return btoa(binary);
}

/** Create a §5 client. See {@link SigrunClientOptions} for the seams. */
export function createClient(options: SigrunClientOptions = {}): SigrunClient {
	const baseUrl = options.baseUrl ?? "";
	const fetchImpl: FetchLike =
		options.fetch ??
		(((input, init) =>
			globalThis.fetch(input, init)) as FetchLike);

	async function get<T>(path: string): Promise<T> {
		const response = await fetchImpl(`${baseUrl}${path}`, {
			method: "GET",
			headers: { accept: "application/json" },
		});
		if (!response.ok) {
			throw new Error(
				`sigrun api: GET ${path} failed with status ${response.status}`,
			);
		}
		return (await response.json()) as T;
	}

	/** POST/PATCH a JSON body; fail-loud on non-2xx. `parsed` returns the body. */
	async function send(
		method: "POST" | "PATCH",
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
			throw new Error(
				`sigrun api: ${method} ${path} failed with status ${response.status}`,
			);
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
			throw new Error(
				`sigrun api: GET ${path} failed with status ${response.status}`,
			);
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
			throw new Error(
				`sigrun api: POST ${path} failed with status ${response.status}`,
			);
		}
		return response.json();
	}

	return {
		getMeta: () => get<MetaResponse>("/v1/meta"),
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
			return (await send("POST", `/v1/conversations/${conversationId}/uploads`, {
				name: file.name,
				contentBase64: bytesToBase64(bytes),
			})) as UploadResponseWire;
		},
		compact: (conversationId, instructions) =>
			send("POST", `/v1/conversations/${conversationId}/compact`, {
				...(instructions === undefined || instructions === ""
					? {}
					: { instructions }),
			}) as Promise<CompactResponseWire>,
		listCommands: () => get<CommandsResponseWire>("/v1/commands"),
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
		answerInteraction: (conversationId, callId, answer) =>
			send(
				"POST",
				`/v1/conversations/${conversationId}/interactions/${encodeURIComponent(callId)}/answer`,
				answer,
			) as Promise<InteractionAnsweredWire>,
		listAmbient: (conversationId) =>
			get<AmbientListWire>(`/v1/conversations/${conversationId}/ambient`),
		getSettings: () => get<SettingsWire>("/v1/settings"),
		patchSettings: (patch) =>
			send("PATCH", "/v1/settings", patch) as Promise<SettingsWire>,
	};
}
