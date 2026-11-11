/**
 * Settings rework Task 4 (spec §2): translate a JSON Schema (2020-12)
 * into the settings placement's form blocks.
 *
 * Pure: the same input schema always yields the same form, and the only
 * side effect is a load-time `console.warn` — one per property that falls
 * back to a JSON box and one per layout path the schema does not declare,
 * each naming its JSON-pointer path.
 *
 * `checkSchema` is the load-time gate (root object, local `$ref`
 * resolution, well-formed sigrun keywords, `x-sigrun-key` present where
 * an array item holds secrets). `assertDrawable` is the family-repo
 * proof: it throws listing every fallback path.
 */

import {
	BLOCK_SET_VERSION,
	type Field,
	type FieldBase,
	type FormBlock,
	type SectionBlock,
	type Tree,
	type VariantField,
} from "@sigrun/shared/blocks";
import {
	APPLY_KEYWORD,
	ENV_KEYWORD,
	KEY_KEYWORD,
	SUMMARY_KEYWORD,
	OVERRIDABLE_KEYWORD,
	applyOf,
	deref,
	envOf,
	hasNonDrawableKeyword,
	hasOtherNonDrawableKeyword,
	isRecord,
	keyOf,
	pointerEscape,
	pointerJoin,
	propertiesOf,
	resolveRef,
	summaryOf,
	unionBranches,
	type Apply,
	type JsonSchema,
} from "./keywords.js";

export { ENV_KEYWORD, envOf } from "./keywords.js";
export type { Apply, JsonSchema } from "./keywords.js";

/** A secret value location (spec §4). */
export interface SecretPath {
	/** JSON pointer with "*" for a table key or array identity segment, e.g. "/servers/*\/headers/*". */
	readonly pattern: string;
	/**
	 * The identity property of the nearest enclosing array item
	 * (`x-sigrun-key`). A table segment keys on its entry key, which the
	 * stored data carries; an array segment keys on this property's VALUE,
	 * which the path alone cannot name.
	 */
	readonly key?: string;
}

/** The secret path for one writeOnly slot, carrying its array identity. */
function secretPath(ctx: Ctx, pattern: string): SecretPath {
	return ctx.identity === undefined ? { pattern } : { pattern, key: ctx.identity };
}

/** One extension field's environment fallback. Core's env-backed keys use ENV_OVERRIDES instead. */
export interface EnvField {
	readonly name: string;
	readonly variable: string;
	readonly fallback?: string;
}

/** The generator's product: the form plus everything the save path needs. */
export interface GeneratedForm {
	readonly form: Tree; // a root `form`, bind "/settings", mode "submit", onSubmit "save"
	readonly secrets: readonly SecretPath[]; // every writeOnly property
	readonly fallbacks: readonly string[]; // JSON-pointer paths drawn as a JSON box
	readonly apply: ReadonlyMap<string, Apply>; // top-level property → apply
	readonly envFields: readonly EnvField[]; // extension-only string fields with an env fallback
}

