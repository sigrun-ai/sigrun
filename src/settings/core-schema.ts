/**
 * Core's settings.json schema and the three schema-generated sections.
 * Every registry leaf is present, including file/API-only settings; layout
 * inclusion decides which of them the General, Tools and Advanced forms draw.
 */

import {
	DEFAULT_AUTH,
	DEFAULT_BACKUP_STALE_AFTER_HOURS,
	DEFAULT_COMPACTION,
	DEFAULT_DECISION_TIMEOUT_MS,
	DEFAULT_MAX_FILE_READ_BYTES,
	DEFAULT_MAX_UPLOAD_BYTES,
	DEFAULT_MEMORY_SEAM,
	DEFAULT_PORT,
	DEFAULT_PROVIDER_REFRESH_MINUTES,
	DEFAULT_WEBUI_BUNDLE,
} from "../config.js";
import { DEFAULT_JOB_MAX_TURNS } from "../jobs/fire.js";
import { SKILLS_SECTION_LIMIT_BYTES } from "../skills/index.js";
import {
	generateForm,
	type GeneratedForm,
	type JsonSchema,
	type LayoutGroup,
} from "./schema/index.js";

const property = (
	title: string,
	description: string,
	defaultValue: unknown,
	apply: "live" | "restart",
	extra: Record<string, unknown> = {},
): JsonSchema => ({
	title,
	description,
	default: defaultValue,
	"x-sigrun-apply": apply,
	...extra,
});

const string = (
	title: string,
	description: string,
	defaultValue: unknown = undefined,
	apply: "live" | "restart" = "restart",
): JsonSchema => property(title, description, defaultValue, apply, { type: "string" });

const number = (
	title: string,
	description: string,
	defaultValue: number | undefined,
	apply: "live" | "restart" = "restart",
	extra: Record<string, unknown> = {},
): JsonSchema => property(title, description, defaultValue, apply, { type: "integer", ...extra });

const toggle = (
	title: string,
	description: string,
	defaultValue: boolean,
	apply: "live" | "restart" = "restart",
): JsonSchema => property(title, description, defaultValue, apply, { type: "boolean" });

const strings = (
	title: string,
	description: string,
	apply: "live" | "restart" = "restart",
): JsonSchema => property(title, description, [], apply, {
	type: "array",
	items: { type: "string" },
});

const object = (properties: Record<string, JsonSchema>): JsonSchema => ({
	type: "object",
	properties,
});

