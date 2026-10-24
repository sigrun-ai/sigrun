/**
 * The settings-section surface adapter (UI-blocks U4 Task 3, spec
 * §13.3): turns one extension-declared `SettingsSectionDef` into a
 * `SurfaceDef<"settings">` the surface service serves under the
 * extension's own `/v1/ext/<slug>/surfaces/<id>` mount — core's own
 * sections (Task 4) use the same renderer under the reserved `core`
 * slug, so core and extensions render settings from ONE code path.
 *
 * - `render` returns the declared form (validated at load with the
 *   `settings` placement) with one appended `secret` field per declared
 *   secret (spec §13.4 — a declaration without a field never renders),
 *   plus `data` = the current `settings/<slug>.json` object minus
 *   secret-typed field values (`settings`) and the declared secrets'
 *   statuses (`secrets`: `stored` / `env` / absent — the channels'
 *   secret field renders those as `set (stored)` / `set (env)` / `not
 *   set`; values NEVER appear, spec §7.7's never-read-back rule).
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
import type { JsonObject, JsonValue } from "@sigrun/shared/blocks";
import type {
	ActionResult,
	Principal,
	SettingsSectionDef,
	SurfaceDef,
	SurfaceRenderResult,
} from "../../extension.js";
import type { SharedExtensionStores } from "../../harness/stores.js";
import type { SettingsStore } from "../../harness/settings.js";
import {
	pendingRestart,
	type SettingsBootSnapshot,
} from "../../settings/pending.js";
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
	/** The absent-means-default value (toggles; §13.4 fix). */
	readonly default?: unknown;
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

/**
 * Per-slug write serialization (§13.3's read-merge-write): every
 * section of one slug shares `settings/<slug>.json`, so the chains
 * live at module scope keyed by slug (a chain is ordering, not data —
 * a stale chain from another server instance is inert). Without it,
 * two interleaved saves from two sections of one extension silently
 * drop each other's keys.
 */
const writeChains = new Map<string, Promise<void>>();

function enqueueWrite<T>(slug: string, work: () => Promise<T>): Promise<T> {
	const run = (writeChains.get(slug) ?? Promise.resolve()).then(work);
	writeChains.set(
		slug,
		run.then(
			() => undefined,
			() => undefined,
		),
	);
	return run;
}

/**
 * Append one `secret` field per declared secret to the form's root
 * children (the tree shape is a plain JSON object — spec §4.1). A
 * non-object root or one without a children array passes through
 * verbatim (the loader already validated the settings placement).
 */
function withAppendedSecretFields(
	form: SettingsSectionDef["form"],
	appended: readonly { key: string; label: string; help?: string }[],
): SettingsSectionDef["form"] {
	if (appended.length === 0) return form;
	const root = form.root;
	if (!isRec(root)) return form;
	const children = Array.isArray(root.children) ? root.children : [];
	const fields = appended.map((secret) => ({
		type: "secret",
		name: secret.key,
		label: secret.label,
		...(secret.help === undefined ? {} : { help: secret.help }),
	}));
	// SAFETY: root is a plain JSON record from the loader-validated
	// settings placement (its root is a form block); adding a children
	// array of secret-field objects keeps it a valid Block tree. The
	// `Block` union type can't express the property-addition spread, so
	// the rebuild narrows through `unknown`.
	return {
		...form,
		root: { ...root, children: [...children, ...fields] } as unknown as typeof form.root,
	};
}

/** The env knob mirroring one core key, when one exists (the
 *  General/Providers sections' "env wins" notes). Only the keys the
 *  core forms render are listed. */
const ENV_OVERRIDES: Readonly<Record<string, string>> = {
	defaultModel: "SIGRUN_DEFAULT_MODEL",
	"defaultProvider.baseUrl": "OPENAI_BASE_URL",
	"server.port": "SIGRUN_PORT",
	"server.publicUrl": "SIGRUN_PUBLIC_URL",
	"server.timezone": "SIGRUN_TZ",
	"server.providers.refreshIntervalMinutes": "SIGRUN_PROVIDER_REFRESH_MINUTES",
	"server.compaction.enabled": "SIGRUN_COMPACTION",
};

/** Read one flattened dotted path out of a nested record (the value
 *  is a JSON value by the settings file's validation). */
