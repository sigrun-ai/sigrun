/**
 * Task 4: Overridable settings and effective resolution.
 *
 * Tests for OVERRIDABLE_KEYWORD, checkSchema leaf-only rule,
 * overridableKeys, overridesSchema, and createEffectiveSettings.
 */

import { describe, expect, it } from "vitest";
import {
	OVERRIDABLE_KEYWORD,
	checkSchema,
	overridableKeys,
	overridesSchema,
	createEffectiveSettings,
} from "../src/settings/effective.js";
import type { JsonSchema } from "../src/settings/schema/keywords.js";
import type { DirectoryUser } from "../src/harness/identity/users.js";

// ─── helpers ────────────────────────────────────────────────────────────

function objectSchema(properties: Record<string, unknown>): JsonSchema {
	return { type: "object", properties };
}

/** A minimal DirectoryUser for testing. */
function user(name: string, admin = false): DirectoryUser {
	return {
		user: name,
		admin,
		createdAt: Date.now(),
		source: "cli",
	};
}

/** The test schema with defaultModel, decisionModel, embeddingModel marked. */
const testSchema = objectSchema({
	defaultModel: { type: "string", [OVERRIDABLE_KEYWORD]: true },
	decisionModel: { type: "string", [OVERRIDABLE_KEYWORD]: true },
	embeddingModel: { type: "string", [OVERRIDABLE_KEYWORD]: true },
	namingModel: { type: "string" },
});

// ─── 1. the marker is accepted only on leaves ───────────────────────────

describe("checkSchema with OVERRIDABLE_KEYWORD", () => {
	it("the marker is accepted only on leaves", () => {
		// A leaf (string) with the marker should pass
		const leaf = objectSchema({
			model: { type: "string", [OVERRIDABLE_KEYWORD]: true },
		});
		expect(checkSchema(leaf).ok).toBe(true);

		// An object with the marker should fail
		const obj = objectSchema({
			nested: {
				type: "object",
				[OVERRIDABLE_KEYWORD]: true,
				properties: { a: { type: "string" } },
			},
		});
		const objResult = checkSchema(obj);
		expect(objResult.ok).toBe(false);
		if (!objResult.ok) {
			expect(objResult.error).toContain("/nested");
			expect(objResult.error).toContain(OVERRIDABLE_KEYWORD);
		}

		// An array with the marker should fail
		const arr = objectSchema({
			tags: {
				type: "array",
				[OVERRIDABLE_KEYWORD]: true,
				items: { type: "string" },
			},
		});
		const arrResult = checkSchema(arr);
		expect(arrResult.ok).toBe(false);
		if (!arrResult.ok) {
			expect(arrResult.error).toContain("/tags");
			expect(arrResult.error).toContain(OVERRIDABLE_KEYWORD);
		}

		// A non-true value should fail
		const bad = objectSchema({
			model: { type: "string", [OVERRIDABLE_KEYWORD]: "yes" },
		});
		const badResult = checkSchema(bad);
		expect(badResult.ok).toBe(false);
		if (!badResult.ok) {
			expect(badResult.error).toContain(OVERRIDABLE_KEYWORD);
		}
	});
});

// ─── 2. overridesSchema keeps exactly the marked keys ───────────────────

describe("overridesSchema", () => {
	it("overridesSchema keeps exactly the marked keys", () => {
		const schema = objectSchema({
			defaultModel: { type: "string", default: "acme/default", [OVERRIDABLE_KEYWORD]: true },
			decisionModel: { type: "string", default: "acme/decision", [OVERRIDABLE_KEYWORD]: true },
			namingModel: { type: "string", default: "acme/naming" },
			retry: {
				type: "object",
				properties: {
					enabled: { type: "boolean", default: true },
				},
			},
		});
		const result = overridesSchema(schema);
		const props = result.properties as Record<string, unknown>;
		expect(Object.keys(props)).toEqual(["defaultModel", "decisionModel"]);
		// default stripped
		expect((props.defaultModel as Record<string, unknown>).default).toBeUndefined();
		expect((props.decisionModel as Record<string, unknown>).default).toBeUndefined();
		// additionalProperties: false at root
		expect(result.additionalProperties).toBe(false);
	});

	it("overridesSchema rejects extra keys", () => {
		const schema = objectSchema({
			defaultModel: { type: "string", [OVERRIDABLE_KEYWORD]: true },
			namingModel: { type: "string" },
		});
		const result = overridesSchema(schema);
		// The root must have additionalProperties: false
		expect(result.additionalProperties).toBe(false);
		// And nested objects must too
		const nested = objectSchema({
			outer: {
				type: "object",
				properties: {
					inner: { type: "string", [OVERRIDABLE_KEYWORD]: true },
					other: { type: "string" },
				},
			},
		});
		const nestedResult = overridesSchema(nested);
		const outer = (nestedResult.properties as Record<string, unknown>).outer as Record<string, unknown>;
		expect(outer.additionalProperties).toBe(false);
	});
});