/** Core's section layout (Task 8); extensions omit it. */
export interface LayoutGroup {
	readonly title: string;
	readonly paths: readonly string[]; // layout = inclusion: properties not listed are not rendered
	/** Per-path overrides merged over the generated field. An explicitly
	 *  undefined property deletes that generated property (e.g. a stale item). */
	readonly overrides?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

/** The result of the load-time schema check. */
export type SchemaCheck = { ok: true } | { ok: false; error: string };

/** A generated property: a field, or a titled nested object as a section. */
type PropertyNode = Field | SectionBlock;

// ─── drawable-subset recognition ─────────────────────────────────────────

/** `enum` / `oneOf` (or `anyOf`) of `{const, title}` → choice options, else undefined. */
function choiceOptions(schema: JsonSchema): { id: string; label: string }[] | undefined {
	if (Array.isArray(schema.enum) && schema.enum.every((v) => typeof v === "string")) {
		return schema.enum.map((v) => ({ id: v, label: v }));
	}
	const branches = unionBranches(schema);
	if (branches) {
		const options: { id: string; label: string }[] = [];
		for (const branch of branches) {
			if (!isRecord(branch) || typeof branch.const !== "string") return undefined;
			if (branch.type !== undefined && branch.type !== "string") return undefined;
			if (hasNonDrawableKeyword(branch)) return undefined;
			options.push({
				id: branch.const,
				label: typeof branch.title === "string" ? branch.title : branch.const,
			});
		}
		return options;
	}
	return undefined;
}

/** `oneOf` / `anyOf` of objects told apart by one shared const property. */
interface VariantBranch {
	readonly id: string;
	readonly label: string;
	readonly schema: JsonSchema;
	readonly discriminator: string;
}

function variantBranches(schema: JsonSchema): VariantBranch[] | undefined {
	const branches = unionBranches(schema);
	if (!branches) return undefined;
	if (!branches.every((b) => isRecord(b) && b.type === "object" && !hasNonDrawableKeyword(b))) {
		return undefined;
	}
	// The discriminator: a const property present in EVERY branch, with a
	// distinct value per branch.
	const first = branches[0] as JsonSchema;
	const firstProps = isRecord(first.properties) ? first.properties : {};
	for (const [name, prop] of Object.entries(firstProps)) {
		if (!isRecord(prop) || typeof prop.const !== "string") continue;
		const ids = new Set<string>();
		const parsed: VariantBranch[] = [];
		let ok = true;
		for (const branch of branches) {
			if (!isRecord(branch)) {
				ok = false;
				break;
			}
			const props = isRecord(branch.properties) ? branch.properties : {};
			const own = props[name];
			if (!isRecord(own) || typeof own.const !== "string" || ids.has(own.const)) {
				ok = false;
				break;
			}
			ids.add(own.const);
			parsed.push({
				id: own.const,
				label: typeof branch.title === "string" ? branch.title : own.const,
				schema: branch,
				discriminator: name,
			});
		}
		if (ok) return parsed;
	}
	return undefined;
}

/** Whether an array item schema (transitively) holds writeOnly fields. */
function itemHasSecrets(root: JsonSchema, item: JsonSchema): boolean {
	if (item.writeOnly === true) return true;
	if (item.type === "object") {
		if (propertiesOf(root, item).some(([, child]) => itemHasSecrets(root, child))) return true;
		if (isRecord(item.additionalProperties)) {
			return itemHasSecrets(root, deref(root, item.additionalProperties));
		}
	}
	if (item.type === "array" && isRecord(item.items)) {
		return itemHasSecrets(root, deref(root, item.items));
	}
	const branches = unionBranches(item);
	if (branches) {
		return branches.some((branch) => isRecord(branch) && itemHasSecrets(root, deref(root, branch)));
	}
	return false;
}

// ─── generation context ──────────────────────────────────────────────────

interface Ctx {
	readonly root: JsonSchema;
	readonly secrets: SecretPath[];
	readonly fallbacks: string[];
	readonly envFields: EnvField[];
	/** Property-name prefix for dotted field names inside titled sections. */
	readonly namePrefix: string;
	/** The identity property of the enclosing array item, for its secrets' keys. */
	readonly identity?: string;
}

function warnFallback(pointer: string, reason: string): void {
	console.warn(
		`settings schema: property ${pointer} is outside the drawable subset (${reason}); rendering as a JSON box`,
	);
}

/** FieldBase props shared by every generated field. */
function baseProps(schema: JsonSchema, name: string, required: boolean): FieldBase {
	const base: {
		name: string;
		label: string;
		required?: boolean;
		help?: string;
		placeholder?: string;
		apply?: Apply;
		minLength?: number;
		maxLength?: number;
		pattern?: string;
	} = {
		name,
		label: typeof schema.title === "string" && schema.title !== ""
			? schema.title
			: name === ""
				? "Entries"
				: name.split(".").pop() ?? name,
	};
	if (required) base.required = true;
	if (typeof schema.description === "string" && schema.description !== "") base.help = schema.description;
	if (schema[APPLY_KEYWORD] !== undefined) base.apply = applyOf(schema);
	if (schema.default !== undefined && typeof schema.default !== "object") {
		base.placeholder = String(schema.default);
	}
	if (typeof schema.minLength === "number") base.minLength = schema.minLength;
	if (typeof schema.maxLength === "number") base.maxLength = schema.maxLength;
	if (typeof schema.pattern === "string") base.pattern = schema.pattern;
	return base;
}

/** The fallback: a property the subset cannot draw becomes a JSON box. */
function fallbackNode(ctx: Ctx, name: string, pointer: string, reason: string): Field {
	ctx.fallbacks.push(pointer);
	warnFallback(pointer, reason);
	return {
		name,
		label: name.split(".").pop() ?? name,
		type: "longtext",
		syntax: "code",
		lang: "json",
	};
}

/**
 * Generate one property as a field, or as a section when it is a titled
 * nested object (spec §2: nested object with title → section, dotted
 * child names).
 */
function propertyNode(
	ctx: Ctx,
	name: string,
	pointer: string,
	schema: JsonSchema,
	required: boolean,
): PropertyNode {
	// A property that is only an unresolved $ref (or a non-record) falls
	// back honestly; checkSchema has already named it at load.
	if (typeof schema.$ref === "string" && resolveRef(ctx.root, schema.$ref) === undefined) {
		return fallbackNode(ctx, name, pointer, `unresolved $ref ${schema.$ref}`);
	}
	const variable = envOf(schema);
	const base: FieldBase = variable === undefined
		? baseProps(schema, name, required)
		: { ...baseProps(schema, name, required), placeholder: { $: `/envFallbacks/${pointerEscape(name)}` } };
	if (variable !== undefined) {
		ctx.envFields.push({
			name,
			variable,
			...(schema.default === undefined ? {} : { fallback: String(schema.default) }),
		});
	}

	// writeOnly → secret, anywhere in the tree
	if (schema.writeOnly === true) {
		ctx.secrets.push(secretPath(ctx, pointer));
		return { ...base, type: "secret" } as Field;
	}

	// A union — `oneOf`, or the `anyOf` TypeBox's `Type.Union` emits — draws
	// as a choice or a variant when its branches name their alternatives.
	// Both spellings are read the same way; any other blocking keyword on the
	// schema still forces the JSON box.
	const blocked = hasOtherNonDrawableKeyword(schema);
	const options = blocked ? undefined : choiceOptions(schema);
	if (options) {
		return { ...base, type: "choice", options };
	}
	const branches = blocked ? undefined : variantBranches(schema);
	if (branches) {
		return variantNode(ctx, base, pointer, branches);
	}

	if (hasNonDrawableKeyword(schema)) {
		return fallbackNode(
			ctx,
			name,
			pointer,
			unionBranches(schema) ? "union outside the choice/variant subset" : "conditional or pattern keyword",
		);
	}

	switch (schema.type) {
		case "string":
			if (
				schema.format === "textarea" ||
				(typeof schema.maxLength === "number" && schema.maxLength > 200)
			) {
				return { ...base, type: "longtext" } as Field;
			}
			return { ...base, type: "text" } as Field;
		case "number":
		case "integer": {
			const bounds: { min?: number; max?: number } = {};
			if (typeof schema.minimum === "number") bounds.min = schema.minimum;
			if (typeof schema.maximum === "number") bounds.max = schema.maximum;
			return { ...base, ...bounds, type: "number" };
		}
		case "boolean": {
			const { placeholder: _placeholder, ...rest } = base;
			return {
				...rest,
				type: "toggle",
				...(typeof schema.default === "boolean" ? { default: schema.default } : {}),
			};
		}
		case "object": {
			const additional = schema.additionalProperties;
			if (isRecord(additional)) {
				// table keyed by name → entries shape "table"
				const value = deref(ctx.root, additional);
				if (value.writeOnly === true) {
					// writeOnly table VALUES (e.g. a headers map): the value is the
					// secret; the row's key completes the pointer.
					ctx.secrets.push(secretPath(ctx, pointerJoin(pointer, "*")));
					return {
						...base,
						type: "entries",
						shape: "table",
						item: [{ name: "value", label: "Value", type: "secret" }],
						summary: [],
						keyLabel: "Name",
					};
				}
				const item = value.type === "object"
					? objectChildren({ ...ctx, namePrefix: "" }, value, pointerJoin(pointer, "*"))
					: [propertyNode(
						{ ...ctx, namePrefix: "" },
						"value",
						pointerJoin(pointer, "*"),
						value,
						false,
					)];
				if (item.length === 0) {
					// A table row with no field to draw is not drawable: the row
					// would render edgeless, and the channel coerces a stored row to
					// {} on the next save — silently destroying data.
					return fallbackNode(ctx, name, pointer, "additionalProperties value has no field to draw");
				}
				const summary = summaryOf(value);
				return {
					...base,
					type: "entries",
					shape: "table",
					item,
					summary: summary.length > 0 ? summary : rowFieldNames(item),
					keyLabel: "Name",
				};
			}
			if (isRecord(schema.properties)) {
				// Dotted child names inside the nested object's grouping.
				const children = objectChildren({ ...ctx, namePrefix: `${name}.` }, schema, pointer);
				return {
					type: "section",
					...(typeof schema.title === "string" ? { title: schema.title } : {}),
					children,
				};
			}
			return fallbackNode(ctx, name, pointer, "object without properties or additionalProperties");
		}
		case "array": {
			const items = schema.items;
			if (!isRecord(items)) return fallbackNode(ctx, name, pointer, "array without items");
			const item = deref(ctx.root, items);
			if (item.type === "object") {
				// array of objects → entries shape "array"
				const key = keyOf(item);
				// A secret below this item keys on the entry's identity VALUE, so
				// every secret pattern generated here carries the property name.
				const itemChildren = objectChildren(
					{ ...ctx, namePrefix: "", identity: key },
					item,
					pointerJoin(pointer, "*"),
				);
				const summary = summaryOf(item);
				if (itemHasSecrets(ctx.root, item) && !key) {
					// checkSchema rejects this at load; generation falls back so a
					// direct generateForm call stays honest about the missing identity.
					return fallbackNode(ctx, name, pointer, `array item with secrets requires ${KEY_KEYWORD}`);
				}
				return {
					...base,
					type: "entries",
					shape: "array",
					item: itemChildren,
					summary: summary.length > 0 ? summary : rowFieldNames(itemChildren),
					...(key ? { key } : {}),
				};
			}
			// array of scalars → list
			const scalar = propertyNode(
				{ ...ctx, namePrefix: "" },
				"item",
				pointerJoin(pointer, "*"),
				item,
				false,
			);
			if (scalar.type === "section") {
				return fallbackNode(ctx, name, pointer, "array item outside the drawable subset");
			}
			return { ...base, type: "list", item: scalar };
		}
		default:
			return fallbackNode(ctx, name, pointer, `unsupported type ${String(schema.type)}`);
	}
}

/** A union of objects told apart by one shared const property, as a variant. */
function variantNode(
	ctx: Ctx,
	base: FieldBase,
	pointer: string,
	branches: readonly VariantBranch[],
): VariantField {
	const options: VariantField["options"][number][] = [];
	for (const branch of branches) {
		const stripped: JsonSchema = {
			...branch.schema,
			properties: withoutDiscriminator(branch.schema, branch.discriminator),
		};
		// Secrets inside a variant branch live at the property's own path
		// (the discriminator selects the branch, not a segment).
		const children = objectChildren({ ...ctx, namePrefix: "" }, stripped, pointer);
		options.push({ id: branch.id, label: branch.label, children });
	}
	return { ...base, type: "variant", discriminator: branches[0]?.discriminator ?? "type", options };
}

/** A branch's properties minus the discriminator (the choice writes it). */
function withoutDiscriminator(branch: JsonSchema, discriminator: string): Record<string, unknown> {
	const props = isRecord(branch.properties) ? branch.properties : {};
	const rest = { ...props };
	delete rest[discriminator];
	return rest;
}

/**
 * The derived row summary of an entries item: its field names, in order.
 * Sections are grouping only, never columns of the one-line row summary.
 */
function rowFieldNames(children: readonly (Field | SectionBlock)[]): string[] {
	return children.flatMap((child) => (child.type === "section" ? [] : [child.name]));
}

/** The children of an object-typed node: fields plus titled sections. */
function objectChildren(ctx: Ctx, schema: JsonSchema, pointer: string): (Field | SectionBlock)[] {
	const required = new Set(
		Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === "string") : [],
	);
	const children: (Field | SectionBlock)[] = [];
	for (const [name, child] of propertiesOf(ctx.root, schema)) {
		children.push(
			propertyNode(ctx, `${ctx.namePrefix}${name}`, pointerJoin(pointer, name), child, required.has(name)),
		);
	}
	return children;
}

