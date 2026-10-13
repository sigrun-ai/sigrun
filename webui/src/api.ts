/**
 * Typed client for the sigrun §5 HTTP API (Task 20 scaffold subset:
 * `GET /v1/meta`, `GET /v1/conversations`, `GET /v1/models`).
 *
 * The wire interfaces here MIRROR the server's serializers
 * (`src/server/views.ts` + the `MetaResponse` interface in
 * `src/server/index.ts`) — the webui is a separate workspace package and
 * cannot import server sources (the server is NodeNext, the webui is
 * bundler-resolution). Keep these in sync by hand; the §5 shapes are the
 * stable contract the channel bundle consumes.
 *
 * The client is fail-loud: a non-2xx response rejects with an error naming
 * the status and path (never a silent `undefined` the UI could misrender as
 * empty state).
 */

/** The `GET /v1/meta` payload (mirrors `MetaResponse` in src/server/index.ts). */
export interface MetaResponse {
	readonly harnessVersion: string;
	readonly schemaVersion: string;
	readonly extensions: readonly {
		readonly name: string;
		readonly status: string;
		readonly error?: string;
	}[];
	readonly health: {
		readonly backup: "configured" | "unconfigured" | "degraded";
		readonly memory: "ok" | "degraded";
		readonly providers: "ok" | "degraded";
	};
	readonly capabilities: {
		readonly backup: boolean;
		readonly channels: readonly string[];
	};
}

/** One list item of `GET /v1/conversations` (mirrors `ConversationSummary`). */
export interface ConversationSummary {
	readonly id: number;
	readonly root: boolean;
	readonly entryCount: number;
}

/** The list response of `GET /v1/conversations`. */
export interface ConversationList {
	readonly conversations: readonly ConversationSummary[];
}

/**
 * The `GET /v1/conversations/:id/meta` payload (mirrors the server's meta
 * serializer). `PATCH /v1/conversations/:id/meta` MERGES a partial of this
 * shape (`{ archived: true }` archives).
 *
 * Mirrors the server's SessionMeta (src/server/session-meta.ts). Corrected in
 * the T23a review: `tagged` is a string array, `draft` is an object (the
 * per-session composer draft), `source` is the `"user" | "cron"` enum — the
 * first draft of this interface had all three wrong, which would have
 * rendered the DEFAULT_META fallback for every live conversation.
 */
export interface ConversationMeta {
	readonly pinned: boolean;
	readonly tagged: readonly string[];
	readonly archived: boolean;
	readonly draft: { readonly text: string; readonly attachments: readonly string[] };
	readonly source: "user" | "cron";
	readonly owner?: string;
	/** The user-facing session name; absent = unnamed (T5d). */
	readonly name?: string;
}

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

/** One `GET /v1/models` entry (mirrors `ModelEntry`). */
export interface ModelEntry {
	readonly id: string;
	readonly provider: string;
	readonly modelId: string;
	readonly name: string;
	readonly contextWindow: number;
	readonly maxTokens: number;
	readonly reasoning: boolean;
	readonly input: readonly string[];
	readonly cost: {
		readonly input: number;
		readonly output: number;
		readonly cacheRead: number;
		readonly cacheWrite: number;
	};
}

/** The response of `GET /v1/models`. */
export interface ModelsResponse {
	readonly models: readonly ModelEntry[];
}

/* -------------------------------------------------------------------------
 * Settings wire types (Task 8c) — mirror `SettingsFile` in
 * src/harness/settings.ts: GET /v1/settings serves the effective file
 * (absent file = `{}` — every default), PATCH /v1/settings merges (an
 * explicit null clears a key). Keep in sync by hand, same discipline as
 * the shapes above.
 * ---------------------------------------------------------------------- */

/** The queue modes (`steeringMode`/`followUpMode`; pi-durable `QueueMode`). */
export type QueueModeWire = "all" | "one-at-a-time";

/** The `/v1/settings` payload (mirrors `SettingsResponse`: `SettingsFile` + the server-computed roster). */
export interface SettingsWire {
	readonly steeringMode?: QueueModeWire;
	readonly followUpMode?: QueueModeWire;
	readonly retry?: {
		readonly enabled?: boolean;
		readonly maxRetries?: number;
		readonly baseDelayMs?: number;
		readonly maxAgentDelayMs?: number;
	};
	readonly stream?: {
		readonly timeoutMs?: number;
		readonly maxRetries?: number;
		readonly maxRetryDelayMs?: number;
	};
	readonly defaultTools?: readonly string[];
	readonly perModelThinking?: Readonly<Record<string, string>>;
	/**
	 * The live registry's tool names (server-computed per request, never
	 * persisted): the roster the `defaultTools` checkboxes render over.
	 * Optional for forward compatibility — a server that omits it falls
	 * back to the panel's bundled core list.
	 */
	readonly toolRoster?: readonly string[];
}

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

/* -------------------------------------------------------------------------
 * Conversation view stream wire types (Task 21) — same hand-mirror discipline
 * as the shapes above: they mirror the server's view serializer consumed by
 * `GET /v1/conversations/:id/stream` (`snapshot` + `view` frames). Keep in
 * sync by hand; the stream is the §5 full-immutable-revision contract.
 * ---------------------------------------------------------------------- */