function readDotted(source: Record<string, unknown>, path: string): JsonValue | undefined {
	let node: unknown = source;
	for (const key of path.split(".")) {
		if (typeof node !== "object" || node === null || Array.isArray(node)) {
			return undefined;
		}
		node = (node as Record<string, unknown>)[key];
	}
	return node as JsonValue | undefined;
}

/** Write one flattened dotted path into a nested patch record. */
function writeDotted(
	target: Record<string, unknown>,
	path: string,
	value: unknown,
): void {
	const keys = path.split(".");
	let node = target;
	for (let i = 0; i < keys.length - 1; i++) {
		const key = keys[i];
		if (key === undefined) return;
		const next = node[key];
		if (typeof next !== "object" || next === null || Array.isArray(next)) {
			node[key] = {};
		}
		node = node[key] as Record<string, unknown>;
	}
	const last = keys[keys.length - 1];
	if (last !== undefined) node[last] = value;
}

/** The `meta` block the core sections' renders carry: the pending
 *  restart diff (the callout's key list), the env-override map for
 *  the rendered keys, and the supervised flag. */
function pendingContext(core: {
	readonly settings: SettingsStore;
	readonly bootSnapshot: SettingsBootSnapshot;
	readonly env: Readonly<Record<string, string | undefined>>;
}): {
	readonly pendingRestart: string[];
	readonly env: JsonObject;
	readonly supervised: boolean;
} {
	const file = core.settings.read();
	const env: JsonObject = {};
	for (const [key, envName] of Object.entries(ENV_OVERRIDES)) {
		if (core.env[envName] !== undefined) env[key] = envName;
	}
	return {
		pendingRestart: [...pendingRestart(file, core.bootSnapshot)],
		env,
		supervised: core.env.SIGRUN_SUPERVISED === "1" || core.env.SIGRUN_SUPERVISED === "true",
	};
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
	/**
	 * The core-sections deps (UI-blocks U4 Task 4): present exactly when
	 * `slug === "core"` — the core sections read/write the core
	 * SettingsStore (dotted field names land at their nested paths,
	 * apply-typed against the §13.1 registry), not the extension
	 * settings dir, so the same renderer covers both. `toolRoster` is
	 * the boot registry's tool names (the Tools section's default-tools
	 * editor's options).
	 */
	readonly core?: {
		readonly settings: SettingsStore;
		readonly bootSnapshot: SettingsBootSnapshot;
		readonly env: Readonly<Record<string, string | undefined>>;
		readonly toolRoster: readonly string[];
	};
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
	// Secret-typed fields NEVER land in the plaintext settings file
	// (§5.6/§13.4 write-only): saves route them to the secrets store and
	// reads exclude them from `data.settings`.
	const secretFieldNames = new Set(
		fields
			.filter((field) => field.type === "secret")
			.map((field) => field.name),
	);
	// Declared secrets whose keys are not already covered by a form
	// field get one appended `secret` field each (a declaration must
	// render — spec §13.4). The field NAME is the secret key, so the
	// save below routes it to the secrets store.
	const declared = section.secrets ?? [];
	const appended = declared.filter(
		(secret) => !secretFieldNames.has(secret.key),
	);
	const form = withAppendedSecretFields(section.form, appended);
	const allSecretFieldNames = new Set([
		...secretFieldNames,
		...appended.map((secret) => secret.key),
	]);


	const accessFor = (principal: Principal): "write" | "none" => {
		if (admin) {
			return isSuperuser(principal) || principal.admin ? "write" : "none";
		}
		return "write";
	};

	// ─── Core sections (U4 Task 4): the same renderer, over the core ──
	// SettingsStore (dotted names land at nested paths, apply-typed).
	const core = options.core;

	/** The core read: the SettingsStore's effective values at the
	 *  fields' dotted names, plus the boot/meta block the pending
	 *  callout + version line read. */
	const readCoreData = (): JsonObject => {
		if (options.core === undefined) {
			throw new Error("core settings section adapted without core deps");
		}
		// SAFETY: SettingsFile is a plain validated JSON document; the
		// JsonObject narrowing is the read-side projection the field walk
		// consumes (readDotted reads unknown values out of it).
		const file = options.core.settings.read() as unknown as JsonObject;
		const settings: JsonObject = {};
		for (const field of fields) {
			const value = readDotted(file, field.name);
			if (value !== undefined) settings[field.name] = value;
		}
		const { pendingRestart, env, supervised } = pendingContext(options.core);
		return {
			settings,
			meta: {
				pendingRestart,
				env,
				supervised,
			} satisfies JsonObject,
			// The Tools section's default-tools editor binds its options
			// here (the boot registry's tool names — the roster can only
			// come from the server; an empty literal would render a dead
			// checkbox list). The binding's shape is ChoiceOption[]
			// (`{id, label}` rows, spec §5.6).
			toolRoster: options.core.toolRoster.map((name) => ({ id: name, label: name })),
		};
	};

	/** The core save: fold the dotted field names into one core-store
	 *  patch (longtext fields parse raw JSON — the Tools/Advanced raw
	 *  object fields), apply it through the store, and fire the §13.2
	 *  path with the flattened key paths the write touched. */
	const saveCore = async (values: Record<string, unknown>): Promise<ActionResult> => {
		if (options.core === undefined) {
			throw new Error("core settings section adapted without core deps");
		}
		// SAFETY: SettingsFile is a plain validated JSON document; the
		// read here is the pre-patch state the default-skip below keys on.
		const current = options.core.settings.read() as unknown as JsonObject;
		let patch: Record<string, unknown> = {};
		for (const [name, raw] of Object.entries(values)) {
			const field = fields.find((candidate) => candidate.name === name);
			if (field === undefined) {
				return { ok: false, error: { message: `unknown field: ${name}`, field: name } };
			}
			// A submitted value EQUAL to the field's declared default with
			// NO stored key is the untouched state: the channels
			// initialize an absent default-ON toggle to the default and
			// submit every field, so an unedited default-on toggle would
			// otherwise pin an explicit key a fresh install never had.
			// Skipping keeps absent = default; explicitly flipping OFF the
			// default writes the key, and re-enabling a stored `false`
			// writes the `true` (the key is present, so no skip).
			if (
				field.default !== undefined &&
				raw === field.default &&
				readDotted(current, name) === undefined
			) {
				continue;
			}
			// Empty-string values CLEAR the key (the nullable fields'
			// "(server default)" affordance): null rides the store's
			// delete-key merge.
			let value: unknown = raw;
			if (field.type === "longtext") {
				if (typeof raw === "string" && raw.trim() !== "") {
					let parsed: unknown;
					try {
						parsed = JSON.parse(raw);
					} catch (cause) {
						return {
							ok: false,
							error: {
								message: `${name}: invalid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
								field: name,
							},
						};
					}
					value = parsed;
				}
			}
			// An empty STRING is the unset affordance (the nullable
			// fields' "(server default)" gesture): it CLEARS the key —
			// `null` rides the store's delete-key merge (settings.ts:
			// a null value clears the key; a null sub-field clears that
			// sub-field). A clear of a key nothing STORES is a no-op and
			// drops out here: the strict store validation reads a null
			// under a number-only sub-section as "must be a number", so a
			// full-form save on a fresh install (every nullable field
			// empty) would otherwise reject on never-present keys.
			if (raw === "") {
				if (readDotted(current, name) !== undefined) {
					writeDotted(patch, name, null);
				}
				continue;
			}
			writeDotted(patch, name, value);
		}
		try {
			const outcome = options.core.settings.apply(patch);
			// The §13.2 publish rides the store's onWrite sink (boot wired
			// it); the save only reports. `outcome` carries the touched
			// flattened paths; nothing else to do here.
			void outcome;
		} catch (cause) {
			return {
				ok: false,
				error: {
					message: cause instanceof Error ? cause.message : String(cause),
				},
			};
		}
		return { ok: true };
	};

	const readData = async (): Promise<{ settings: JsonObject; secrets: JsonObject }> => {
		const stored = (await stores.settingsFor(slug).get()) as JsonObject;
		// Secret-typed field values never render (§5.6/§13.4 write-only —
		// the plaintext settings file shouldn't carry them either, but an
		// older version or a hand edit may have left one behind). Secret
		// STATUSES live at the field's own pointer under the form bind
		// (`settings/<name>`) as the channels' contract strings
		// (`stored`/`env`; an unset key is absent and renders "not set")
		// — both channels resolve a secret field's status at
		// `<bind>/<name>`. Values NEVER appear (§5.6/§7.7).
		const settings: JsonObject = {};
		for (const [name, value] of Object.entries(stored)) {
			if (!allSecretFieldNames.has(name)) settings[name] = value;
		}
		const secrets: JsonObject = {};
		if (section.secrets !== undefined) {
			const listed = await stores.secretKeys(slug);
			const byKey = new Map(listed.map((entry) => [entry.key, entry.source]));
			for (const secret of section.secrets) {
				const source = byKey.get(secret.key);
				if (source !== undefined) {
					secrets[secret.key] = source;
					settings[secret.key] = source;
				}
			}
		}
		return { settings, secrets };
	};

	return {
		id: section.id,
		title: section.title,
		icon: section.icon ?? "key",
		placement: "settings",
		// The data payload is identical for every principal with access,
		// so reads never advance the concurrency rev (the save action's
		// optimistic check compares against it; §7.3).
		sharedData: true,
		render: async (ctx): Promise<SurfaceRenderResult> => {
			const access = accessFor(ctx.principal);
			return {
				tree: form,
				data:
					access === "none"
						? {}
						: core === undefined
							? await readData()
							: readCoreData(),
				access,
			};
		},
		actions: {
			save: async (ctx, payload): Promise<ActionResult> => {
				const parsed = parseSavePayload(payload);
				if (parsed === undefined) {
					return { ok: false, error: { message: "save expects {rev, values}" } };
				}
				// Optimistic concurrency (Review Focus 3): the rev the caller's
				// data read was based on must still be the instance's current
				// rev. `ctx.key` is the instance key the service resolved this
				// request under — never a hardcoded one (a params-carrying
				// request must not bypass the check).
				const rev = service.currentRev(slug, section.id, ctx.key);
				if (parsed.rev !== rev) {
					return {
						ok: false,
						error: { message: "changed by someone else" },
					};
				}
				// The core sections save through the core store (the field
				// fold + apply classification live in saveCore).
				if (core !== undefined) {
					return await saveCore(parsed.values);
				}
				// Validate every submitted value against the form's fields
				// (appended secret fields validate as string secrets);
				// unknown submitted keys reject (the form owns the write
				// surface; unknown STORED keys survive untouched below).
				const byName = new Map<string, FormField>([
					...fields.map((field) => [field.name, field] as const),
					...appended.map(
						(secret) =>
							[secret.key, { name: secret.key, type: "secret" }] as const,
					),
				]);
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
				// Split secret-typed values from plain settings values: an
				// empty/absent secret submission means "unchanged" (an
				// untouched write-only field submits nothing meaningful —
				// §5.6); a non-empty string writes the secrets store, never
				// the plaintext settings file.
				const secretWrites: { key: string; value: string }[] = [];
				const plainValues: Record<string, unknown> = {};
				for (const [name, value] of Object.entries(parsed.values)) {
					if (allSecretFieldNames.has(name)) {
						if (typeof value === "string" && value !== "") {
							secretWrites.push({ key: name, value });
						}
						continue;
					}
					plainValues[name] = value;
				}
				// Merge into the stored object (unknown stored keys survive —
				// Review Focus 5), write, and fire the §13.2 change path with
				// the top-level keys the write touched. The per-slug promise
				// chain serializes read-merge-writes across this slug's
				// sections so interleaved saves can't drop each other's keys.
				return enqueueWrite(slug, async (): Promise<ActionResult> => {
					for (const write of secretWrites) {
						await stores.setSecret(slug, write.key, write.value);
					}
					const stored = await stores.settingsFor(slug).get();
					const next = { ...stored, ...plainValues };
					// A secret-typed field that previously leaked into the
					// settings file is dropped by the next save (it lives in
					// the secrets store from now on).
					for (const name of allSecretFieldNames) {
						delete next[name];
					}
					await stores.settingsFor(slug).set(next);
					publishSettingsChanged({ extension: slug }, Object.keys(parsed.values));
					return { ok: true };
				});
			},
		},
	};
}
