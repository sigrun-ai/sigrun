/**
 * The core settings sections (UI-blocks U4 Task 4, spec §13.4): the
 * sections the webui settings panel has today (General, Tools,
 * Interface, Advanced, Providers, Extensions) declared as
 * `SettingsSectionDef`s under the reserved `core` slug, so core and
 * extensions render settings through ONE renderer (the settings-surface
 * adapter, `src/server/surfaces/settings-surfaces.ts`, mounted under
 * `/v1/ext/core/surfaces/<id>`).
 *
 * Scope rulings (plan Task 4):
 * - **Jobs** stays its own rail panel — NO settings section here (the
 *   `jobs` and `jobHistory.*` keys remain file/API-surface only).
 * - **Interface** (client prefs + theme) and **Providers** (the §7.6
 *   credential flows) are the special coves: both render as
 *   channels-native components, not forms (the Interface fields bind
 *   client state, not server data; the credential route family is not
 *   a settings-object write). Their declarations still exist so the
 *   section LIST and the search index cover them; their forms are
 *   minimal and never rendered by the channels.
 * - **Extensions** is likewise cove-rendered: the extension-list editor
 *   (raw JSON + write-only secrets) is not a settings form. Its
 *   declaration covers the `extensions` install list key in the index.
 *
 * Every field declares its `apply` verbatim from the §13.1 registry
 * (`src/settings/registry.ts`) — the core settings test pins the two
 * against each other (a registry entry whose core section renders it
 * with a different apply fails the suite).
 */

import type { SettingsSectionDef } from "../extension.js";
import { CORE_SETTING_KEYS } from "./registry.js";

/** The reserved slug the core sections mount under (spec §13.4). */
export const CORE_SECTIONS_SLUG = "core";

/** The registry entry for one key (throws when the registry lost it —
 *  the core-sections test's coverage pin makes that impossible). */
function applyOf(key: string): "live" | "restart" {
	const entry = CORE_SETTING_KEYS.find((candidate) => candidate.key === key);
	if (entry === undefined) {
		throw new Error(`core-sections: no registry entry for ${key}`);
	}
	return entry.apply;
}

/** Every section's id, in nav order (the sections route serves it). */
export const CORE_SECTION_IDS = [
	"general",
	"tools",
	"interface",
	"advanced",
	"providers",
	"extensions",
	"accounts",
] as const;

export type CoreSectionId = (typeof CORE_SECTION_IDS)[number];

/**
 * The core settings sections, in nav order (the sections route serves
 * them first, before the extensions' sections).
 *
 * A `StackBlock` section child inside a `form` keeps fields grouped the
 * way the old panel grouped them (the settings placement allows
 * `section` blocks inside forms; the group's fields keep their own
 * `name`s under the form's `/settings` bind).
 */
