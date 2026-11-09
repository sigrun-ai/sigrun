/**
 * Settings rework Task 4: the JSON Schema → settings form generator
 * (`generateForm`), load-time schema checking (`checkSchema`) and the
 * drawability proof extension suites run (`assertDrawable`).
 *
 * Every generated form is validated against the same `validateTree`
 * the server runs on the settings placement, so a mapping regression
 * fails here before any channel renders it.
 */

import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type {
	ChoiceField,
	EntriesField,
	Field,
	FormBlock,
	ListField,
	LongtextField,
	NumberField,
	SectionBlock,
	SecretField,
	TextField,
	ToggleField,
	VariantField,
} from "@sigrun/shared/blocks";
import { validateTree } from "../src/blocks/validate.js";
import {
	assertDrawable,
	checkSchema,
	generateForm,
	type JsonSchema,
} from "../src/settings/schema/index.js";

/** Generate a form and validate it against the settings placement. */
function generate(schema: JsonSchema, opts?: { layout?: readonly import("../src/settings/schema/index.js").LayoutGroup[] }) {
	const generated = generateForm(schema, { idPrefix: "test", ...opts });
	const result = validateTree(generated.form, { placement: "settings" });
	if (!result.ok) {
		throw new Error(
			`generated form fails settings validation: ${result.errors
				.map((e) => `${e.path}: ${e.message}`)
				.join("; ")}`,
		);
	}
	return generated;
}

/** The generated root form block. */
function rootOf(schema: JsonSchema): FormBlock {
	return generate(schema).form.root as FormBlock;
}

/** The fields/sections of the generated root form. */
function childrenOf(schema: JsonSchema): readonly (Field | SectionBlock)[] {
	return rootOf(schema).children;
}

/** Find a field by name anywhere in a child list (sections recursed). */
function fieldNamed(children: readonly (Field | SectionBlock)[], name: string): Field {
	for (const child of children) {
		if (child.type === "section") {
			try {
				return fieldNamed(child.children as readonly (Field | SectionBlock)[], name);
			} catch {
				// keep looking
			}
		} else if (child.name === name) {
			return child;
		}
	}
	throw new Error(`no field named ${name}`);
}

function objectSchema(properties: Record<string, unknown>): JsonSchema {
	return { type: "object", properties };
}

/** Run `fn` with `console.warn` captured (one entry per call). */
function captureWarnings<T>(fn: () => T): { value: T; warnings: string[] } {
	const warnings: string[] = [];
	const original = console.warn;
	console.warn = (message: string) => warnings.push(message);
	try {
		return { value: fn(), warnings };
	} finally {
		console.warn = original;
	}
}

