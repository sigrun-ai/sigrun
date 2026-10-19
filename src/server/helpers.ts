/**
 * Shared §5 server helpers: the validation vocabularies, the
 * store-derived agent change, and the per-conversation read/env seams
 * the route modules consume.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
	AgentChange,
	Conversation,
	ConversationId,
	InputSubmissionDraft,
	ModelRef,
	ToolRegistration,
} from "@earendil-works/pi-durable";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { AuthStatus } from "@sigrun/shared/views";
import {
	effectiveServerSection,
	type Env,
	type SigrunConfig,
} from "../config.js";
import type { OpenedHarness } from "../harness/boot.js";
import { DEFAULT_AUTH_KEY } from "../harness/auth.js";
import { OPENAI_API_KEY_ENV } from "../harness/providers/index.js";
import { SessionMetaDoc } from "./session-meta.js";
import {
	serializeConversationView,
	type SettingsResponse,
} from "./views.js";

/** The `thinking` values `configure` accepts (pi-ai `ModelThinkingLevel`). */
export const THINKING_LEVELS: readonly string[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

/**
 * The `whenBusy` values a submission accepts (pi-durable
 * `SubmissionDraft`'s full input union — the §5 client sends "steer";
 * "followUp" and "reject" are upstream's other busy semantics).
 */
export const WHEN_BUSY_MODES: readonly string[] = ["steer", "followUp", "reject"];
/** The validated `whenBusy` type (pi-durable `InputSubmissionDraft`). */
export type WhenBusyMode = NonNullable<InputSubmissionDraft["whenBusy"]>;

/**
 * The agent change every server-side conversation create applies: the
 * boot default model, plus the settings store's sigrun-resolved fields —
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
 * filter is never clobbered.
 */
export function storeAgentChange(
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
export const ID_PARAMS_SCHEMA = {
	type: "object",
	properties: { id: { type: "integer" } },
	required: ["id"],
	additionalProperties: false,
} as const;

/** The settings response over the live store + registry snapshot. */
/**
 * The `/v1/settings` payload (GET and the post-PATCH readback): the
 * file's effective contents, the registry-computed `toolRoster`, and
 * the `effective` block (spec §6.6) — every server key's resolved value
 * and source, computed PER REQUEST over the fresh file read (a PATCH
 * lands as a `file` source on the next GET) and the boot env/config.
 */
export function settingsResponse(
	opened: OpenedHarness,
	config: SigrunConfig,
	env: Env,
): SettingsResponse {
	const names = opened.registry
		.snapshot()
		.tools()
		.map((entry) => entry.tool.name);
	// Names may repeat across extensions (RegistrySnapshot.tools); the
	// panel keys checkboxes by name, so dedupe.
	const file = opened.settings.read();
	return {
		...file,
		toolRoster: [...new Set(names)],
		effective: effectiveServerSection(env, file.server, config),
	};
}

/** Re-brand a route id as a ConversationId (the branded Id type is a number). */
export function conversationId(id: number): ConversationId {
	return id as ConversationId;
}

/** Read one conversation's current view frame; disposes the state handle. */
export async function readView(conversation: Conversation) {
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
export async function stampSessionOwner(
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
export async function conversationEnv(
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
export const FILE_CONTENT_MAX_BYTES = 1024 * 1024;

/**
 * One provider's auth readiness, derived from boot-retained state (spec
 * §6.4 + provider plugins Task 6): the same three-priority chain
 * `GET /v1/auth/check` serves — (1) the owning contributor's readiness
 * tracker (three-state vocabulary, verbatim), (2) a tracker-less
 * contributor's legacy §3 producer mapping (ok→ready, degraded→invalid,
 * absent→not_ready), (3) the degenerate env provider's key-presence
 * mapping (auth.json "default"/own entry over `OPENAI_API_KEY`).
 * `producersByName` is the caller's per-request index of
 * `opened.providerHealth` (a producer is per-contributor, not
 * per-provider, so the owning contributor's producer is looked up by
 * name). Extracted for W2 Task 8: `GET /metrics` reports the same
 * per-provider statuses as `sigrun_provider_ready{provider,status}` —
 * ONE derivation, never two that can drift.
 */
export function providerAuthStatus(
	opened: OpenedHarness,
	providerId: string,
	producersByName: ReadonlyMap<
		string,
		{ readonly name: string; readonly health: () => "ok" | "degraded" }
	>,
): { readonly status: AuthStatus; readonly detail?: string } {
	const tracker = opened.providerReadiness.get(providerId);
	if (tracker !== undefined) {
		const readiness = tracker();
		return readiness.detail === undefined
			? { status: readiness.status }
			: { status: readiness.status, detail: readiness.detail };
	}
	const owner = opened.providerOwnership.get(providerId);
	if (owner !== undefined) {
		const producer = producersByName.get(owner);
		const status: AuthStatus =
			producer === undefined
				? "not_ready"
				: producer.health() === "ok"
					? "ready"
					: "invalid";
		return { status };
	}
	// The degenerate provider's key resolves auth.json (the "default"
	// magic key or the provider's own entry) BEFORE the OPENAI_API_KEY
	// env fallback. Presence only — key material never leaves the store. A
	// malformed auth file reads as no key rather than failing the caller.
	let storedKey = false;
	try {
		const authFile = opened.auth.read();
		storedKey =
			authFile[DEFAULT_AUTH_KEY]?.apiKey !== undefined ||
			authFile[providerId]?.apiKey !== undefined;
	} catch {
		storedKey = false;
	}
	return {
		status:
			storedKey || (opened.providerEnv[OPENAI_API_KEY_ENV] ?? "").trim() !== ""
				? "ready"
				: "not_ready",
	};
}

/**
 * One `scanConversations` page size for the listing route. Not a client
 * limit — the route walks the continuation cursor to completion (v1 is
 * unpaginated); a larger page only trades per-page round-trips.
 */
export const SCAN_PAGE_SIZE = 1_000;

/**
 * Decode a base64 body strictly: Node's `Buffer.from(s, "base64")` is
 * LENIENT (invalid characters are skipped, so `"!!!"` decodes to empty), so
 * uploads validate the alphabet and round-trip — invalid base64 is a client
 * error, never a silent partial decode.
 */
export function decodeBase64Strict(value: string): Buffer | undefined {
	const trimmed = value.trim();
	if (trimmed.length === 0 || trimmed.length % 4 !== 0) return undefined;
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(trimmed)) return undefined;
	const bytes = Buffer.from(trimmed, "base64");
	if (bytes.toString("base64") !== trimmed) return undefined;
	return bytes;
}