/** JSON Schema for core's persisted settings, including unrendered leaves. */
export const coreSchema: JsonSchema = {
	$schema: "https://json-schema.org/draft/2020-12/schema",
	type: "object",
	properties: {
		steeringMode: property(
			"Steering mode",
			"How a message sent while a run is live steers it; empty = the pi-durable default (one-at-a-time)",
			undefined,
			"live",
			{ oneOf: [
				{ const: "one-at-a-time", title: "One at a time" },
				{ const: "all", title: "All" },
			] },
		),
		followUpMode: property(
			"Follow-up mode",
			"How queued follow-ups deliver after a run settles; empty = the pi-durable default",
			undefined,
			"live",
			{ oneOf: [
				{ const: "one-at-a-time", title: "One at a time" },
				{ const: "all", title: "All" },
			] },
		),
		retry: object({
			enabled: toggle("Retry enabled", "pi-durable's retry policy for failed requests", true, "live"),
			maxRetries: number("Max retries", "pi-durable retry.maxRetries", undefined, "live"),
			baseDelayMs: number("Retry base delay (ms)", "", undefined, "live"),
			maxAgentDelayMs: number("Max agent delay (ms)", "", undefined, "live"),
		}),
		stream: object({
			timeoutMs: number("Stream timeout (ms)", "", undefined, "live"),
			maxRetries: number("Stream max retries", "", undefined, "live"),
			maxRetryDelayMs: number("Stream max retry delay (ms)", "", undefined, "live"),
		}),
		defaultTools: property(
			"Tools offered to the model",
			"Only the selected tools are offered to the model in new conversations; the others stay callable by other tools. Leave empty to offer every installed tool. Applies to conversations created after the change.",
			[],
			"live",
			{ type: "array", items: { type: "string" } },
		),
		perModelThinking: property(
			"Per-model thinking",
			'Thinking level by "provider/modelId"; empty clears',
			{},
			"live",
			{
				type: "object",
				additionalProperties: {
					type: "string",
					title: "Thinking level",
					enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
				},
			},
		),
		extensions: property("Extension list", "The unified install-and-load extension list", [], "restart", {
			type: "array",
			items: {},
		}),
		jobs: property("Jobs", "The file-declared job list", [], "restart", {
			type: "array",
			items: {},
		}),
		jobHistory: object({
			runs: number("Runs kept per job", "", 50, "live"),
			revisions: number("Revisions kept per job", "", 50, "live"),
		}),
		jobDefaults: object({
			maxTurns: number("Default max turns per job run", "", DEFAULT_JOB_MAX_TURNS, "live"),
		}),
		defaultModel: string(
			"Default model",
			"The boot default model (provider/model-id); env SIGRUN_DEFAULT_MODEL wins over the file — a change applies at restart",
		),
		namingModel: string(
			"Naming model",
			"The model the conversation auto-namer completes through (provider/model-id); absent = the default model",
			undefined,
			"live",
		),
		decisionModel: string("Decision model", "Default model for decision-provider evaluations", "", "live"),
		decisions: object({
			tool: toggle("Decision evaluation tool", "Whether decision_evaluate is enabled", false, "live"),
		}),
		embeddingModel: string(
			"Embedding model",
			"The model every extension embeds with, as provider/model. Unset: embeddings are off.",
			"",
			"live",
		),
		localProviders: {
			type: "array",
			items: { type: "string", minLength: 1 },
			title: "Local provider extensions",
			description:
				"Provider extensions trusted to receive local-only content. Includes chat, decision and embedding models. The pseudo-slug core covers the env-driven provider. Live.",
			default: [],
			"x-sigrun-apply": "live",
		},
		embeddings: object({
			localModels: {
				type: "array",
				items: { type: "string", minLength: 1 },
				title: "Local embedding models (deprecated)",
				description:
					"Deprecated: migrated to localProviders. Per-model embedding locality moved to the per-provider-extension switch.",
				default: [],
				"x-sigrun-apply": "live",
			},
		}),
		defaultProvider: object({
			baseUrl: string("Default provider base URL", "The env-driven OpenAI-compatible provider endpoint"),
		}),
		skills: object({
			sectionMaxBytes: number(
				"Skills section size cap",
				"The skills prompt section's byte cap (truncation notice included)",
				SKILLS_SECTION_LIMIT_BYTES,
				"live",
			),
		}),
		notifications: object({
			runSettled: string(
				"Run-settled notifications",
				"When a settled run notifies (default: unwatched)",
				undefined,
				"live",
			),
		}),
		builtinExtensions: object({
			codemode: toggle("Codemode", "The built-in codemode extension", true),
			mcp: toggle("MCP", "The built-in MCP extension", true),
			toolSearch: toggle("Tool search", "The built-in tool-search extension", true),
			gateway: toggle("Gateway", "The built-in channel gateway engine", true),
			oauth: toggle("OAuth login", "The built-in OIDC/OAuth2 login extension", true),
			curator: toggle("Curator", "The built-in curator extension", true),
		}),
		autoEnableCodemode: toggle(
			"Auto-enable codemode",
			"When an enabled MCP server exposes codemode, keep the codemode tool (or tool_search) in new conversations' default set",
			true,
			"live",
		),
		server: object({
			port: number(
				"Listen port",
				"The listener binds at boot — a change applies at restart",
				DEFAULT_PORT,
				"restart",
				{ minimum: 1, maximum: 65535 },
			),
			workspacePath: string("Workspace path", "Boot-resolved workspace root"),
			storagePath: string("Storage path", "Boot-resolved SQLite database path"),
			extensionsDir: string("Extensions directory", "Deprecated boot-resolved extension root"),
			maxUploadBytes: number("Maximum upload bytes", "Raw upload request body limit", DEFAULT_MAX_UPLOAD_BYTES),
			maxFileReadBytes: number("Maximum file-read bytes", "Raw file-read response cap", DEFAULT_MAX_FILE_READ_BYTES),
			dataDir: string("Data directory", "Boot-resolved durable data root"),
			cacheDir: string("Cache directory", "Boot-resolved cache root"),
			stateDir: string("State directory", "Boot-resolved state root"),
			publicUrl: string(
				"Public URL",
				"The deployment's absolute base URL (extension-route URLs and notification deep links)",
			),
			webui: object({
				enabled: toggle("Web UI enabled", "Whether the built-in web UI is mounted", true),
				bundle: string("Web UI bundle", "Contributed bundle name or bundle path", DEFAULT_WEBUI_BUNDLE),
			}),
			webuiBundle: string("Web UI bundle (deprecated)", "Deprecated alias of server.webui.bundle", DEFAULT_WEBUI_BUNDLE),
			timezone: string("Jobs default timezone", "The IANA zone jobs without an explicit timezone schedule in"),
			embeddings: object({
				timeoutMs: number(
					"Embedding timeout (ms)",
					"The embedding registry's per-call timeout cap",
					undefined,
					"live",
				),
			}),
			compaction: object({
				enabled: toggle("Compaction enabled", "", DEFAULT_COMPACTION.enabled),
				reserveTokens: number("Reserve tokens", "", DEFAULT_COMPACTION.reserveTokens),
				keepRecentTokens: number("Keep recent tokens", "", DEFAULT_COMPACTION.keepRecentTokens),
				backgroundTokens: number("Background tokens", "", DEFAULT_COMPACTION.backgroundTokens),
				modelOverrides: property("Compaction model overrides", "Per-model compaction policy overrides", {}, "restart", {
					type: "object",
					additionalProperties: { type: "object" },
				}),
			}),
			memorySeam: object({
				hookDeadlineMs: number("Hook deadline (ms)", "Memory-seam hook delivery deadline", DEFAULT_MEMORY_SEAM.hookDeadlineMs),
				idleThresholdMs: number("Idle threshold (ms)", "Memory-seam conversation idle threshold", DEFAULT_MEMORY_SEAM.idleThresholdMs),
				workerDeadlineMs: number("Worker deadline (ms)", "Memory-seam worker run deadline", DEFAULT_MEMORY_SEAM.workerDeadlineMs),
				queueMax: number("Event queue maximum", "Memory-seam event queue bound", DEFAULT_MEMORY_SEAM.queueMax),
			}),
			decisions: object({
				timeoutMs: number("Decision timeout (ms)", "Per-call decision-provider timeout", DEFAULT_DECISION_TIMEOUT_MS, "live"),
			}),
			providers: object({
				refreshIntervalMinutes: number(
					"Model catalog refresh (minutes)",
					"The provider catalog refresh cadence; a change re-arms the scheduler live",
					DEFAULT_PROVIDER_REFRESH_MINUTES,
					"live",
					{ minimum: 0 },
				),
			}),
			auth: object({
				methods: property("Authentication methods", "Enabled authentication methods", [], "restart", {
					type: "array",
					items: { type: "string", enum: ["token", "proxy"] },
				}),
				sessionDays: number("Session lifetime (days)", "Browser-session lifetime", DEFAULT_AUTH.sessionDays, "live"),
				proxy: object({
					trustedProxies: strings("Trusted proxies", "CIDR ranges trusted for forward authentication"),
					secretHeader: string("Proxy secret header", "Header carrying the forward-auth shared secret"),
					userHeader: string("Proxy user header", "Header carrying the authenticated username", "Remote-User"),
					groupsHeader: string("Proxy groups header", "Header carrying authenticated groups", "Remote-Groups"),
					nameHeader: string("Proxy name header", "Header carrying the display name", "Remote-Name"),
					emailHeader: string("Proxy email header", "Header carrying the email address", "Remote-Email"),
					autoProvision: toggle("Auto-provision users", "Create directory users from trusted proxy identities", true),
				}),
				adminGroups: strings("Admin groups", "Proxy groups that grant administrator access"),
				allowedHosts: strings("Allowed hosts", "Additional accepted Host values"),
				allowedOrigins: strings("Allowed origins", "Additional accepted Origin values"),
			}),
			metrics: object({
				public: toggle("Public metrics", "Expose /metrics without an authenticated principal", false),
			}),
			dev: toggle("Development mode", "Enable development metadata and diagnostics", false),
			supervised: toggle("Supervised", "Whether a supervisor restarts the process after an intentional exit", false),
			backup: object({
				path: string("Backup path", "Filesystem backup target"),
				staleAfterHours: number("Backup stale after (hours)", "Age before the last-success marker reports degraded", DEFAULT_BACKUP_STALE_AFTER_HOURS),
				s3: object({
					bucket: string("S3 bucket", "Object-storage backup bucket"),
					prefix: string("S3 prefix", "Object-storage backup key prefix"),
					endpoint: string("S3 endpoint", "Object-storage service endpoint"),
				}),
			}),
		}),
	},
};