// ─── the public entry points ─────────────────────────────────────────────

/** Generate the settings form for a schema (call checkSchema first at load). */
export function generateForm(
	schema: JsonSchema,
	opts: { idPrefix: string; layout?: readonly LayoutGroup[] },
): GeneratedForm {
	const ctx: Ctx = { root: schema, secrets: [], fallbacks: [], envFields: [], namePrefix: "" };
	const apply = new Map<string, Apply>();

	const topLevel = propertiesOf(schema, schema);
	const credentialChildren: (Field | SectionBlock)[] = [];
	const rest: (Field | SectionBlock)[] = [];

	const emit = (name: string, pointer: string, child: JsonSchema, required: boolean): void => {
		apply.set(name, applyOf(child));
		const node = propertyNode(ctx, name, pointer, child, required);
		if (child.writeOnly === true) credentialChildren.push(node);
		else rest.push(node);
	};

	const topRequired = new Set(
		Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === "string") : [],
	);

	if (opts.layout) {
		// Secrets are never left to the layout: a top-level writeOnly property
		// always renders under Credentials, whether or not the layout lists it.
		for (const [name, child] of topLevel) {
			if (child.writeOnly === true) emit(name, pointerJoin("", name), child, topRequired.has(name));
		}

		// Inclusion: only the listed paths render, grouped by section. Core's
		// layout also names leaves inside nested objects (server/port, etc.).
		const included = new Map<string, { schema: JsonSchema; required: boolean }>();
		const include = (child: JsonSchema, pointer: string, required: boolean): void => {
			included.set(pointer, { schema: child, required });
			const requiredChildren = new Set(
				Array.isArray(child.required)
				? child.required.filter((name): name is string => typeof name === "string")
				: [],
			);
			for (const [childName, grandchild] of propertiesOf(schema, child)) {
				include(grandchild, pointerJoin(pointer, childName), requiredChildren.has(childName));
			}
		};
		for (const [name, child] of topLevel) include(child, pointerJoin("", name), topRequired.has(name));
		for (const group of opts.layout) {
			const children: (Field | SectionBlock)[] = [];
			for (const path of group.paths) {
				const includedProperty = included.get(path);
				if (!includedProperty) {
					console.warn(
						`settings schema: layout path ${path} (section "${group.title}") is not a property of the schema; skipping it`,
					);
					continue;
				}
				const child = includedProperty.schema;
				if (child.writeOnly === true) continue; // already under Credentials
				const segments = path.split("/").filter((segment) => segment !== "");
				const name = segments.map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~")).join(".");
				if (segments.length === 1) apply.set(name, applyOf(child));
				const node = propertyNode(ctx, name, path, child, includedProperty.required);
				const override = group.overrides?.[path];
				if (node.type === "section" && node.title === undefined) {
					// Untitled nested object: the layout group is its section.
					children.push(...(node.children as readonly (Field | SectionBlock)[]));
				} else {
					if (override && node.type !== "section") {
						const merged = { ...node, ...override } as Record<string, unknown>;
						for (const [key, value] of Object.entries(override)) {
							if (value === undefined) delete merged[key];
						}
						// SAFETY: the generated node is a Field; overrides only replace
						// field properties or remove them with an undefined marker.
						children.push(merged as unknown as Field);
					} else {
						children.push(node);
					}
				}
			}
			rest.push({ type: "section", title: group.title, children });
		}
	} else {
		for (const [name, child] of topLevel) emit(name, pointerJoin("", name), child, topRequired.has(name));
	}

	// A root additionalProperties map is a REAL settings surface, not an
	// annotation to ignore: it holds arbitrary named values alongside the
	// declared properties (MCP's flat per-user server toggles). Emit it as a
	// table whose field name is the reserved empty path — the schema-surface
	// adapter projects that field from/to the root's undeclared keys. Its
	// value schema still goes through propertyNode, so a non-drawable value
	// earns the ordinary JSON-box fallback + warning (and assertDrawable
	// rejects it) instead of silently disappearing.
	if (isRecord(schema.additionalProperties)) {
		// The declared apply marker rides along (a root toggle map marked
		// live must render with its live callout — the final re-review's
		// dropped-marker finding).
		const apply = schema.additionalProperties[APPLY_KEYWORD];
		const tableSchema: JsonSchema = {
			type: "object",
			additionalProperties: schema.additionalProperties,
			...(typeof schema.additionalProperties.title === "string"
				? { title: schema.additionalProperties.title }
				: {}),
			...(typeof schema.additionalProperties.description === "string"
				? { description: schema.additionalProperties.description }
				: {}),
			...(apply === "live" || apply === "restart"
				? { [APPLY_KEYWORD]: apply }
				: {}),
		};
		rest.push(propertyNode(ctx, "", "", tableSchema, false));
	}

	const children: (Field | SectionBlock)[] = [];
	if (credentialChildren.length > 0) {
		children.push({
			type: "section",
			id: `${opts.idPrefix}-credentials`,
			title: "Credentials",
			children: credentialChildren,
		});
	}
	children.push(...rest);

	const root: FormBlock = {
		type: "form",
		id: `${opts.idPrefix}-form`,
		bind: "/settings",
		mode: "submit",
		onSubmit: "save",
		children,
	};
	const form: Tree = { v: BLOCK_SET_VERSION, root };
	return { form, secrets: ctx.secrets, fallbacks: ctx.fallbacks, apply, envFields: ctx.envFields };
}

