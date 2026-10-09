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
	};
}
