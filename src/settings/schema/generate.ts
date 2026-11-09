/**
 * Settings rework Task 4 (spec §2): translate a JSON Schema (2020-12)
 * into the settings placement's form blocks.
 *
 * Pure: the same input schema always yields the same form, and the only
 * side effect is one `console.warn` per property that falls back to a
 * JSON box (a load-time warning naming its JSON-pointer path).
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
	KEY_KEYWORD,
	SUMMARY_KEYWORD,
	applyOf,
	deref,
	hasNonDrawableKeyword,
	isRecord,
	keyOf,
	pointerJoin,
	propertiesOf,
	resolveRef,
	summaryOf,
	type Apply,
	type JsonSchema,
} from "./keywords.js";

export type { Apply, JsonSchema } from "./keywords.js";

/** A secret value location (spec §4). */
export interface SecretPath {
	/** JSON pointer with "*" for a table key or array identity segment, e.g. "/servers/*\/headers/*". */
	readonly pattern: string;
}

/** The generator's product: the form plus everything the save path needs. */
export interface GeneratedForm {
	readonly form: Tree; // a root `form`, bind "/settings", mode "submit", onSubmit "save"
	readonly secrets: readonly SecretPath[]; // every writeOnly property
	readonly fallbacks: readonly string[]; // JSON-pointer paths drawn as a JSON box
	readonly apply: ReadonlyMap<string, Apply>; // top-level property → apply
}