// ─── 3. overridableKeys ─────────────────────────────────────────────────

describe("overridableKeys", () => {
	it("returns dotted keys for marked leaves", () => {
		const schema = objectSchema({
			defaultModel: { type: "string", [OVERRIDABLE_KEYWORD]: true },
			retry: {
				type: "object",
				properties: {
					enabled: { type: "boolean", [OVERRIDABLE_KEYWORD]: true },
				},
			},
			namingModel: { type: "string" },
		});
		expect(overridableKeys(schema)).toEqual(["defaultModel", "retry.enabled"]);
	});
});

// ─── 4-9. createEffectiveSettings ───────────────────────────────────────

describe("createEffectiveSettings", () => {
	it("a user's override wins for that user only", async () => {
		const system = (key: string) => {
			if (key === "defaultModel") return "acme/system-model";
			return undefined;
		};
		const overrides = async (u: string) => {
			if (u === "alice") return { defaultModel: "acme/alice-model" };
			return {};
		};
		const directory = () => [user("alice", true), user("bob")];
		const effective = createEffectiveSettings({ schema: testSchema, system, overrides, directory });
		expect(await effective.value("defaultModel", "alice")).toBe("acme/alice-model");
		expect(await effective.value("defaultModel", "bob")).toBe("acme/system-model");
	});

	it("an absent override follows later system changes", async () => {
		let systemValue = "acme/v1";
		const system = () => systemValue;
		const overrides = async () => ({});
		const directory = () => [user("alice", true)];
		const effective = createEffectiveSettings({ schema: testSchema, system, overrides, directory });
		expect(await effective.value("defaultModel", "alice")).toBe("acme/v1");
		systemValue = "acme/v2";
		expect(await effective.value("defaultModel", "alice")).toBe("acme/v2");
	});

	it("an orphaned user resolves to the primary admin", async () => {
		const system = (key: string) => {
			if (key === "defaultModel") return "acme/system-model";
			return undefined;
		};
		const overrides = async (u: string) => {
			if (u === "alice") return { defaultModel: "acme/alice-model" };
			return {};
		};
		const directory = () => [user("alice", true)];
		const effective = createEffectiveSettings({ schema: testSchema, system, overrides, directory });
		// "bob" is not in the directory → falls back to primary admin "alice"
		expect(effective.user("bob")).toBe("alice");
		expect(await effective.value("defaultModel", "bob")).toBe("acme/alice-model");
	});

	it("no user resolves to the system value even with a primary admin", async () => {
		const system = (key: string) => {
			if (key === "defaultModel") return "acme/system-model";
			return undefined;
		};
		const overrides = async () => ({ defaultModel: "acme/alice-model" });
		const directory = () => [user("alice", true)];
		const effective = createEffectiveSettings({ schema: testSchema, system, overrides, directory });
		expect(effective.user(undefined)).toBeUndefined();
		expect(await effective.value("defaultModel", undefined)).toBe("acme/system-model");
	});

	it("an empty directory resolves to the system value", async () => {
		const system = (key: string) => {
			if (key === "defaultModel") return "acme/system-model";
			return undefined;
		};
		const overrides = async () => ({});
		const directory = () => [] as readonly DirectoryUser[];
		const effective = createEffectiveSettings({ schema: testSchema, system, overrides, directory });
		expect(effective.user("alice")).toBeUndefined();
		expect(await effective.value("defaultModel", "alice")).toBe("acme/system-model");
	});

	it("unmarked keys in the overrides file are ignored", async () => {
		const system = (key: string) => {
			if (key === "namingModel") return "acme/system-naming";
			return undefined;
		};
		const overrides = async () => ({ namingModel: "acme/user-naming" });
		const directory = () => [user("alice", true)];
		const effective = createEffectiveSettings({ schema: testSchema, system, overrides, directory });
		// namingModel is not marked as overridable, so the override is ignored
		expect(await effective.value("namingModel", "alice")).toBe("acme/system-naming");
	});

	it("the system defaultModel is the env-resolved one", async () => {
		// Simulate: env SIGRUN_DEFAULT_MODEL=acme/env-model, file says acme/file-model
		// The system() dep should return the env-resolved value
		const system = (key: string) => {
			if (key === "defaultModel") return "acme/env-model";
			return undefined;
		};
		const overrides = async () => ({});
		const directory = () => [] as readonly DirectoryUser[];
		const effective = createEffectiveSettings({ schema: testSchema, system, overrides, directory });
		expect(await effective.value("defaultModel", undefined)).toBe("acme/env-model");
	});
});
