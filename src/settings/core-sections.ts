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
 * General, Tools and Advanced generate from `core-schema.ts`; their
 * fields' apply values come from the schema (the registry derives the
 * same values). The remaining cove sections keep their declarations.
 */

import type { SettingsSectionDef } from "../extension.js";
import { generatedCoreForm } from "./core-schema.js";

/** The reserved slug the core sections mount under (spec §13.4). */
export const CORE_SECTIONS_SLUG = "core";

/** Every section's id, in nav order (the sections route serves it). */
export const CORE_SECTION_IDS = [
	"general",
	"tools",
	"interface",
	"advanced",
	"providers",
	"extensions",
	"accounts",
	"tokens",
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
		form: generatedCoreForm("general").form,
	},
	{
		id: "tools",
		title: "Tools",
		icon: "edit",
		form: generatedCoreForm("tools").form,
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
		form: generatedCoreForm("advanced").form,
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
								apply: "restart",
							},
							{
								type: "number",
								name: "server.providers.refreshIntervalMinutes",
								label: "Model catalog refresh (minutes)",
								help: "The provider catalog refresh cadence; a change re-arms the scheduler live",
								apply: "live",
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
								apply: "restart",
								syntax: "code",
								lang: "json",
								rows: 12,
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
								apply: "restart",
							},
							{
								type: "toggle",
								// Absent means ON (the built-in set defaults enabled).
								default: true,
								name: "builtinExtensions.mcp",
								label: "MCP",
								help: "The built-in MCP extension — applies at restart",
								apply: "restart",
							},
							{
								type: "toggle",
								// Absent means ON (the built-in set defaults enabled).
								default: true,
								name: "builtinExtensions.toolSearch",
								label: "Tool search",
								help: "The built-in tool-search extension — applies at restart",
								apply: "restart",
							},
							{
								type: "toggle",
								// Absent means ON (the built-in set defaults enabled).
								default: true,
								name: "builtinExtensions.gateway",
								label: "Gateway",
								help: "The built-in channel gateway engine — applies at restart",
								apply: "restart",
							},
							{
								type: "toggle",
								default: true,
								name: "builtinExtensions.oauth",
								label: "OAuth login",
								help: "The built-in OIDC/OAuth2 login extension — applies at restart",
								apply: "restart",
							},
							{
								type: "toggle",
								// Absent means ON (the built-in set defaults enabled).
								default: true,
								name: "builtinExtensions.curator",
								label: "Curator",
								help: "The built-in curator extension — applies at restart",
								apply: "restart",
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
	{
		id: "tokens",
		title: "API tokens",
		// NOT "key" (General and Account links already use it); "lock" is
		// the credential-affordance glyph from the same closed icon set.
		icon: "lock",
		// Per-user credential management, not an administrator-only section.
		admin: false,
		// The channels render their native tokens cove over this entry
		// (the create/revoke surface is the /v1/auth/tokens route family,
		// not a settings-object write).
		form: {
			v: 1,
			root: {
				type: "form",
				id: "core-tokens-form",
				bind: "/settings",
				mode: "submit",
				onSubmit: "save",
				submitLabel: "Save",
				children: [],
			},
		},
	},
];