/** One content block of a message (`{type: "text", text}`, image/file parts…). */
export interface ContentBlockWire {
	readonly type: string;
	readonly text?: string;
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
	readonly steer: { readonly busy: boolean; readonly queued: number };
}

/** One live tool slot of `docs["pi.live"]` (the LiveState tools list). */
export interface ToolSlotWire {
	readonly callId: string;
	readonly name: string;
	readonly status: string;
	readonly output?: string;
}

/**
 * The `docs["pi.live"]` LiveState doc, narrowed to what the webui reads
 * (`run`/`generation`/`compactions` are consumed by later tasks).
 */
export interface LiveDocWire {
	readonly run?: unknown;
	readonly generation?: unknown;
	readonly tools?: readonly ToolSlotWire[];
	readonly compactions?: unknown;
}

/** A pending approval (`GET /v1/conversations/:id/approvals` item). */
export interface ApprovalWire {
	readonly callId: string;
	readonly toolName: string;
	readonly status: string;
	readonly arguments?: unknown;
	readonly requestedAt?: number;
}

/** The response of `GET /v1/conversations/:id/approvals`. */
export interface ApprovalsResponse {
	readonly approvals: readonly ApprovalWire[];
}

/** The §5 approval decision enum (`allow | deny`). */
export type ApprovalDecision = "allow" | "deny";

/** One `GET /v1/conversations/:id/files` entry (mirrors `FileEntry`). */
export interface FileEntryWire {
	readonly name: string;
	readonly path: string;
	readonly kind: "file" | "directory" | "symlink";
	readonly size: number;
	readonly mtimeMs: number;
}

/** The list response of `GET /v1/conversations/:id/files` (mirrors `FileListResponse`). */
export interface FileListResponseWire {
	readonly entries: readonly FileEntryWire[];
}

/**
 * The read response of `GET /v1/conversations/:id/files/content` (mirrors
 * `FileContentResponse`): `"text"` when the bytes are strictly valid UTF-8,
 * else `"base64"`. `size` is the byte length; the server caps reads at 1 MiB
 * (413 `file_too_large` over the cap).
 */
export interface FileContentResponseWire {
	readonly encoding: "text" | "base64";
	readonly content: string;
	readonly size: number;
}

/** The response of `POST /v1/conversations/:id/uploads` (mirrors `UploadResponse`). */
export interface UploadResponseWire {
	/** The workspace-relative path a submission content part consumes. */
	readonly path: string;
}

/**
 * The admit response of `POST /v1/conversations/:id/compact` (manual
 * compaction): the durable task's id. The task is conversation-owned — it
 * compacts even when idle — and its `pi.compaction` summary entry lands as
 * a view revision (the SSE stream carries it).
 */
export interface CompactResponseWire {
	readonly taskId: number;
}

/**
 * The create-family response (`POST /v1/conversations`, `.../fork`,
 * `/v1/conversations/import` — mirrors `ConversationCreateResponse`): the
 * new conversation id plus its first view frame. `root`/`entryCount` are
 * list-projections the create routes never send, so this is its own shape.
 */
export interface ConversationCreatedWire {
	readonly id: number;
	readonly view: ConversationViewWire;
}

/** One `GET /v1/commands` entry (mirrors `SlashCommand` in src/server/commands.ts). */
export interface CommandWire {
	readonly name: string;
	readonly description: string;
	readonly argsHint?: string;
	readonly endpoint: { readonly method: string; readonly path: string };
}

/** The response of `GET /v1/commands`. */
export interface CommandsResponseWire {
	readonly commands: readonly CommandWire[];
}

/** The configure body (`POST .../configure`): exactly one field per call. */
export interface ConfigureInput {
	readonly model?: string;
	readonly thinking?: string;
}

/** The response of `POST .../configure` (mirrors `ConfigureResponse`). */
export interface ConfigureResponseWire {
	readonly model?: string;
	readonly thinkingLevel: string;
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

/**
 * The settled submission record returned by `POST
 * /v1/conversations/:id/submissions` (the server waits for settlement
 * server-side in v1 — mirrors `SubmissionResponse` in
 * src/server/views.ts).
 */
export interface SubmissionResponseWire {
	readonly id: number;
	readonly conversationId: number;
	readonly type: string;
	readonly status: string;
	readonly entry?: number;
	readonly answer?: number;
	readonly reason?: string;
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
	listApprovals(conversationId: number): Promise<ApprovalsResponse>;
	decideApproval(
		conversationId: number,
		approvalId: string,
		decision: ApprovalDecision,
	): Promise<void>;
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

	function post(path: string, body: unknown): Promise<void> {
		return send("POST", path, body).then(() => undefined);
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
		listApprovals: (conversationId) =>
			get<ApprovalsResponse>(`/v1/conversations/${conversationId}/approvals`),
		decideApproval: (conversationId, approvalId, decision) =>
			post(
				`/v1/conversations/${conversationId}/approvals/${encodeURIComponent(approvalId)}`,
				{ decision },
			),
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
		getSettings: () => get<SettingsWire>("/v1/settings"),
		patchSettings: (patch) =>
			send("PATCH", "/v1/settings", patch) as Promise<SettingsWire>,
	};
}