export const CORE_SETTINGS_SECTIONS: readonly SettingsSectionDef[] = [
	{
		id: "general",
		title: "General",
		icon: "key",
		form: {
			v: 1,
			root: {
				type: "form",
				id: "core-general-form",
				bind: "/settings",
				mode: "submit",
				onSubmit: "save",
				submitLabel: "Save",
				children: [
					{
						type: "section",
						id: "core-general-queue",
						title: "Queueing",
						children: [
							{
								type: "choice",
								name: "steeringMode",
								label: "Steering mode",
								help: "How a message sent while a run is live steers it; empty = the pi-durable default (one-at-a-time)",
								apply: applyOf("steeringMode"),
								options: [
									{ id: "one-at-a-time", label: "One at a time" },
									{ id: "all", label: "All" },
								],
							},
							{
								type: "choice",
								name: "followUpMode",
								label: "Follow-up mode",
								help: "How queued follow-ups deliver after a run settles; empty = the pi-durable default",
								apply: applyOf("followUpMode"),
								options: [
									{ id: "one-at-a-time", label: "One at a time" },
									{ id: "all", label: "All" },
								],
							},
						],
					},
					{
						type: "section",
						id: "core-general-models",
						title: "Models",
						children: [
							{
								type: "text",
								name: "defaultModel",
								label: "Default model",
								help: "The boot default model (provider/model-id); env SIGRUN_DEFAULT_MODEL wins over the file — a change applies at restart",
								apply: applyOf("defaultModel"),
							},
							{
								type: "text",
								name: "namingModel",
								label: "Naming model",
								help: "The model the conversation auto-namer completes through (provider/model-id); absent = the default model",
								apply: applyOf("namingModel"),
							},
						],
					},
					{
						type: "section",
						id: "core-general-behaviour",
						title: "Behaviour",
						children: [
							{
								type: "number",
								name: "skills.sectionMaxBytes",
								label: "Skills section size cap",
								help: "The skills prompt section's byte cap (truncation notice included)",
								apply: applyOf("skills.sectionMaxBytes"),
							},
							{
								type: "text",
								name: "notifications.runSettled",
								label: "Run-settled notifications",
								help: "When a settled run notifies (default: unwatched)",
								apply: applyOf("notifications.runSettled"),
							},
						],
					},
				],
			},
		},
	},
	{
		id: "tools",
		title: "Tools",
		icon: "edit",
		form: {
			v: 1,
			root: {
				type: "form",
				id: "core-tools-form",
				bind: "/settings",
				mode: "submit",
				onSubmit: "save",
				submitLabel: "Save",
				children: [
					{
						type: "section",
						id: "core-tools-defaults",
						title: "Defaults",
						children: [
							{
								type: "choice",
								name: "defaultTools",
								label: "Default tools",
								help: "The model-offered tool filter for new conversations (empty = every installed tool); the filter hides listed tools and can never disable them all",
								apply: applyOf("defaultTools"),
								multi: true,
								// The roster is server data (the boot registry's tool
								// names), bound from the core surface's data block — a
								// literal list would drift from the installed tools.
								options: { $: "/toolRoster" },
							},
							{
								type: "toggle",
								// Absent means ON (boot reads `?? true`): the channels
								// initialize the untouched toggle ON and the save skips
								// the key while it sits at the default.
								default: true,
								name: "autoEnableCodemode",
								label: "Auto-enable codemode",
								help: "When an enabled MCP server exposes codemode, keep the codemode tool (or tool_search) in new conversations' default set",
								apply: applyOf("autoEnableCodemode"),
							},
						],
					},
				],
			},
		},
	},
	{
		id: "interface",
		title: "Interface",
		icon: "image",
		// Client-side prefs + theme (usePrefs / useTheme): the channels
		// render their native Interface controls over this section's
		// entry; the empty form satisfies the section contract and keeps
		// the search index's title row.
		form: {
			v: 1,
			root: {
				type: "form",
				id: "core-interface-form",
				bind: "/settings",
				mode: "submit",
				onSubmit: "save",
				submitLabel: "Save",
				children: [],
			},
		},
	},
	{
		id: "advanced",
		title: "Advanced",
		icon: "more",
		form: {
			v: 1,
			root: {
				type: "form",
				id: "core-advanced-form",
				bind: "/settings",
				mode: "submit",
				onSubmit: "save",
				submitLabel: "Save",
				children: [
					{
						type: "section",
						id: "core-advanced-resilience",
						title: "Retries and streaming",
						children: [
							{
								type: "toggle",
								// Absent means ON (pi-durable's retry policy defaults on).
								default: true,
								name: "retry.enabled",
								label: "Retry enabled",
								help: "pi-durable's retry policy for failed requests",
								apply: applyOf("retry.enabled"),
							},
							{
								type: "number",
								name: "retry.maxRetries",
								label: "Max retries",
								help: "pi-durable retry.maxRetries",
								apply: applyOf("retry.maxRetries"),
							},
							{
								type: "number",
								name: "retry.baseDelayMs",
								label: "Retry base delay (ms)",
								apply: applyOf("retry.baseDelayMs"),
							},
							{
								type: "number",
								name: "retry.maxAgentDelayMs",
								label: "Max agent delay (ms)",
								apply: applyOf("retry.maxAgentDelayMs"),
							},
							{
								type: "number",
								name: "stream.timeoutMs",
								label: "Stream timeout (ms)",
								apply: applyOf("stream.timeoutMs"),
							},
							{
								type: "number",
								name: "stream.maxRetries",
								label: "Stream max retries",
								apply: applyOf("stream.maxRetries"),
							},
							{
								type: "number",
								name: "stream.maxRetryDelayMs",
								label: "Stream max retry delay (ms)",
								apply: applyOf("stream.maxRetryDelayMs"),
							},
						],
					},
					{
						type: "section",
						id: "core-advanced-models",
						title: "Model overrides",
						children: [
							{
								type: "longtext",
								name: "perModelThinking",
								label: "Per-model thinking (raw JSON)",
								help: 'A raw JSON object — "provider/modelId": thinking level (off, minimal, low, medium, high, xhigh, max); empty clears',
								apply: applyOf("perModelThinking"),
								syntax: "code",
								lang: "json",
								rows: 6,
							},
						],
					},
					{
						type: "section",
						id: "core-advanced-server",
						title: "Server",
						children: [
							{
								type: "number",
								name: "server.port",
								label: "Listen port",
								help: "The listener binds at boot — a change applies at restart",
								apply: applyOf("server.port"),
								min: 1,
								max: 65535,
							},
							{
								type: "text",
								name: "server.publicUrl",
								label: "Public URL",
								help: "The deployment's absolute base URL (extension-route URLs and notification deep links)",
								apply: applyOf("server.publicUrl"),
							},
							{
								type: "text",
								name: "server.timezone",
								label: "Jobs default timezone",
								help: "The IANA zone jobs without an explicit timezone schedule in",
								apply: applyOf("server.timezone"),
							},
						],
					},
					{
						type: "section",
						id: "core-advanced-compaction",
						title: "Compaction",
						children: [
							{
								type: "toggle",
								// Absent means ON (the boot compaction policy defaults on).
								default: true,
								name: "server.compaction.enabled",
								label: "Compaction enabled",
								apply: applyOf("server.compaction.enabled"),
							},
							{
								type: "number",
								name: "server.compaction.reserveTokens",
								label: "Reserve tokens",
								apply: applyOf("server.compaction.reserveTokens"),
							},
							{
								type: "number",
								name: "server.compaction.keepRecentTokens",
								label: "Keep recent tokens",
								apply: applyOf("server.compaction.keepRecentTokens"),
							},
							{
								type: "number",
								name: "server.compaction.backgroundTokens",
								label: "Background tokens",
								apply: applyOf("server.compaction.backgroundTokens"),
							},
						],
					},
					{
						type: "section",
						id: "core-advanced-history",
						title: "Job history retention",
						children: [
							{
								type: "number",
								name: "jobHistory.runs",
								label: "Runs kept per job",
								apply: applyOf("jobHistory.runs"),
							},
							{
								type: "number",
								name: "jobHistory.revisions",
								label: "Revisions kept per job",
								apply: applyOf("jobHistory.revisions"),
							},
						],
					},
				],
			},
		},
	},
	{
		id: "providers",
		title: "Providers",
		icon: "cloud",
		// The §7.6 credential flows (readiness rows + write-only key
		// fields + the bounded refresh): the channels render their native
		// Providers cove over this entry. The form carries the one
		// provider-adjacent SETTINGS key (the refresh cadence).
		form: {
			v: 1,
			root: {
				type: "form",
				id: "core-providers-form",
				bind: "/settings",
				mode: "submit",
				onSubmit: "save",
				submitLabel: "Save",
				children: [
					{
						type: "section",
						id: "core-providers-defaults",
						title: "Defaults",
						children: [
							{
								type: "text",
								name: "defaultProvider.baseUrl",
								label: "Default provider base URL",
								help: "The env-driven OpenAI-compatible provider's endpoint (applied when OPENAI_BASE_URL is absent) — a change applies at restart",
								apply: applyOf("defaultProvider.baseUrl"),
							},
							{
								type: "number",
								name: "server.providers.refreshIntervalMinutes",
								label: "Model catalog refresh (minutes)",
								help: "The provider catalog refresh cadence; a change re-arms the scheduler live",
								apply: applyOf("server.providers.refreshIntervalMinutes"),
							},
						],
					},
				],
			},
		},
	},
	{
		id: "extensions",
		title: "Extensions",
		icon: "add",
		// The extension-list editor (per-extension raw JSON + write-only
		// secrets) is the channels' cove; the form carries the core
		// extension knobs (the install list + the built-in toggles).
		form: {
			v: 1,
			root: {
				type: "form",
				id: "core-extensions-form",
				bind: "/settings",
				mode: "submit",
				onSubmit: "save",
				submitLabel: "Save",
				children: [
					{
						type: "section",
						id: "core-extensions-list",
						title: "Installed extensions",
						children: [
							{
								type: "longtext",
								name: "extensions",
								label: "Extension list (raw JSON)",
								help: "The unified install-and-load list (npm specifiers, bare names, file:/git sources, or {source, entry?, ref?, enabled?} objects) — applied at boot reconciliation, so a change applies at restart",
								apply: applyOf("extensions"),
								syntax: "code",
								lang: "json",
								rows: 4,
							},
						],
					},
					{
						type: "section",
						id: "core-extensions-builtins",
						title: "Built-in extensions",
						children: [
							{
								type: "toggle",
								// Absent means ON (the built-in set defaults enabled).
								default: true,
								name: "builtinExtensions.codemode",
								label: "Codemode",
								help: "The built-in codemode extension (a disabled built-in never loads) — applies at restart",
								apply: applyOf("builtinExtensions.codemode"),
							},
							{
								type: "toggle",
								// Absent means ON (the built-in set defaults enabled).
								default: true,
								name: "builtinExtensions.mcp",
								label: "MCP",
								help: "The built-in MCP extension — applies at restart",
								apply: applyOf("builtinExtensions.mcp"),
							},
							{
								type: "toggle",
								// Absent means ON (the built-in set defaults enabled).
								default: true,
								name: "builtinExtensions.toolSearch",
								label: "Tool search",
								help: "The built-in tool-search extension — applies at restart",
								apply: applyOf("builtinExtensions.toolSearch"),
							},
						],
					},
				],
			},
		},
	},
	{
		id: "accounts",
		title: "Account links",
		icon: "key",
		// Per-user identity management, not an administrator-only section.
		admin: false,
		// The channels render their native account-link cove over this entry.
		form: {
			v: 1,
			root: {
				type: "form",
				id: "core-accounts-form",
				bind: "/settings",
				mode: "submit",
				onSubmit: "save",
				submitLabel: "Save",
				children: [],
			},
		},
	},
];