describe("generateForm", () => {
	it("scalar mapping", () => {
		const generated = generate(
			objectSchema({
				name: { type: "string", title: "Name", description: "Your name" },
				bio: { type: "string", format: "textarea" },
				notes: { type: "string", maxLength: 500 },
				age: { type: "integer", minimum: 0, maximum: 150 },
				ratio: { type: "number", minimum: 0, maximum: 1 },
				enabled: { type: "boolean", default: true },
				color: { enum: ["red", "green"] },
				mode: {
					oneOf: [
						{ const: "fast", title: "Fast" },
						{ const: "slow", title: "Slow" },
					],
				},
				token: { type: "string", writeOnly: true },
			}),
		);
		const children = generated.form.root.type === "form" ? generated.form.root.children : [];
		const name = fieldNamed(children, "name") as TextField;
		expect(name.type).toBe("text");
		expect(name.label).toBe("Name");
		expect(name.help).toBe("Your name");

		const bio = fieldNamed(children, "bio") as LongtextField;
		expect(bio.type).toBe("longtext");

		const notes = fieldNamed(children, "notes") as LongtextField;
		expect(notes.type).toBe("longtext");

		const age = fieldNamed(children, "age") as NumberField;
		expect(age.type).toBe("number");
		expect(age.min).toBe(0);
		expect(age.max).toBe(150);

		const ratio = fieldNamed(children, "ratio") as NumberField;
		expect(ratio.type).toBe("number");
		expect(ratio.min).toBe(0);
		expect(ratio.max).toBe(1);

		const enabled = fieldNamed(children, "enabled") as ToggleField;
		expect(enabled.type).toBe("toggle");
		expect(enabled.default).toBe(true);

		const color = fieldNamed(children, "color") as ChoiceField;
		expect(color.type).toBe("choice");
		expect(color.options).toEqual([
			{ id: "red", label: "red" },
			{ id: "green", label: "green" },
		]);

		const mode = fieldNamed(children, "mode") as ChoiceField;
		expect(mode.type).toBe("choice");
		expect(mode.options).toEqual([
			{ id: "fast", label: "Fast" },
			{ id: "slow", label: "Slow" },
		]);

		const token = fieldNamed(children, "token") as SecretField;
		expect(token.type).toBe("secret");
		expect(generated.secrets).toEqual([{ pattern: "/token" }]);

		// label fallback is the property name; default → placeholder
		const fallback = generate(objectSchema({ plain: { type: "string", default: "x" } }));
		const plain = fieldNamed(
			fallback.form.root.type === "form" ? fallback.form.root.children : [],
			"plain",
		) as TextField;
		expect(plain.label).toBe("plain");
		expect(plain.placeholder).toBe("x");

		// x-sigrun-apply lands on the field and in the apply map; default restart
		const applied = generate(
			objectSchema({ live: { type: "string", "x-sigrun-apply": "live" } }),
		);
		const live = fieldNamed(
			applied.form.root.type === "form" ? applied.form.root.children : [],
			"live",
		);
		expect(live.apply).toBe("live");
		expect(applied.apply.get("live")).toBe("live");

		// root form identity: bind /settings, submit mode, save handler
		const root = generated.form.root as FormBlock;
		expect(root.bind).toBe("/settings");
		expect(root.mode).toBe("submit");
		expect(root.onSubmit).toBe("save");
	});

	it("nested titled object becomes a section with dotted names", () => {
		const children = childrenOf(
			objectSchema({
				retry: {
					type: "object",
					title: "Retry",
					properties: {
						enabled: { type: "boolean" },
						attempts: { type: "integer" },
					},
				},
			}),
		);
		const section = children.find((c) => c.type === "section") as SectionBlock;
		expect(section).toBeDefined();
		expect(section.title).toBe("Retry");
		const fields = section.children as Field[];
		expect(fields.map((f) => f.name)).toEqual(["retry.enabled", "retry.attempts"]);
	});

	it("array of objects becomes entries with summary from x-sigrun-summary", () => {
		const children = childrenOf(
			objectSchema({
				servers: {
					type: "array",
					"x-sigrun-summary": ["name", "url"],
					items: {
						type: "object",
						properties: {
							name: { type: "string" },
							url: { type: "string" },
						},
					},
				},
			}),
		);
		const entries = fieldNamed(children, "servers") as EntriesField;
		expect(entries.type).toBe("entries");
		expect(entries.shape).toBe("array");
		expect(entries.summary).toEqual(["name", "url"]);
		expect((entries.item as Field[]).map((f) => f.name)).toEqual(["name", "url"]);
		expect(entries.key).toBeUndefined();
	});

	it("additionalProperties becomes table entries", () => {
		const children = childrenOf(
			objectSchema({
				headers: {
					type: "object",
					additionalProperties: {
						type: "object",
						properties: { value: { type: "string" } },
					},
				},
			}),
		);
		const entries = fieldNamed(children, "headers") as EntriesField;
		expect(entries.type).toBe("entries");
		expect(entries.shape).toBe("table");
		expect((entries.item as Field[]).map((f) => f.name)).toEqual(["value"]);

		// array of scalars → list
		const lists = childrenOf(
			objectSchema({ tags: { type: "array", items: { type: "string" } } }),
		);
		const tags = fieldNamed(lists, "tags") as ListField;
		expect(tags.type).toBe("list");
		expect((tags.item as TextField).type).toBe("text");
	});

	it("a titled nested object inside a table row keeps its section", () => {
		const schema = objectSchema({
			servers: {
				type: "object",
				additionalProperties: {
					type: "object",
					properties: {
						url: { type: "string" },
						oauth: {
							type: "object",
							title: "OAuth",
							properties: { clientId: { type: "string" } },
						},
					},
				},
			},
		});
		const entries = fieldNamed(childrenOf(schema), "servers") as EntriesField;
		expect(entries.shape).toBe("table");
		// the titled group is a section inside the row, not a dropped field
		expect(entries.item.map((c) => (c.type === "section" ? c.title : (c as Field).name))).toEqual([
			"url",
			"OAuth",
		]);
		const oauth = entries.item.find((c) => c.type === "section") as SectionBlock;
		expect(oauth.children.map((c) => (c as Field).name)).toEqual(["oauth.clientId"]);
		// the derived row summary never names a section
		expect(entries.summary).toEqual(["url"]);
		expect(() => assertDrawable(schema)).not.toThrow();
	});

	it("scalar additionalProperties falls back instead of building an edgeless table", () => {
		const schema = objectSchema({ headers: { type: "object", additionalProperties: { type: "string" } } });
		const { value: generated, warnings } = captureWarnings(() => generate(schema));
		expect(generated.fallbacks).toEqual(["/headers"]);
		expect(warnings.some((w) => w.includes("/headers"))).toBe(true);
		const children = generated.form.root.type === "form" ? generated.form.root.children : [];
		expect(fieldNamed(children, "headers").type).toBe("longtext");
	});

	it("a scalar writeOnly table still draws as a secret table", () => {
		const schema = objectSchema({
			headers: { type: "object", additionalProperties: { type: "string", writeOnly: true } },
		});
		const generated = generate(schema);
		expect(generated.fallbacks).toEqual([]);
		expect(generated.secrets).toEqual([{ pattern: "/headers/*" }]);
		const entries = fieldNamed(childrenOf(schema), "headers") as EntriesField;
		expect(entries.shape).toBe("table");
		expect((entries.item as Field[]).map((f) => f.name)).toEqual(["value"]);
	});

	it("a table with propertyNames still generates table entries", () => {
		const schema = objectSchema({
			servers: {
				type: "object",
				propertyNames: { pattern: "^[a-z][a-z0-9-]*$" },
				additionalProperties: { type: "object", properties: { url: { type: "string" } } },
			},
		});
		const entries = fieldNamed(childrenOf(schema), "servers") as EntriesField;
		expect(entries.type).toBe("entries");
		expect(entries.shape).toBe("table");
		expect((entries.item as Field[]).map((f) => f.name)).toEqual(["url"]);
		expect(() => assertDrawable(schema)).not.toThrow();
	});

	it("anyOf by const becomes a choice and a variant", () => {
		const children = childrenOf(
			objectSchema({
				mode: {
					anyOf: [
						{ type: "string", const: "fast", title: "Fast" },
						{ type: "string", const: "slow", title: "Slow" },
					],
				},
				transport: {
					anyOf: [
						{
							type: "object",
							title: "HTTP",
							properties: { kind: { const: "http" }, url: { type: "string" } },
						},
						{
							type: "object",
							title: "Command",
							properties: { kind: { const: "command" }, command: { type: "string" } },
						},
					],
				},
			}),
		);
		const mode = fieldNamed(children, "mode") as ChoiceField;
		expect(mode.type).toBe("choice");
		expect(mode.options).toEqual([
			{ id: "fast", label: "Fast" },
			{ id: "slow", label: "Slow" },
		]);
		const variant = fieldNamed(children, "transport") as VariantField;
		expect(variant.type).toBe("variant");
		expect(variant.discriminator).toBe("kind");
		expect(variant.options.map((o) => o.id)).toEqual(["http", "command"]);

		// a union no recogniser understands still falls back honestly
		expect(
			generate(objectSchema({ mixed: { anyOf: [{ type: "string" }, { type: "number" }] } }))
				.fallbacks,
		).toEqual(["/mixed"]);
	});

	it("oneOf by const becomes a variant", () => {
		const children = childrenOf(
			objectSchema({
				transport: {
					oneOf: [
						{
							type: "object",
							title: "HTTP",
							properties: {
								kind: { const: "http" },
								url: { type: "string" },
							},
						},
						{
							type: "object",
							title: "Command",
							properties: {
								kind: { const: "command" },
								command: { type: "string" },
							},
						},
					],
				},
			}),
		);
		const variant = fieldNamed(children, "transport") as VariantField;
		expect(variant.type).toBe("variant");
		expect(variant.discriminator).toBe("kind");
		expect(variant.options.map((o) => o.id)).toEqual(["http", "command"]);
		expect(variant.options.map((o) => o.label)).toEqual(["HTTP", "Command"]);
		expect(variant.options[0]?.children.map((c) => (c as Field).name)).toEqual(["url"]);
	});

	it("top-level secrets come first under Credentials", () => {
		const children = childrenOf(
			objectSchema({
				name: { type: "string" },
				apiKey: { type: "string", writeOnly: true },
				other: { type: "string", writeOnly: true },
			}),
		);
		expect(children[0]?.type).toBe("section");
		const credentials = children[0] as SectionBlock;
		expect(credentials.title).toBe("Credentials");
		expect(credentials.children.map((c) => (c as Field).name)).toEqual(["apiKey", "other"]);
	});

	it("if/then property falls back and is listed", () => {
		const warnings: string[] = [];
		const original = console.warn;
		console.warn = (message: string) => warnings.push(message);
		try {
			const generated = generate(
				objectSchema({
					weird: {
						type: "object",
						properties: { a: { type: "string" } },
						if: { properties: { a: { const: "x" } } },
						then: { required: ["a"] },
					},
					fine: { type: "string" },
				}),
			);
			expect(generated.fallbacks).toEqual(["/weird"]);
			expect(warnings.some((w) => w.includes("/weird"))).toBe(true);
			// the other property still generates its normal field
			const children = generated.form.root.type === "form" ? generated.form.root.children : [];
			expect(fieldNamed(children, "fine").type).toBe("text");
		} finally {
			console.warn = original;
		}
	});

	it("a TypeBox Type.Object schema generates the same form as its JSON", () => {
		const schema = Type.Object({
			name: Type.String({ title: "Name" }),
			count: Type.Integer({ minimum: 0, maximum: 10 }),
			enabled: Type.Boolean(),
			mode: Type.Union([Type.Literal("a"), Type.Literal("b")]),
			transport: Type.Union([
				Type.Object({ kind: Type.Literal("http"), url: Type.String() }, { title: "HTTP" }),
				Type.Object({ kind: Type.Literal("command"), command: Type.String() }, { title: "Command" }),
			]),
			tags: Type.Array(Type.String()),
			nested: Type.Object(
				{ inner: Type.String() },
				{ title: "Nested" },
			),
		});
		// SAFETY: a TypeBox schema IS a JSON Schema object; the cast only
		// adds the index signature the structural view requires.
		const fromTypeBox = generate(schema as unknown as JsonSchema);
		const fromJson = generate(JSON.parse(JSON.stringify(schema)) as JsonSchema);
		expect(fromTypeBox.form).toEqual(fromJson.form);
		expect(fromTypeBox.fallbacks).toEqual([]);
		expect(fromTypeBox.secrets).toEqual(fromJson.secrets);

		// Type.Union emits `anyOf`: a union of literals is a choice and a
		// union of objects sharing a discriminator is a variant — the same
		// forms the `oneOf` spellings above produce.
		const children = (fromTypeBox.form.root as FormBlock).children;
		const mode = fieldNamed(children, "mode") as ChoiceField;
		expect(mode.type).toBe("choice");
		expect(mode.options).toEqual([
			{ id: "a", label: "a" },
			{ id: "b", label: "b" },
		]);
		const transport = fieldNamed(children, "transport") as VariantField;
		expect(transport.type).toBe("variant");
		expect(transport.discriminator).toBe("kind");
		expect(transport.options.map((o) => o.id)).toEqual(["http", "command"]);
		// the secret-free TypeBox schema is fully drawable
		expect(() => assertDrawable(schema as unknown as JsonSchema)).not.toThrow();
	});

	it("layout inclusion renders only listed paths and merges overrides", () => {
		const schema = objectSchema({
			a: { type: "string" },
			b: { type: "string" },
			c: { type: "string" },
		});
		const generated = generate(schema, {
			layout: [
				{
					title: "General",
					paths: ["/a", "/b"],
					overrides: { "/a": { label: "Overridden" } },
				},
			],
		});
		const children = generated.form.root.type === "form" ? generated.form.root.children : [];
		expect(children.length).toBe(1);
		const section = children[0] as SectionBlock;
		expect(section.title).toBe("General");
		expect(section.children.map((c) => (c as Field).name)).toEqual(["a", "b"]);
		expect((section.children[0] as Field).label).toBe("Overridden");

		// inclusion is per group: a listed path in a later group still renders once
		const shared = generate(schema, {
			layout: [
				{ title: "First", paths: ["/a"] },
				{ title: "Second", paths: ["/c", "/b"] },
			],
		});
		const groups = (shared.form.root as FormBlock).children;
		expect(groups.map((g) => (g.type === "section" ? g.title : (g as Field).name))).toEqual([
			"First",
			"Second",
		]);
		expect((groups[1] as SectionBlock).children.map((c) => (c as Field).name)).toEqual(["c", "b"]);
	});

	it("a layout path the schema does not declare warns and is skipped", () => {
		const { value: generated, warnings } = captureWarnings(() =>
			generate(objectSchema({ a: { type: "string" } }), {
				layout: [{ title: "General", paths: ["/a", "/nope"] }],
			}),
		);
		expect(warnings.some((w) => w.includes("/nope"))).toBe(true);
		const children = generated.form.root.type === "form" ? generated.form.root.children : [];
		expect((children[0] as SectionBlock).children.map((c) => (c as Field).name)).toEqual(["a"]);
	});

	it("credentials render first even when the layout omits them", () => {
		const schema = objectSchema({
			name: { type: "string" },
			apiKey: { type: "string", writeOnly: true },
		});
		const generated = generate(schema, { layout: [{ title: "General", paths: ["/name"] }] });
		const children = generated.form.root.type === "form" ? generated.form.root.children : [];
		expect(children.map((c) => (c.type === "section" ? c.title : (c as Field).name))).toEqual([
			"Credentials",
			"General",
		]);
		const credentials = children[0] as SectionBlock;
		expect(credentials.children.map((c) => (c as Field).name)).toEqual(["apiKey"]);
		expect(generated.secrets).toEqual([{ pattern: "/apiKey" }]);

		// a layout that DOES list the secret renders it once, still under Credentials
		const listed = generate(schema, { layout: [{ title: "General", paths: ["/name", "/apiKey"] }] });
		const listedChildren = listed.form.root.type === "form" ? listed.form.root.children : [];
		expect((listedChildren[0] as SectionBlock).title).toBe("Credentials");
		expect((listedChildren[1] as SectionBlock).children.map((c) => (c as Field).name)).toEqual([
			"name",
		]);
		expect(listed.secrets).toEqual([{ pattern: "/apiKey" }]);
	});

	it("a dangling $ref falls back instead of crashing", () => {
		const generated = generate(objectSchema({ broken: { $ref: "#/definitions/missing" } }));
		expect(generated.fallbacks).toEqual(["/broken"]);
	});

	it("secrets inside a variant branch land at the property's own path", () => {
		const generated = generate(
			objectSchema({
				auth: {
					oneOf: [
						{
							type: "object",
							properties: { kind: { const: "token" }, token: { type: "string", writeOnly: true } },
						},
						{
							type: "object",
							properties: { kind: { const: "none" } },
						},
					],
				},
			}),
		);
		expect(generated.secrets).toEqual([{ pattern: "/auth/token" }]);
	});

	it("schema required marks fields required", () => {
		const children = childrenOf({
			type: "object",
			properties: { must: { type: "string" }, may: { type: "string" } },
			required: ["must"],
		});
		expect(fieldNamed(children, "must").required).toBe(true);
		expect(fieldNamed(children, "may").required).toBeUndefined();
	});

	it("an untitled nested object inlines its fields under the layout group", () => {
		const generated = generate(
			{
				type: "object",
				properties: {
					retry: {
						type: "object",
						properties: { enabled: { type: "boolean" } },
					},
				},
			},
			{ layout: [{ title: "General", paths: ["/retry"] }] },
		);
		const children = generated.form.root.type === "form" ? generated.form.root.children : [];
		const section = children[0] as SectionBlock;
		expect(section.title).toBe("General");
		expect(section.children.map((c) => (c as Field).name)).toEqual(["retry.enabled"]);
	});
});

