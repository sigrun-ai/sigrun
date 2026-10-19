/**
 * The TUI's typed §5 HTTP client (Task 4).
 *
 * Wire shapes are the channel contract — imported from the
 * `@sigrun/shared` package (`views`, plus `SessionMeta`/`SlashCommand`
 * siblings), the single source of truth shared with the server and the
 * webui (build-and-webui Task 1: the tui is a pure client of the wire,
 * never a relative importer of server source).
 *
 * Identity seam (Task 2): the configured `user` rides EVERY request as the
 * `X-Sigrun-User` header; absent/empty user omits it entirely — the
 * server's naive mode. The bearer token (Task 7) rides every request as
 * `authorization: Bearer <token>` when configured.
 *
 * Fail-loud: a non-2xx rejects with a {@link SigrunApiError} carrying the
 * status and the server's parsed error body (`{error: ...}`), never a
 * silent `undefined` the UI could misrender as empty state.
 */

import type { CommandsResponse } from "@sigrun/shared/commands";
import type { SessionMeta, SessionMetaPatch } from "@sigrun/shared/session-meta";
import type {
	AbortResponse,
	AmbientList,
	CompactResponse,
	ConfigureResponse,
	ConversationCreateResponse,
	ConversationForkResponse,
	ConversationList,
	ConversationViewWire,
	InteractionAnswered,
	InteractionList,
	ModelsResponse,
	SettingsResponse,
	SubmissionResponse,
} from "@sigrun/shared/views";

export type {
	AbortResponse,
	AmbientList,
	AmbientWire,
	CompactResponse,
	ConfigureResponse,
	ConversationCreateResponse,
	ConversationForkResponse,
	ConversationList,
	ConversationSummary,
	ConversationViewWire,
	InteractionAnswered,
	InteractionList,
	InteractionWire,
	ModelEntry,
	ModelsResponse,
	SettingsResponse,
	SubmissionResponse,
} from "@sigrun/shared/views";
export type { CommandsResponse, SlashCommand } from "@sigrun/shared/commands";
export type { SessionMeta, SessionMetaPatch } from "@sigrun/shared/session-meta";

/** One answer to a pending interaction (the ONE generic route's body). */
export interface InteractionAnswerInput {
	readonly ids?: readonly string[];
	readonly values?: Readonly<Record<string, string | number | boolean>>;
	readonly text?: string;
}

/** The `whenBusy` admission modes the server accepts (spec §7 item 3). */
export type WhenBusyMode = "steer" | "followUp" | "reject";

/** A non-2xx response: status + the server's parsed error body. */
export class SigrunApiError extends Error {
	readonly status: number;
	readonly body: unknown;
	constructor(method: string, path: string, status: number, body: unknown) {
		super(`sigrun api: ${method} ${path} failed with status ${status}`);
		this.name = "SigrunApiError";
		this.status = status;
		this.body = body;
	}
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
	text(): Promise<string>;
}>;

export interface SigrunClientOptions {
	/**
	 * The server's origin (e.g. `http://127.0.0.1:PORT`) — the TUI is a
	 * remote client, so unlike the webui there is no same-origin default.
	 */
	readonly baseUrl: string;
	/**
	 * The `X-Sigrun-User` identity (Task 2). Absent/empty/whitespace → the
	 * header is omitted entirely (the server's naive mode).
	 */
	readonly user?: string;
	/**
	 * A bearer token (Task 7): rides EVERY request as
	 * `authorization: Bearer <token>`. Absent/empty/whitespace → omitted.
	 * The launcher threads `SIGRUN_TOKEN` here — the env beats tui.json.
	 */
	readonly token?: string;
	/** Injected for tests; defaults to the ambient `fetch`. */
	readonly fetch?: FetchLike;
}

/** The typed §5 client. See {@link SigrunClientOptions} for the seams. */
export class SigrunClient {
	readonly #baseUrl: string;
	readonly #fetch: FetchLike;
	readonly #headers: Record<string, string>;

