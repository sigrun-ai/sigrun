/**
 * Entries and variant fields (settings rework Task 3): summary rows,
 * nested entry forms, saved identities, confirmed deletion and option
 * swaps all stay inside the enclosing form's one-save transaction.
 */

import { describe, expect, test } from "vitest";
import type {
	EntriesField,
	FormBlock,
	JsonObject,
	VariantField,
} from "@sigrun/shared/blocks";
import type { BlockCtx } from "../src/blocks/render.js";
import { renderBlock } from "../src/blocks/render.js";
import type { FormComponent } from "../src/blocks/form/form.js";
import { plainTuiTheme } from "../src/theme.js";

const ENTER = "\r";
const ESC = "\x1b";
const DOWN = "\x1b[B";
const BACKSPACE = "\x7f";

function harness(children: FormBlock["children"], data: JsonObject): {
	form: FormComponent;
	captured: { action: { type: string; name?: string }; payload: JsonObject }[];
} {
	const captured: { action: { type: string; name?: string }; payload: JsonObject }[] = [];
	const ctx: BlockCtx = {
		data,
		theme: plainTuiTheme(),
		locale: "en-CA",
		timeZone: "UTC",
		access: "write",
		unicode: true,
		dispatch: (action, payload) => captured.push({
			action: action as { type: string; name?: string },
			payload: payload as JsonObject,
		}),
		view: { values: {} },
	};
	const block: FormBlock = {
		type: "form",
		bind: "/settings",
		mode: "submit",
		onSubmit: "save",
		submitLabel: "Save",
		children,
	};
	const form = renderBlock(block, ctx) as unknown as FormComponent;
	return { form, captured };
}

function save(form: FormComponent): void {
	form.focusSubmit();
	form.handleInput(ENTER);
}

const tableField: EntriesField = {
	type: "entries",
	name: "servers",
	label: "Servers",
	shape: "table",
	summary: ["url", "token"],
	keyLabel: "Server name",
	item: [
		{ type: "text", name: "url", label: "URL" },
		{ type: "secret", name: "token", label: "Token" },
	],
};

const arrayField: EntriesField = {
	type: "entries",
	name: "servers",
	label: "Servers",
	shape: "array",
	key: "name",
	summary: ["name", "region"],
	reorder: true,
	item: [
		{ type: "text", name: "name", label: "Name" },
		{ type: "text", name: "region", label: "Region" },
	],
};