describe("checkSchema", () => {
	it("rejects an array item with writeOnly fields and no x-sigrun-key", () => {
		const result = checkSchema(
			objectSchema({
				servers: {
					type: "array",
					items: {
						type: "object",
						properties: {
							name: { type: "string" },
							token: { type: "string", writeOnly: true },
						},
					},
				},
			}),
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("x-sigrun-key");
			expect(result.error).toContain("/servers");
		}
		// with the key declared, the schema passes
		const keyed = checkSchema(
			objectSchema({
				servers: {
					type: "array",
					items: {
						type: "object",
						"x-sigrun-key": "name",
						properties: {
							name: { type: "string" },
							token: { type: "string", writeOnly: true },
						},
					},
				},
			}),
		);
		expect(keyed.ok).toBe(true);
	});

	it("rejects an x-sigrun-key property that is not a string", () => {
		// A key property that is absent, optional or non-string would make the
		// identity silently unreadable at save time (the entry simply gets no
		// secret key), so the schema is rejected at declare time instead.
		const withKey = (name: unknown) =>
			checkSchema(
				objectSchema({
					servers: {
						type: "array",
						items: {
							type: "object",
							"x-sigrun-key": "name",
							required: ["name"],
							properties: {
								name,
								token: { type: "string", writeOnly: true },
							},
						},
					},
				}),
			);
		expect(withKey({ type: "string" }).ok).toBe(true);
		for (const bad of [{ type: "number" }, { type: "integer" }, { type: "boolean" }, {}]) {
			const result = withKey(bad);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toContain("x-sigrun-key");
				expect(result.error).toContain("string");
			}
		}
	});

	it("rejects a non-object root", () => {
		expect(checkSchema({ type: "string" }).ok).toBe(false);
		expect(checkSchema(null).ok).toBe(false);
		expect(checkSchema([]).ok).toBe(false);
	});

	it("rejects malformed sigrun keywords and unresolvable refs", () => {
		expect(
			checkSchema(objectSchema({ a: { type: "string", "x-sigrun-apply": "sometimes" } })).ok,
		).toBe(false);
		expect(
			checkSchema(objectSchema({ a: { type: "string", "x-sigrun-summary": "name" } })).ok,
		).toBe(false);
		expect(checkSchema(objectSchema({ a: { $ref: "#/definitions/missing" } })).ok).toBe(false);
		expect(checkSchema(objectSchema({ a: { $ref: "https://example.invalid/x" } })).ok).toBe(false);
	});

	it("finds secrets declared inside anyOf branches", () => {
		const result = checkSchema(
			objectSchema({
				servers: {
					type: "array",
					items: {
						anyOf: [
							{
								type: "object",
								properties: { name: { type: "string" }, token: { type: "string", writeOnly: true } },
							},
							{ type: "object", properties: { name: { type: "string" } } },
						],
					},
				},
			}),
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("x-sigrun-key");
	});

	it("collects secret patterns inside array items and tables", () => {
		const generated = generate(
			objectSchema({
				servers: {
					type: "array",
					items: {
						type: "object",
						"x-sigrun-key": "name",
						properties: {
							name: { type: "string" },
							headers: {
								type: "object",
								additionalProperties: { type: "string", writeOnly: true },
							},
						},
					},
				},
			}),
		);
		expect(generated.secrets).toContainEqual({ pattern: "/servers/*/headers/*", key: "name" });
	});
});

describe("assertDrawable", () => {
	it("throws naming each fallback", () => {
		const schema = objectSchema({
			a: { type: "string", patternProperties: { "^x": { type: "string" } } },
			b: { type: "array", prefixItems: [{ type: "string" }] },
			fine: { type: "string" },
		});
		expect(() => assertDrawable(schema)).toThrowError(/\/a/);
		expect(() => assertDrawable(schema)).toThrowError(/\/b/);
		expect(() => assertDrawable(objectSchema({ fine: { type: "string" } }))).not.toThrow();
	});
});
