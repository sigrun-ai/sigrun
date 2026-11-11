/**
 * The core settings sections (General, Interface, Advanced, Providers,
 * Account links, API tokens) declared as `SettingsSectionDef`s under the
 * reserved `core` slug. The Tools section's fields have moved into
 * Advanced (its first group is `Tools`). Sections carry a `group`
 * ("mine" or "system"); the route returns system-group sections to
 * admins only.
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
 * General and Advanced generate from `core-schema.ts`; their fields'
 * apply values come from the schema (the registry derives the same
 * values). Tools' fields are now Advanced's first group. The remaining
 * cove sections keep their declarations. Each section's nav grouping
 * ("mine" or "system") is `CORE_SECTION_GROUP` below.
 */

import type { SettingsSectionDef } from "../extension.js";
import { generatedCoreForm } from "./core-schema.js";
import { applyOf } from "./registry.js";

/** The reserved slug the core sections mount under (spec §13.4). */
export const CORE_SECTIONS_SLUG = "core";

/** The My-settings / System-settings group a core section belongs to. */
export const CORE_SECTION_GROUP: Readonly<Record<string, "mine" | "system">> = {
	interface: "mine",
	accounts: "mine",
	tokens: "mine",
	general: "system",
	models: "system",
	advanced: "system",
	providers: "system",
};

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
		id: "models",
		title: "Models",
		icon: "key",
		form: generatedCoreForm("models").form,
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

/** Every section's id, in nav order — derived from CORE_SETTINGS_SECTIONS
 *  so the section array is the ONE order source (the sections route zips
 *  the two positionally; later tasks insert sections mid-array). */
export const CORE_SECTION_IDS = CORE_SETTINGS_SECTIONS.map((s) => s.id);

export type CoreSectionId = (typeof CORE_SECTION_IDS)[number];
