/**
 * Settings form round-trip (handback A1 + A3 + A6): every schema shape here
 * must render its STORED values into the field names both clients read,
 * and an untouched save must leave the stored settings unchanged
 * (`expectRoundTrip`). Spec: sigrun-notes
 * superpowers/specs/2026-11-18-sigrun-settings-roundtrip-design.md.
 */

import { afterEach, describe, expect, test } from "vitest";
import type { JsonSchema } from "../src/settings/schema/index.js";
import {
	cleanupRoundTrips,
	expectRoundTrip,
	roundTrip,
	type RoundTripClient,
} from "./helpers/settings-roundtrip.js";

afterEach(cleanupRoundTrips);

const onOff = { type: "boolean", default: true };

/** provider-openai's shape: root-declared groups with defaulted toggles. */
const OPENAI: JsonSchema = {
	type: "object",
	properties: {
		baseUrl: { type: "string", default: "https://acme.example.invalid/v1" },
		chat: { type: "object", properties: { enabled: onOff }, default: {} },
		decisions: { type: "object", properties: { enabled: onOff }, default: {} },
		embeddings: {
			type: "object",
			properties: { enabled: onOff, maxBatch: { type: "integer", minimum: 1, default: 2048 } },
			default: {},
		},
	},
};

describe.each(["webui", "tui"] as RoundTripClient[])("settings round trip (%s)", (client) => {
	test("provider-openai shape: stored OFF toggles render OFF and survive a save", async () => {
		const stored = { chat: { enabled: false }, decisions: { enabled: false } };
		const { initial, after } = await roundTrip(OPENAI, stored, client);
		expect(initial["chat.enabled"]).toBe(false);
		expect(initial["decisions.enabled"]).toBe(false);
		expect(initial["embeddings.enabled"]).toBe(true);
		expectRoundTrip(OPENAI, stored, after);
	});

	test("bifrost nativeProtocols: stored ON over OFF defaults survives a save", async () => {
		const schema: JsonSchema = {
			type: "object",
			properties: {
				nativeProtocols: {
					type: "object",
					properties: {
						responses: { type: "boolean", default: false },
						messages: { type: "boolean", default: false },
					},
				},
			},
		};
		const stored = { nativeProtocols: { responses: true, messages: true } };
		const { initial, after } = await roundTrip(schema, stored, client);
		expect(initial["nativeProtocols.responses"]).toBe(true);
		expect(initial["nativeProtocols.messages"]).toBe(true);
		expectRoundTrip(schema, stored, after);
	});

	test("warden shape: judge + thresholds", async () => {
		const schema: JsonSchema = {
			type: "object",
			properties: {
				judge: { type: "object", properties: { enabled: onOff }, default: {} },
				thresholds: {
					type: "object",
					properties: {
						card: { type: "number", default: 0.7 },
						clearAsk: { type: "number", default: 0.7 },
						irreversible: { type: "number", default: 0.9 },
					},
					default: {},
				},
			},
		};
		const stored = { judge: { enabled: false }, thresholds: { card: 0.5, clearAsk: 0.7, irreversible: 0.95 } };
		const { initial, after } = await roundTrip(schema, stored, client);
		expect(initial["judge.enabled"]).toBe(false);
		expect(initial["thresholds.card"]).toBe(0.5);
		expect(initial["thresholds.irreversible"]).toBe(0.95);
		expectRoundTrip(schema, stored, after);
	});

	test("a group two deep renders and round-trips", async () => {
		const schema: JsonSchema = {
			type: "object",
			properties: {
				a: {
					type: "object",
					properties: { b: { type: "object", properties: { c: { type: "integer", default: 1 } } } },
				},
			},
		};
		const stored = { a: { b: { c: 7 } } };
		const { initial, after } = await roundTrip(schema, stored, client);
		expect(initial["a.b.c"]).toBe(7);
		expectRoundTrip(schema, stored, after);
	});

	test("an unknown key in a group does not blank the declared fields", async () => {
		const stored = { chat: { enabled: false, legacy: 1 } };
		const { initial } = await roundTrip(OPENAI, stored, client);
		expect(initial["chat.enabled"]).toBe(false);
	});

	test("a table row with a nested group round-trips (0.21.0 E1 regression)", async () => {
		const schema: JsonSchema = {
			type: "object",
			properties: {
				servers: {
					type: "object",
					additionalProperties: {
						type: "object",
						properties: {
							url: { type: "string" },
							auth: { type: "object", properties: { scheme: { type: "string", default: "none" } } },
						},
					},
				},
			},
		};
		const stored = { servers: { s1: { url: "https://acme.example.invalid", auth: { scheme: "bearer" } } } };
		const { after } = await roundTrip(schema, stored, client);
		expectRoundTrip(schema, stored, after);
	});

	test("properties + additionalProperties draws as a table, so it is not flattened (A3)", async () => {
		const schema: JsonSchema = {
			type: "object",
			properties: {
				t: {
					type: "object",
					properties: { a: { type: "string" } },
					additionalProperties: { type: "string" },
				},
			},
		};
		const stored = { t: { a: "x", k: "v" } };
		const { rendered, after } = await roundTrip(schema, stored, client);
		expect(Object.hasOwn(rendered, "t.a")).toBe(false);
		expect(rendered.t).toMatchObject({ a: "x", k: "v" });
		expectRoundTrip(schema, stored, after);
	});

	test("a non-drawable keyword draws a JSON box, so it is not flattened (A3)", async () => {
		const schema: JsonSchema = {
			type: "object",
			properties: {
				p: {
					type: "object",
					properties: {
						a: { type: "string" },
						g: { type: "object", properties: { x: { type: "integer" } } },
					},
					patternProperties: { "^x": { type: "string" } },
				},
			},
		};
		const stored = { p: { a: "y", g: { x: 1 } } };
		const { rendered, after } = await roundTrip(schema, stored, client);
		expect(Object.hasOwn(rendered, "p.a")).toBe(false);
		// The JSON box shows the raw stored object: nothing inside it flattens.
		expect(rendered.p).toEqual({ a: "y", g: { x: 1 } });
		expectRoundTrip(schema, stored, after);
	});

	test("a literal dotted property name is untouched", async () => {
		const schema: JsonSchema = {
			type: "object",
			properties: { "server.port": { type: "integer", default: 3000 } },
		};
		const stored = { "server.port": 4000 };
		const { initial, after } = await roundTrip(schema, stored, client);
		expect(initial["server.port"]).toBe(4000);
		expectRoundTrip(schema, stored, after);
	});

	test("an absent group round-trips", async () => {
		const { after } = await roundTrip(OPENAI, {}, client);
		expectRoundTrip(OPENAI, {}, after);
	});

	test("a root group beside a root table never becomes a table row", async () => {
		const schema: JsonSchema = {
			type: "object",
			properties: { chat: { type: "object", properties: { enabled: onOff } } },
			additionalProperties: { type: "boolean" },
		};
		const stored = { chat: { enabled: false }, extra: true };
		const { rendered, initial, after } = await roundTrip(schema, stored, client);
		expect(initial["chat.enabled"]).toBe(false);
		expect(Object.keys(rendered[""] as Record<string, unknown>)).toEqual(["extra"]);
		expect(Object.hasOwn(after, "chat.enabled")).toBe(false);
		expectRoundTrip(schema, stored, after);
	});

	test("an array drawn as a JSON box renders its raw items", async () => {
		const schema: JsonSchema = {
			type: "object",
			properties: {
				list: {
					type: "array",
					items: { type: "object", properties: { g: { type: "object", properties: { x: { type: "integer" } } } } },
					contains: { type: "object" },
				},
			},
		};
		const stored = { list: [{ g: { x: 1 } }] };
		const { rendered, after } = await roundTrip(schema, stored, client);
		expect(rendered.list).toEqual([{ g: { x: 1 } }]);
		expectRoundTrip(schema, stored, after);
	});

	test("personal page: an overridable leaf inside a group inherits until overridden", async () => {
		const schema: JsonSchema = {
			type: "object",
			properties: {
				limits: {
					type: "object",
					properties: {
						maxTurns: { type: "integer", default: 10, "x-sigrun-overridable": true },
					},
				},
			},
		};
		const system = { limits: { maxTurns: 20 } };
		const inherited = await roundTrip(schema, system, client, { scope: "user" });
		expect(inherited.initial["limits.maxTurns"]).toBeNull();
		expect(inherited.after).toEqual({});
		await cleanupRoundTrips();
		const overridden = await roundTrip(schema, system, client, {
			scope: "user",
			userStored: { limits: { maxTurns: 5 } },
		});
		expect(overridden.initial["limits.maxTurns"]).toBe(5);
		expect(overridden.after).toEqual({ limits: { maxTurns: 5 } });
	});
});
