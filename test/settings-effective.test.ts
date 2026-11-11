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

	it("overridesSchema rejects extra keys", async () => {
		const { checkStoredSettings } = await import("../src/settings/schema/defaults.js");
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
		// Actually validate a payload with an extra key — it must be rejected
		const validated = checkStoredSettings(result, { namingModel: "acme/hack" });
		expect(validated.repairs.length).toBeGreaterThan(0);
		expect(validated.value).not.toHaveProperty("namingModel");
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

	it("coreSchema has exactly the three overridable keys", async () => {
		const { coreSchema } = await import("../src/settings/core-schema.js");
		expect(overridableKeys(coreSchema)).toEqual(["defaultModel", "decisionModel", "embeddingModel"]);
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
		const { mkdtemp, rm } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const { loadConfig } = await import("../src/config.js");
		const { openHarness } = await import("../src/harness/boot.js");
		const { seededIdentity } = await import("./helpers/identity.js");
		const { fauxProvider } = await import("@earendil-works/pi-ai/providers/faux");
		const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");

		const dir = await mkdtemp(join(tmpdir(), "sigrun-effective-env-"));
		const config = loadConfig({
			SIGRUN_DEFAULT_MODEL: "acme/env-model",
			SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
			SIGRUN_WORKSPACE_PATH: dir,
			SIGRUN_DATA_DIR: join(dir, "data"),
			SIGRUN_AUTH: "token",
		});
		const identity = await seededIdentity(dir);
		const provider = fauxProvider({
			provider: "acme",
			models: [{ id: "env-model", contextWindow: 128_000 }, { id: "file-model", contextWindow: 128_000 }],
		});
		const opened = await openHarness(config, {
			identity,
			extensions: [{ name: "acme-chat", providers: [{ provider: provider.provider }] }],
			env: {},
			settingsDir: dir,
			builtins: false,
		});
		// Write a DIFFERENT defaultModel into the settings file
		await opened.settings.apply({ defaultModel: "acme/file-model", decisionModel: "acme/file-decision" });

		// The env-resolved defaultModel wins over the file
		expect(await opened.effective.value("defaultModel", undefined)).toBe("acme/env-model");
		// A non-defaultModel key resolves from the file
		expect(await opened.effective.value("decisionModel", undefined)).toBe("acme/file-decision");

		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	});
});
