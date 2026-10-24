/**
 * The settings-section surface adapter (UI-blocks U4 Task 3, spec
 * §13.3): turns one extension-declared `SettingsSectionDef` into a
 * `SurfaceDef<"settings">` the surface service serves under the
 * extension's own `/v1/ext/<slug>/surfaces/<id>` mount — core's own
 * sections (Task 4) use the same renderer under the reserved `core`
 * slug, so core and extensions render settings from ONE code path.
 *
 * - `render` returns the declared form verbatim (validated at load with
 *   the `settings` placement) plus `data` = the current
 *   `settings/<slug>.json` object verbatim (`settings`) and the
 *   declared secrets' statuses (`secrets`: `set (stored)` / `set
 *   (env)` / `not set` — values NEVER appear, spec §7.7's
 *   never-read-back rule).
 * - The `save` action takes `{rev, values}`: a stale `rev` rejects
 *   `{ok: false, error: {message: "changed by someone else"}}`
 *   (Review Focus 3); the values validate against the form's fields
 *   (unknown keys, wrong types, min/max/required violations reject
 *   field-scoped and write nothing); a valid save MERGES into the
 *   stored object (unknown stored keys survive — Review Focus 5),
 *   writes `settings/<slug>.json`, and fires the §13.2 change path
 *   with the top-level keys it touched.
 * - Access: `admin` sections (the default) are `write` for superusers
 *   and admins and `none` for everyone else (the route maps `none` to
 *   404 `surface_not_found`); `admin: false` sections are `write` for
 *   every authenticated principal.
 */

import { isSuperuser } from "../auth/principal.js";
import type { JsonObject } from "@sigrun/shared/blocks";
import type {
	ActionResult,
	Principal,
	SettingsSectionDef,
	SurfaceDef,
	SurfaceRenderResult,
} from "../../extension.js";
import type { ExtensionSettingsSectionBinding } from "../../harness/loader.js";
import type { SharedExtensionStores } from "../../harness/stores.js";
import { isLoopbackHost } from "../auth/loopback.js";
import type { SigrunConfig } from "../../config.js";
import type { SurfaceService } from "./service.js";

/** The save payload's shape (`{rev, values}`) — validated at runtime. */
interface SavePayload {
	readonly rev: number;
	readonly values: Record<string, unknown>;
}

/** Parse the save payload: `{rev, values}` or undefined (bad shape). */
function parseSavePayload(payload: unknown): SavePayload | undefined {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
		return undefined;
	}
	const record = payload as Record<string, unknown>;
	if (
		typeof record.rev !== "number" ||
		!Number.isInteger(record.rev) ||
		record.rev < 0
	) {
		return undefined;
	}
	if (
		typeof record.values !== "object" ||
		record.values === null ||
		Array.isArray(record.values)
	) {
		return undefined;
	}
	return { rev: record.rev, values: record.values as Record<string, unknown> };
}

/** The field entries a settings form's root declares (name + constraints). */
interface FormField {
	readonly name: string;
	readonly type: string;
	readonly required?: boolean;
	readonly min?: number;
	readonly max?: number;
	readonly minLength?: number;
	readonly maxLength?: number;
	readonly pattern?: string;
	readonly options?: unknown;
	readonly item?: unknown;
}

/** A plain record (the tree-walk's node shape). */
type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Collect the field entries of one section's form: every node carrying a
 * string `name` and a `type` in the field set, recursively (the loader
 * validated the tree — the walk only reads `children`/`fields`/`root`/
 * `item` and yields records; sections inside forms nest fields).
 */
function collectFormFields(tree: unknown): readonly FormField[] {
	const fields: FormField[] = [];
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
		if (isRec(node.block)) stack.push(node.block);
		if (typeof node.name === "string" && typeof node.type === "string") {
			const type = node.type;
			if (
				type !== "section" &&
				type !== "form" &&
				type !== "page" &&
				type !== "stack"
			) {
				// SAFETY: the loader validated the tree against the settings
				// placement, so every name-carrying non-container node is a
				// field; the cast narrows the record to the field shape.
				fields.push(node as unknown as FormField);
			}
		}
	}
	return fields;
}

/**
 * Validate one value against one field (the server-side half of the
 * channel's client-side check): required, type, min/max,
 * minLength/maxLength, pattern. Returns the violation message or null.
 */
function validateFieldValue(field: FormField, value: unknown): string | null {
	if (value === undefined || value === null || value === "") {
		if (field.required === true) return `${field.name} is required`;
		return null;
	}
	switch (field.type) {
		case "text":
		case "longtext":
		case "secret":
		case "date":
		case "datetime":
			if (typeof value !== "string") return `${field.name} must be a string`;
			if (field.minLength !== undefined && value.length < field.minLength) {
				return `${field.name} must be at least ${field.minLength} characters`;
			}
			if (field.maxLength !== undefined && value.length > field.maxLength) {
				return `${field.name} must be at most ${field.maxLength} characters`;
			}
			if (field.pattern !== undefined && !new RegExp(field.pattern).test(value)) {
				return `${field.name} does not match ${field.pattern}`;
			}
			return null;
		case "number": {
			if (typeof value !== "number") return `${field.name} must be a number`;
			if (field.min !== undefined && value < field.min) {
				return `${field.name} must be at least ${field.min}`;
			}
			if (field.max !== undefined && value > field.max) {
				return `${field.name} must be at most ${field.max}`;
			}
			return null;
		}
		case "toggle":
			if (typeof value !== "boolean") return `${field.name} must be a boolean`;
			return null;
		case "choice": {
			if (Array.isArray(value)) {
				if (!value.every((entry) => typeof entry === "string")) {
					return `${field.name} must be a list of option ids`;
				}
				return null;
			}
			if (typeof value !== "string") return `${field.name} must be an option id`;
			return null;
		}
		case "daterange":
		case "file":
			// Never reached (the settings placement excludes both); keep the
			// switch total for the compiler.
			return null;
		default:
			return null;
	}
}