/** Core's field grouping; unlisted schema properties remain file/API-only. */
export const CORE_LAYOUT: Record<"general" | "advanced", readonly LayoutGroup[]> = {
	general: [
		{ title: "Conversations", paths: ["/steeringMode", "/followUpMode"] },
		{ title: "Models", paths: ["/defaultModel", "/namingModel", "/decisionModel", "/embeddingModel"],
			overrides: {
				// Model pickers, not free text: options bind the served catalog
				// (the surface feeds `/modelRoster` per field — chat models for
				// defaultModel/namingModel, decision models for decisionModel,
				// embedding models for embeddingModel), with `allowOther` so a
				// not-yet-served id stays enterable (the value is provider/model).
				"/defaultModel": {
					type: "choice",
					presentation: "dropdown",
					options: { $: "/modelRoster/default" },
					allowOther: { label: "Other model id (provider/model)" },
				placeholder: undefined,
				},
				"/namingModel": {
					type: "choice",
					presentation: "dropdown",
					options: { $: "/modelRoster/default" },
					allowOther: { label: "Other model id (provider/model)" },
				placeholder: undefined,
				},
				"/decisionModel": {
					type: "choice",
					presentation: "dropdown",
					options: { $: "/modelRoster/decision" },
					allowOther: { label: "Other model id (provider/model)" },
				placeholder: undefined,
				},
				"/embeddingModel": {
					type: "choice",
					presentation: "dropdown",
					options: { $: "/modelRoster/embedding" },
					allowOther: { label: "Other model id (provider/model)" },
				placeholder: undefined,
				},
			} },
		{
			title: "Behaviour",
			paths: ["/skills/sectionMaxBytes", "/notifications/runSettled"],
			overrides: { "/skills/sectionMaxBytes": { placeholder: undefined } },
		},
	],
	advanced: [
		{
			title: "Tools",
			paths: ["/defaultTools", "/autoEnableCodemode"],
			overrides: {
				"/defaultTools": {
					type: "choice",
					multi: true,
					options: { $: "/toolRoster" },
					item: undefined,
				},
			},
		},
		{ title: "Retries and streaming", paths: [
			"/retry/enabled",
			"/retry/maxRetries",
			"/retry/baseDelayMs",
			"/retry/maxAgentDelayMs",
			"/stream/timeoutMs",
			"/stream/maxRetries",
			"/stream/maxRetryDelayMs",
		] },
		{
			title: "Model overrides",
			paths: ["/perModelThinking"],
			overrides: { "/perModelThinking": { keyLabel: "Model" } },
		},
		{
			title: "Server",
			paths: ["/server/port", "/server/publicUrl", "/server/timezone"],
			overrides: { "/server/port": { placeholder: undefined } },
		},
		{ title: "Compaction", paths: [
			"/server/compaction/enabled",
			"/server/compaction/reserveTokens",
			"/server/compaction/keepRecentTokens",
			"/server/compaction/backgroundTokens",
		], overrides: {
			"/server/compaction/reserveTokens": { placeholder: undefined },
			"/server/compaction/keepRecentTokens": { placeholder: undefined },
			"/server/compaction/backgroundTokens": { placeholder: undefined },
		} },
		{ title: "Embeddings", paths: [
			"/server/embeddings/timeoutMs",
		] },
		{ title: "Job history retention", paths: [
			"/jobHistory/runs",
			"/jobHistory/revisions",
			"/jobDefaults/maxTurns",
		], overrides: {
			"/jobHistory/runs": { placeholder: undefined },
			"/jobHistory/revisions": { placeholder: undefined },
			"/jobDefaults/maxTurns": { placeholder: undefined },
		} },
	],
};