	constructor(options: SigrunClientOptions) {
		// A trailing slash would double every route's leading one
		// (`--server http://host/` → `//v1/...`) — normalize once.
		this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
		this.#fetch =
			options.fetch ??
			(((input, init) => globalThis.fetch(input, init)) as FetchLike);
		const user = options.user?.trim();
		const token = options.token?.trim();
		this.#headers = {
			accept: "application/json",
			...(user === undefined || user === "" ? {} : { "x-sigrun-user": user }),
			...(token === undefined || token === ""
				? {}
				: { authorization: `Bearer ${token}` }),
		};
	}

	async #get<T>(path: string): Promise<T> {
		const response = await this.#fetch(`${this.#baseUrl}${path}`, {
			method: "GET",
			headers: this.#headers,
		});
		if (!response.ok) {
			throw new SigrunApiError("GET", path, response.status, await response.json().catch(() => undefined));
		}
		return (await response.json()) as T;
	}

	async #send<T>(method: "POST" | "PATCH", path: string, body: unknown): Promise<T> {
		const response = await this.#fetch(`${this.#baseUrl}${path}`, {
			method,
			headers: { ...this.#headers, "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		if (!response.ok) {
			throw new SigrunApiError(method, path, response.status, await response.json().catch(() => undefined));
		}
		return (await response.json()) as T;
	}

	/** `GET /v1/conversations` — all durable conversations (Task 3). */
	listConversations(): Promise<ConversationList> {
		return this.#get("/v1/conversations");
	}

	/** `GET /v1/conversations/:id` — the full wire view (one frame). */
	getConversation(id: number): Promise<ConversationViewWire> {
		return this.#get(`/v1/conversations/${id}`);
	}

	/** `POST /v1/conversations` — the new id plus its first view frame. */
	createConversation(): Promise<ConversationCreateResponse> {
		return this.#send("POST", "/v1/conversations", {});
	}

	/** `POST /v1/conversations/:id/fork` (absent `at` = the newest entry). */
	forkConversation(id: number, at?: number): Promise<ConversationForkResponse> {
		return this.#send("POST", `/v1/conversations/${id}/fork`, {
			...(at === undefined ? {} : { at }),
		});
	}

	/**
	 * `POST /v1/conversations/:id/submissions` — plain text input; 202 at
	 * ADMISSION (§7.1) with the record as it stands. The TUI is
	 * fire-and-forget: the reply arrives as view revisions on the stream,
	 * not from this response.
	 */
	submit(
		id: number,
		text: string,
		whenBusy?: WhenBusyMode,
	): Promise<SubmissionResponse> {
		return this.#send("POST", `/v1/conversations/${id}/submissions`, {
			input: [{ type: "text", text }],
			...(whenBusy === undefined ? {} : { whenBusy }),
		});
	}

	/** `POST /v1/conversations/:id/abort`. */
	abort(id: number): Promise<AbortResponse> {
		return this.#send("POST", `/v1/conversations/${id}/abort`, {});
	}

	/**
	 * `POST /v1/conversations/:id/compact` — admits a manual compaction;
	 * the summary entry arrives later as a view revision on the stream.
	 */
	compact(id: number, instructions?: string): Promise<CompactResponse> {
		return this.#send("POST", `/v1/conversations/${id}/compact`, {
			...(instructions === undefined || instructions === ""
				? {}
				: { instructions }),
		});
	}

	/** `GET /v1/conversations/:id/meta`. */
	getMeta(id: number): Promise<SessionMeta> {
		return this.#get(`/v1/conversations/${id}/meta`);
	}

	/** `PATCH /v1/conversations/:id/meta` — merges; resolves to the new meta. */
	patchMeta(id: number, patch: SessionMetaPatch): Promise<SessionMeta> {
		return this.#send("PATCH", `/v1/conversations/${id}/meta`, patch);
	}

	/** `GET /v1/conversations/:id/interactions` — pending interactions. */
	listInteractions(id: number): Promise<InteractionList> {
		return this.#get(`/v1/conversations/${id}/interactions`);
	}

	/** `POST .../interactions/:callId/answer` — the ONE generic answer route. */
	answerInteraction(
		id: number,
		callId: string,
		answer: InteractionAnswerInput,
	): Promise<InteractionAnswered> {
		return this.#send(
			"POST",
			`/v1/conversations/${id}/interactions/${encodeURIComponent(callId)}/answer`,
			answer,
		);
	}

	/** `GET /v1/conversations/:id/ambient`. */
	getAmbient(id: number): Promise<AmbientList> {
		return this.#get(`/v1/conversations/${id}/ambient`);
	}

	/** `GET /v1/commands` — the slash-command catalog (a boot constant). */
	getCommands(): Promise<CommandsResponse> {
		return this.#get("/v1/commands");
	}

	/** `GET /v1/settings` — the effective settings (absent file = `{}`). */
	getSettings(): Promise<SettingsResponse> {
		return this.#get("/v1/settings");
	}

	/** `GET /v1/models` — the chat-model catalog (the model picker's items). */
	listModels(): Promise<ModelsResponse> {
		return this.#get("/v1/models");
	}

	/**
	 * `POST /v1/conversations/:id/configure` — change the model and/or
	 * thinking level (T9c-i). At least one field is required (the server
	 * rejects an empty change as `invalid_body`).
	 */
	configure(
		id: number,
		body: { readonly model?: string; readonly thinking?: string },
	): Promise<ConfigureResponse> {
		return this.#send("POST", `/v1/conversations/${id}/configure`, body);
	}
}