/** Load-time schema check (spec §1): loud, naming the offending keyword. */
export function checkSchema(schema: unknown): SchemaCheck {
	if (!isRecord(schema)) return { ok: false, error: "settings schema: root must be an object" };
	if (schema.type !== "object") {
		return { ok: false, error: `settings schema: root type must be "object" (got ${String(schema.type)})` };
	}
	return checkNode(schema, schema, "");
}

function checkNode(root: JsonSchema, schema: JsonSchema, pointer: string): SchemaCheck {
	const fail = (message: string): SchemaCheck => ({
		ok: false,
		error: `settings schema ${pointer || "(root)"}: ${message}`,
	});

	// $ref must resolve locally
	if (schema.$ref !== undefined) {
		if (typeof schema.$ref !== "string" || !schema.$ref.startsWith("#/")) {
			return fail(`$ref must be a local "#/..." reference (got ${JSON.stringify(schema.$ref)})`);
		}
		const target = resolveRef(root, schema.$ref);
		if (!target) return fail(`$ref ${schema.$ref} does not resolve`);
		return checkNode(root, target, pointer);
	}

	// keyword well-formedness
	if (
		schema[APPLY_KEYWORD] !== undefined &&
		schema[APPLY_KEYWORD] !== "live" &&
		schema[APPLY_KEYWORD] !== "restart"
	) {
		return fail(`${APPLY_KEYWORD} must be "live" or "restart"`);
	}
	if (schema[SUMMARY_KEYWORD] !== undefined) {
		const summary = schema[SUMMARY_KEYWORD];
		if (!Array.isArray(summary) || !summary.every((s) => typeof s === "string")) {
			return fail(`${SUMMARY_KEYWORD} must be an array of strings`);
		}
	}
	if (schema[KEY_KEYWORD] !== undefined && typeof schema[KEY_KEYWORD] !== "string") {
		return fail(`${KEY_KEYWORD} must be a string`);
	}
	if (schema[ENV_KEYWORD] !== undefined) {
		const variable = schema[ENV_KEYWORD];
		if (typeof variable !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(variable)) {
			return fail(`${ENV_KEYWORD} must be an uppercase environment variable name (got ${JSON.stringify(variable)})`);
		}
		if (schema.type !== "string" || schema.writeOnly === true) {
			return fail(`${ENV_KEYWORD} is valid only on a non-writeOnly string property`);
		}
	}
	if (schema.writeOnly !== undefined && typeof schema.writeOnly !== "boolean") {
		return fail("writeOnly must be a boolean");
	}
	if (schema[OVERRIDABLE_KEYWORD] !== undefined) {
		if (schema[OVERRIDABLE_KEYWORD] !== true) {
			return fail(`${OVERRIDABLE_KEYWORD} must be true`);
		}
		if (schema.type === "object" || schema.type === "array") {
			return fail(`${OVERRIDABLE_KEYWORD} is valid only on leaf properties (not object/array)`);
		}
	}

	if (Array.isArray(schema.oneOf)) {
		for (let i = 0; i < schema.oneOf.length; i++) {
			const branch = schema.oneOf[i];
			if (!isRecord(branch)) return fail(`oneOf[${i}] must be an object`);
			const result = checkNode(root, branch, `${pointer}/oneOf/${i}`);
			if (!result.ok) return result;
		}
	}
	// `anyOf` is a union like `oneOf` (TypeBox's `Type.Union` emits it), so
	// its branches are checked the same way.
	if (Array.isArray(schema.anyOf)) {
		for (let i = 0; i < schema.anyOf.length; i++) {
			const branch = schema.anyOf[i];
			if (!isRecord(branch)) return fail(`anyOf[${i}] must be an object`);
			const result = checkNode(root, branch, `${pointer}/anyOf/${i}`);
			if (!result.ok) return result;
		}
	}

	if (schema.type === "object" || isRecord(schema.properties)) {
		for (const [name, child] of propertiesOf(root, schema)) {
			const result = checkNode(root, child, pointerJoin(pointer, name));
			if (!result.ok) return result;
		}
		const additional = schema.additionalProperties;
		if (isRecord(additional)) {
			const result = checkNode(root, additional, pointerJoin(pointer, "*"));
			if (!result.ok) return result;
		}
	}
	if (schema.type === "array") {
		if (isRecord(schema.items)) {
			const item = deref(root, schema.items);
			if (itemHasSecrets(root, item)) {
				const key = keyOf(item);
				if (!key) {
					return fail(
						`array items containing writeOnly fields must declare ${KEY_KEYWORD} (a stable entry identity)`,
					);
				}
				// The identity must be READABLE: a key naming a missing or
				// non-string property yields no identity at save time, so its
				// secrets can never be keyed. Reject at declare time instead of
				// dropping the values silently.
				const keySchema = propertiesOf(root, item).find(([name]) => name === key)?.[1];
				if (keySchema === undefined || keySchema.type !== "string") {
					return fail(`${KEY_KEYWORD} "${key}" must name a string-typed property`);
				}
			}
			const result = checkNode(root, schema.items, pointerJoin(pointer, "*"));
			if (!result.ok) return result;
		}
	}
	return { ok: true };
}

/** Family-repo proof: throws when any property falls back to a JSON box. */
export function assertDrawable(schema: JsonSchema): void {
	const check = checkSchema(schema);
	if (!check.ok) throw new Error(check.error);
	const generated = generateForm(schema, { idPrefix: "assert" });
	if (generated.fallbacks.length > 0) {
		throw new Error(
			`settings schema is not fully drawable; JSON-box fallbacks at: ${generated.fallbacks.join(", ")}`,
		);
	}
}