/** Read one dotted registry key's schema node. */
export function coreProperty(key: string): JsonSchema | undefined {
	let node = coreSchema;
	for (const segment of key.split(".")) {
		const properties = node.properties;
		if (typeof properties !== "object" || properties === null) return undefined;
		const child = (properties as Record<string, unknown>)[segment];
		if (typeof child !== "object" || child === null || Array.isArray(child)) return undefined;
		node = child as JsonSchema;
	}
	return node;
}

/** Generate one core section with the section ids the channels already use. */
export function generatedCoreForm(id: keyof typeof CORE_LAYOUT): GeneratedForm {
	const generated = generateForm(coreSchema, { idPrefix: `core-${id}`, layout: CORE_LAYOUT[id] });
	const slugs: Record<string, string> = {
		Conversations: "queue",
		Models: "models",
		Behaviour: "behaviour",
		Defaults: "defaults",
		Tools: "tools",
		"Retries and streaming": "resilience",
		"Model overrides": "models",
		Server: "server",
		Compaction: "compaction",
		"Job history retention": "history",
	};
	const root = generated.form.root;
	if (root.type !== "form") throw new Error(`core-${id}: generated root is not a form`);
	for (const child of root.children) {
		if (child.type === "section" && typeof child.title === "string") {
			(child as { id?: string }).id = `core-${id}-${slugs[child.title] ?? child.title.toLowerCase()}`;
		}
	}
	return {
		...generated,
		form: { ...generated.form, root: { ...root, submitLabel: "Save" } },
	};
}