describe("entries and variant settings fields", () => {
	test("entries render summary rows", () => {
		const { form } = harness([tableField], {
			settings: { servers: { alpha: { url: "https://alpha.example.invalid" } } },
			secrets: { "servers/alpha/token": "stored" },
		});
		const text = form.render(100).join("\n");
		expect(text).toContain("alpha");
		expect(text).toContain("https://alpha.example.invalid");
		expect(text).toContain("set");
		expect(text).not.toContain("stored");
		expect(text).not.toContain("URL:");

		const unset = harness([tableField], {
			settings: { servers: { alpha: { url: "https://alpha.example.invalid" } } },
		});
		expect(unset.form.render(100).join("\n")).toContain("not set");
	});

	test("enter opens an entry; esc returns", () => {
		const { form } = harness([arrayField], {
			settings: { servers: [{ name: "alpha", region: "test" }] },
		});
		expect(form.render(100).join("\n")).not.toContain("Region");
		form.handleInput(ENTER);
		const open = form.render(100).join("\n");
		expect(open).toContain("Name");
		expect(open).toContain("Region");
		expect(open).toContain("alpha");
		form.handleInput(ESC);
		const closed = form.render(100).join("\n");
		expect(closed).not.toContain("Region");
		expect(closed).toContain("alpha");
	});

	test("rename keeps $from", () => {
		const { form, captured } = harness([tableField], {
			settings: { servers: { alpha: { url: "https://alpha.example.invalid" } } },
		});
		form.handleInput(ENTER); // open; the table key is the first nested field
		for (let index = 0; index < 5; index += 1) form.handleInput(BACKSPACE);
		expect(form.values.servers).toEqual({ "": { $from: "alpha", url: "https://alpha.example.invalid", token: "" } });
		for (const char of "beta") form.handleInput(char);
		expect(form.values.servers).toEqual({ beta: { $from: "alpha", url: "https://alpha.example.invalid", token: "" } });
		form.handleInput(ESC);
		save(form);
		expect(captured).toHaveLength(1);
		expect(captured[0]?.payload).toEqual({
			values: {
				servers: {
					beta: {
						$from: "alpha",
						url: "https://alpha.example.invalid",
						token: "",
					},
				},
			},
			rev: 0,
		});
	});

	test("delete asks before removing", () => {
		const { form } = harness([tableField], {
			settings: { servers: { alpha: { url: "https://alpha.example.invalid" } } },
		});
		form.handleInput("x");
		expect(form.render(100).join("\n")).toContain("y/N");
		expect(form.values.servers).toHaveProperty("alpha");
		form.handleInput("n");
		expect(form.render(100).join("\n")).not.toContain("y/N");
		expect(form.values.servers).toHaveProperty("alpha");
		form.handleInput("x");
		form.handleInput("y");
		expect(form.values.servers).toEqual({});
	});

	test("nested secret status reads the saved entry identity", () => {
		const { form } = harness([tableField], {
			settings: { servers: { alpha: { url: "https://alpha.example.invalid" } } },
			secrets: { "servers/alpha/token": "stored" },
		});
		expect(form.values.servers).toEqual({ alpha: { $from: "alpha", url: "https://alpha.example.invalid", token: "" } });
		form.handleInput(ENTER);
		expect(form.render(100).join("\n")).toContain("set (stored)");
	});

	test("duplicate drops $from and suffixes a table key -copy", () => {
		const { form, captured } = harness([tableField], {
			settings: { servers: { alpha: { url: "https://alpha.example.invalid" } } },
		});
		form.handleInput("d");
		expect(form.values.servers).toEqual({
			alpha: { $from: "alpha", url: "https://alpha.example.invalid", token: "" },
			"alpha-copy": { url: "https://alpha.example.invalid", token: "" },
		});
		save(form);
		expect(captured).toHaveLength(1);
	});

	test("array K/J reorders entries without losing their identities", () => {
		const { form } = harness([arrayField], {
			settings: { servers: [{ name: "alpha", region: "one" }, { name: "beta", region: "two" }] },
		});
		form.handleInput("J");
		expect(form.values.servers).toEqual([
			{ $from: "beta", name: "beta", region: "two" },
			{ $from: "alpha", name: "alpha", region: "one" },
		]);
		form.handleInput("K");
		expect((form.values.servers as JsonObject[])[0]?.name).toBe("alpha");
	});

	test("duplicate table keys block the enclosing save", () => {
		const { form, captured } = harness([tableField], {
			settings: {
				servers: {
					alpha: { url: "https://alpha.example.invalid" },
					beta: { url: "https://beta.example.invalid" },
				},
			},
		});
		form.handleInput(DOWN);
		form.handleInput(ENTER);
		for (let index = 0; index < 4; index += 1) form.handleInput(BACKSPACE);
		for (const char of "alpha") form.handleInput(char);
		form.handleInput(ESC);
		save(form);
		expect(captured).toHaveLength(0);
		expect(form.render(100).join("\n")).toContain("Server name must be unique");
	});

	test("variant swap", () => {
		const field: VariantField = {
			type: "variant",
			name: "connection",
			label: "Connection",
			discriminator: "transport",
			options: [
				{
					id: "http",
					label: "HTTP",
					children: [{ type: "text", name: "url", label: "URL" }],
				},
				{
					id: "stdio",
					label: "Standard I/O",
					children: [{ type: "text", name: "command", label: "Command" }],
				},
			],
		};
		const { form, captured } = harness([field], {
			settings: { connection: { transport: "http", url: "https://example.invalid" } },
		});
		expect(form.render(100).join("\n")).toContain("URL");
		form.handleInput(DOWN); // the variant's option cursor selects Standard I/O
		form.handleInput(ENTER);
		const swapped = form.render(100).join("\n");
		expect(swapped).toContain("Command");
		expect(swapped).not.toContain("URL");
		expect(form.values.connection).toEqual({ transport: "stdio", command: "" });
		form.handleInput(ESC);
		save(form);
		expect(captured).toHaveLength(1);
		expect(captured[0]?.payload).toEqual({
			values: { connection: { transport: "stdio", command: "" } },
			rev: 0,
		});
	});
});