/** The dependencies one adapted section closes over. */
export interface SettingsSurfaceOptions {
	readonly stores: SharedExtensionStores;
	/** The §13.2 change path (hub + onSettingsChanged + scheduler). */
	readonly publishSettingsChanged: (
		scope: "server" | { extension: string },
		keys: readonly string[],
	) => void;
	/** The surface service (the rev read the save's optimistic check needs). */
	readonly service: SurfaceService;
}

/**
 * Adapt one declared settings section to a `SurfaceDef<"settings">`.
 * The def closes over the slug + section id (the surface service keys
 * instances by `(slug, id, params-key)`; settings sections take NO
 * params, so the default `instanceKey({})` applies).
 */
export function settingsSurfaceFor(
	slug: string,
	section: SettingsSectionDef,
	options: SettingsSurfaceOptions,
): SurfaceDef<"settings"> {
	const { stores, publishSettingsChanged, service } = options;
	const admin = section.admin !== false;
	const fields = collectFormFields(section.form.root);
	// The instance key the section's ONE instance lives under.
	const instanceKey = JSON.stringify({});

	const accessFor = (principal: Principal): "write" | "none" => {
		if (admin) {
			return isSuperuser(principal) || principal.admin ? "write" : "none";
		}
		return "write";
	};

	const readData = async (): Promise<{ settings: JsonObject; secrets: JsonObject }> => {
		const settings = (await stores.settingsFor(slug).get()) as JsonObject;
		const secrets: JsonObject = {};
		if (section.secrets !== undefined) {
			const listed = await stores.secretKeys(slug);
			const byKey = new Map(listed.map((entry) => [entry.key, entry.source]));
			for (const declared of section.secrets) {
				const source = byKey.get(declared.key);
				secrets[declared.key] =
					source === "stored"
						? "set (stored)"
						: source === "env"
							? "set (env)"
							: "not set";
			}
		}
		return { settings, secrets };
	};

	return {
		id: section.id,
		title: section.title,
		icon: section.icon ?? "key",
		placement: "settings",
		render: async (ctx): Promise<SurfaceRenderResult> => {
			const access = accessFor(ctx.principal);
			return {
				tree: section.form,
				data: access === "none" ? {} : await readData(),
				access,
			};
		},
		actions: {
			save: async (_ctx, payload): Promise<ActionResult> => {
				const parsed = parseSavePayload(payload);
				if (parsed === undefined) {
					return { ok: false, error: { message: "save expects {rev, values}" } };
				}
				// Optimistic concurrency (Review Focus 3): the rev the caller's
				// data read was based on must still be the instance's current rev.
				// SAFETY: the service's per-instance state is private; the
				// optimistic-concurrency read reaches it through a narrow
				// structural seam (`currentRev`, added in this task).
				const state = service.currentRev(slug, section.id, instanceKey);
				if (state !== undefined && parsed.rev !== state) {
					return {
						ok: false,
						error: { message: "changed by someone else" },
					};
				}
				// Validate every submitted value against the form's fields;
				// unknown submitted keys reject (the form owns the write
				// surface; unknown STORED keys survive untouched below).
				const byName = new Map(fields.map((field) => [field.name, field]));
				for (const [name, value] of Object.entries(parsed.values)) {
					const field = byName.get(name);
					if (field === undefined) {
						return { ok: false, error: { message: `unknown field: ${name}`, field: name } };
					}
					const violation = validateFieldValue(field, value);
					if (violation !== null) {
						return { ok: false, error: { message: violation, field: name } };
					}
				}
				// Merge into the stored object (unknown stored keys survive —
				// Review Focus 5), write, and fire the §13.2 change path with
				// the top-level keys the write touched.
				const stored = await stores.settingsFor(slug).get();
				const next = { ...stored, ...parsed.values };
				await stores.settingsFor(slug).set(next);
				publishSettingsChanged({ extension: slug }, Object.keys(parsed.values));
				return { ok: true };
			},
		},
	};
}

/**
 * Adapt every loaded extension's declared settings sections into the
 * surface service's binding list (spec §13.4's one-renderer rule).
 * Returns the appended list — `createServer` builds the service over
 * `opened.extensionSurfaces` + these.
 */
export function appendSettingsSurfaces(
	bindings: readonly ExtensionSettingsSectionBinding[],
	options: SettingsSurfaceOptions,
): readonly { extension: string; defs: readonly SurfaceDef<"settings">[] }[] {
	return bindings.map((binding) => ({
		extension: binding.extension,
		defs: binding.defs.map((section) =>
			settingsSurfaceFor(binding.extension, section, options),
		),
	}));
}
