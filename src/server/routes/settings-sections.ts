/**
 * The settings sections route (UI-blocks U4 Task 4, spec §13.4):
 * `GET /v1/settings/sections` serves the settings panel's nav list and
 * the search index in one payload —
 *
 * ```
 * {
 *   sections: { slug, id, title, icon }[],        // core first, then extensions alphabetically
 *   index: { sectionId, slug, label, help, kind }[]  // every searchable row
 * }
 * ```
 *
 * The search index carries one row per core SETTINGS key (registry-driven —
 * `src/settings/registry.ts`, with the section + labels resolved from
 * `src/settings/core-sections.ts`), one row per extension-declared
 * section field (labels + help walked out of the form trees), and one
 * row per core section title (so "interface" lands somewhere). Section
 * trees are static per extension version, so the index builds ONCE per
 * request from the loaded bindings (cheap: the forms are small), never
 * persisted.
 */

import type { FastifyInstance } from "fastify";
import type { SettingsSectionDef } from "../../extension.js";
import type {
	SettingsSectionsResponse,
	SettingsSectionEntry,
	SettingsSectionIndexEntry,
} from "../views.js";
import {
	CORE_SECTION_IDS,
	CORE_SETTINGS_SECTIONS,
	type CoreSectionId,
} from "../../settings/core-sections.js";
import { CORE_SETTING_KEYS } from "../../settings/registry.js";
import type { ServerContext } from "../context.js";

/** One search-index row (the label search's hit shape) — the local name. */
export type SettingsIndexEntry = SettingsSectionIndexEntry;

/** The section entry name the build helper returns. */
export type { SettingsSectionEntry };

/** A plain record (the form-tree walk's node shape). */
type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Yield every field-ish node of one settings form: a record carrying a
 * string `name` and a `type` that is a FIELD type (not a container).
 * Walks `root`/`children`/`fields`/`item` — the loader-validated tree's
 * only nesting paths.
 */
function* walkFields(tree: unknown): Generator<{ name: string; label: string; help?: string }> {
	const stack: unknown[] = [tree];
	while (stack.length > 0) {
		const node = stack.pop();
		if (Array.isArray(node)) {
			stack.push(...node);
			continue;
		}
		if (!isRec(node)) continue;
		for (const key of ["children", "fields", "root", "item"]) {
			if (node[key] !== undefined) stack.push(node[key]);
		}
		if (typeof node.name === "string" && typeof node.type === "string") {
			const type = node.type;
			if (type !== "section" && type !== "form" && type !== "page" && type !== "stack") {
				yield {
					name: node.name,
					label: typeof node.label === "string" ? node.label : node.name,
					...(typeof node.help === "string" ? { help: node.help } : {}),
				};
			}
		}
	}
}

/** The core key → core section id resolution (the registry's `section`
 *  name, minus the keys whose section has no core surface). */
const REGISTRY_SECTION_TO_ID: Readonly<Record<string, CoreSectionId | undefined>> = {
	general: "general",
	tools: "tools",
	interface: "interface",
	advanced: "advanced",
	providers: "providers",
	extensions: "extensions",
	// `server`-section keys render under Advanced's Server group.
	server: "advanced",
};

/** The field label for one core key, walked out of the core sections. */
function coreFieldLabel(key: string): { label: string; help?: string } | undefined {
	for (const section of CORE_SETTINGS_SECTIONS) {
		for (const field of walkFields(section.form)) {
			if (field.name === key) return field;
		}
	}
	return undefined;
}

/** The index entry for one core registry key. */
function coreKeyEntry(key: string): SettingsIndexEntry | undefined {
	const registryEntry = CORE_SETTING_KEYS.find((entry) => entry.key === key);
	if (registryEntry === undefined) return undefined;
	const sectionId = REGISTRY_SECTION_TO_ID[registryEntry.section];
	if (sectionId === undefined) return undefined;
	const field = coreFieldLabel(key);
	return {
		slug: "core",
		sectionId,
		kind: "core-key",
		label: field?.label ?? key,
		...(field?.help === undefined ? {} : { help: field.help }),
		key,
	};
}

/** Build the section list + search index from the boot's bindings. */
export function buildSettingsSections(
	extensionSections: readonly {
		extension: string;
		defs: readonly SettingsSectionDef[];
	}[],
): SettingsSectionsResponse {
	const sections: SettingsSectionEntry[] = CORE_SETTINGS_SECTIONS.map((section) => ({
		slug: "core",
		id: section.id,
		title: section.title,
		icon: section.icon ?? "key",
	}));
	const sorted = [...extensionSections].sort((a, b) =>
		a.extension.localeCompare(b.extension),
	);
	for (const binding of sorted) {
		for (const def of binding.defs) {
			sections.push({
				slug: binding.extension,
				id: def.id,
				title: def.title,
				icon: def.icon ?? "key",
			});
		}
	}

	const index: SettingsIndexEntry[] = [];
	// Core section titles (a hit on the title lands on the section).
	for (const [position, id] of CORE_SECTION_IDS.entries()) {
		const section = CORE_SETTINGS_SECTIONS[position];
		if (section === undefined) continue;
		index.push({
			slug: "core",
			sectionId: id,
			kind: "section",
			label: section.title,
		});
	}
	// Core keys (registry-driven — every registry key whose section
	// renders gets a row).
	for (const entry of CORE_SETTING_KEYS) {
		const row = coreKeyEntry(entry.key);
		if (row !== undefined) index.push(row);
	}
	// Extension sections: titles + every field's label/help.
	for (const binding of sorted) {
		for (const def of binding.defs) {
			index.push({
				slug: binding.extension,
				sectionId: def.id,
				kind: "section",
				label: def.title,
			});
			for (const field of walkFields(def.form)) {
				index.push({
					slug: binding.extension,
					sectionId: def.id,
					kind: "field",
					label: field.label,
					...(field.help === undefined ? {} : { help: field.help }),
					key: field.name,
				});
			}
		}
	}
	return { sections, index };
}

/** Register `GET /v1/settings/sections` (admin — the settings surface
 *  is admin material; the panel is the only consumer). */
export function registerSettingsSectionsRoutes(
	app: FastifyInstance,
	ctx: ServerContext,
): void {
	app.get(
		"/v1/settings/sections",
		async (request, reply): Promise<SettingsSectionsResponse | { error: string }> => {
			if (!request.principal.admin) {
				return await reply.code(403).send({ error: "forbidden" });
			}
			return buildSettingsSections(ctx.opened.extensionSettingsSections);
		},
	);
}