/** Core's section layout (Task 8); extensions omit it. */
export interface LayoutGroup {
	readonly title: string;
	readonly paths: readonly string[]; // layout = inclusion: properties not listed are not rendered
	/** Core only: per-path field overrides merged over the generated field. */
	readonly overrides?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

/** The result of the load-time schema check. */
export type SchemaCheck = { ok: true } | { ok: false; error: string };

/** A generated property: a field, or a titled nested object as a section. */
type PropertyNode = Field | SectionBlock;

// ─── drawable-subset recognition ─────────────────────────────────────────

/** `enum` / `oneOf` of `{const, title}` → choice options, else undefined. */
function choiceOptions(schema: JsonSchema): { id: string; label: string }[] | undefined {
	if (Array.isArray(schema.enum) && schema.enum.every((v) => typeof v === "string")) {
		return schema.enum.map((v) => ({ id: v, label: v }));
	}
	if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
		const options: { id: string; label: string }[] = [];
		for (const branch of schema.oneOf) {
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

/** `oneOf` of objects told apart by one shared const property. */
interface VariantBranch {
	readonly id: string;
	readonly label: string;
	readonly schema: JsonSchema;
	readonly discriminator: string;
}

function variantBranches(schema: JsonSchema): VariantBranch[] | undefined {
	if (!Array.isArray(schema.oneOf) || schema.oneOf.length === 0) return undefined;
	const branches = schema.oneOf;
	if (!branches.every((b) => isRecord(b) && b.type === "object")) return undefined;
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
	if (Array.isArray(item.oneOf)) {
		return item.oneOf.some((b) => isRecord(b) && itemHasSecrets(root, deref(root, b)));
	}
	return false;
}

// ─── generation context ──────────────────────────────────────────────────

interface Ctx {
	readonly root: JsonSchema;
	readonly secrets: SecretPath[];
	readonly fallbacks: string[];
	/** Property-name prefix for dotted field names inside titled sections. */
	readonly namePrefix: string;
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
		label: typeof schema.title === "string" ? schema.title : name.split(".").pop() ?? name,
	};
	if (required) base.required = true;
	if (typeof schema.description === "string") base.help = schema.description;
	if (schema[APPLY_KEYWORD] !== undefined) base.apply = applyOf(schema);
	if (schema.default !== undefined) base.placeholder = String(schema.default);
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
	const base = baseProps(schema, name, required);

	// writeOnly → secret, anywhere in the tree
	if (schema.writeOnly === true) {
		ctx.secrets.push({ pattern: pointer });
		return { ...base, type: "secret" } as Field;
	}

	if (hasNonDrawableKeyword(schema)) {
		return fallbackNode(ctx, name, pointer, "conditional or pattern keyword");
	}

	const options = choiceOptions(schema);
	if (options) {
		return { ...base, type: "choice", options };
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
					ctx.secrets.push({ pattern: pointerJoin(pointer, "*") });
					return {
						...base,
						type: "entries",
						shape: "table",
						item: [{ name: "value", label: "Value", type: "secret" }],
						summary: [],
						keyLabel: "Name",
					};
				}
				const item = objectFields({ ...ctx, namePrefix: "" }, value, pointerJoin(pointer, "*"));
				const summary = summaryOf(value);
				return {
					...base,
					type: "entries",
					shape: "table",
					item,
					summary: summary.length > 0 ? summary : item.map((f) => f.name),
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
				const itemChildren = objectChildren({ ...ctx, namePrefix: "" }, item, pointerJoin(pointer, "*"));
				const summary = summaryOf(item);
				const key = keyOf(item);
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
					summary:
						summary.length > 0
							? summary
							: itemChildren.flatMap((c) => (c.type === "section" ? [] : [c.name])),
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
		default: {
			const branches = variantBranches(schema);
			if (branches) {
				const optionsOut: VariantField["options"][number][] = [];
				for (const branch of branches) {
					const stripped: JsonSchema = {
						...branch.schema,
						properties: withoutDiscriminator(branch.schema, branch.discriminator),
					};
					// Secrets inside a variant branch live at the property's own
					// path (the discriminator selects the branch, not a segment).
					const children = objectChildren({ ...ctx, namePrefix: "" }, stripped, pointer);
					optionsOut.push({ id: branch.id, label: branch.label, children });
				}
				return {
					...base,
					type: "variant",
					discriminator: branches[0]?.discriminator ?? "type",
					options: optionsOut,
				};
			}
			return fallbackNode(ctx, name, pointer, `unsupported type ${String(schema.type)}`);
		}
	}
}

/** A branch's properties minus the discriminator (the choice writes it). */
function withoutDiscriminator(branch: JsonSchema, discriminator: string): Record<string, unknown> {
	const props = isRecord(branch.properties) ? branch.properties : {};
	const rest = { ...props };
	delete rest[discriminator];
	return rest;
}

/** The fields of an object schema's `properties` (nested objects stay fields/sections). */
function objectFields(ctx: Ctx, schema: JsonSchema, pointer: string): Field[] {
	const required = new Set(
		Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === "string") : [],
	);
	const fields: Field[] = [];
	for (const [name, child] of propertiesOf(ctx.root, schema)) {
		const node = propertyNode(
			ctx,
			`${ctx.namePrefix}${name}`,
			pointerJoin(pointer, name),
			child,
			required.has(name),
		);
		// Entries items carry fields only in the flat mapping; a titled
		// nested object inside an entry keeps its section via objectChildren.
		if (node.type !== "section") fields.push(node);
	}
	return fields;
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
	const ctx: Ctx = { root: schema, secrets: [], fallbacks: [], namePrefix: "" };
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
		// Inclusion: only the listed paths render, grouped by section.
		const included = new Map<string, JsonSchema>();
		for (const [name, child] of topLevel) included.set(pointerJoin("", name), child);
		for (const group of opts.layout) {
			const children: (Field | SectionBlock)[] = [];
			for (const path of group.paths) {
				const child = included.get(path);
				if (!child) continue;
				const name = path.split("/").pop() ?? path;
				apply.set(name, applyOf(child));
				const node = propertyNode(ctx, name, path, child, topRequired.has(name));
				const override = group.overrides?.[path];
				if (node.type === "section" && node.title === undefined) {
					// Untitled nested object: the layout group is its section.
					children.push(...(node.children as readonly (Field | SectionBlock)[]));
				} else {
					children.push(
						override && node.type !== "section" ? ({ ...node, ...override } as Field) : node,
					);
				}
			}
			rest.push({ type: "section", title: group.title, children });
		}
	} else {
		for (const [name, child] of topLevel) emit(name, pointerJoin("", name), child, topRequired.has(name));
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
	return { form, secrets: ctx.secrets, fallbacks: ctx.fallbacks, apply };
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
	if (schema.writeOnly !== undefined && typeof schema.writeOnly !== "boolean") {
		return fail("writeOnly must be a boolean");
	}

	if (Array.isArray(schema.oneOf)) {
		for (let i = 0; i < schema.oneOf.length; i++) {
			const branch = schema.oneOf[i];
			if (!isRecord(branch)) return fail(`oneOf[${i}] must be an object`);
			const result = checkNode(root, branch, `${pointer}/oneOf/${i}`);
			if (!result.ok) return result;
		}
	}
	if (Array.isArray(schema.anyOf)) {
		for (const branch of schema.anyOf) {
			if (!isRecord(branch)) return fail("anyOf branches must be objects");
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
			if (itemHasSecrets(root, item) && !keyOf(item)) {
				return fail(
					`array items containing writeOnly fields must declare ${KEY_KEYWORD} (a stable entry identity)`,
				);
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
