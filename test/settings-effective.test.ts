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
	mergedUserSchema,
	applyOverrides,
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
	it("accepts scalar and array properties but rejects objects and secrets", () => {
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
			expect(objResult.error).toBe(
				"settings schema /nested: x-sigrun-overridable is valid only on scalar or array properties",
			);
		}

		const arr = objectSchema({
			tags: {
				type: "array",
				[OVERRIDABLE_KEYWORD]: true,
				items: { type: "string" },
			},
		});
		expect(checkSchema(arr)).toEqual({ ok: true });

		const secret = objectSchema({
			token: { type: "string", writeOnly: true, [OVERRIDABLE_KEYWORD]: true },
		});
		expect(checkSchema(secret)).toEqual({
			ok: false,
			error: "settings schema /token: x-sigrun-overridable is not valid on writeOnly (secret) properties",
		});

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
		const { Errors } = await import("typebox/schema");
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
		// TypeBox Errors rejects a payload naming an extra key
		const [valid] = Errors(result, { namingModel: "acme/hack" });
		expect(valid).toBe(false);
		// checkStoredSettings repairs it away
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

// ─── 4. extension effective values ──────────────────────────────────────

describe("applyOverrides", () => {
	const schema = objectSchema({
		endpoint: { type: "string", default: "https://system.example.invalid", [OVERRIDABLE_KEYWORD]: true },
		tools: { type: "array", items: { type: "string" }, default: ["system"], [OVERRIDABLE_KEYWORD]: true },
		group: {
			type: "object",
			properties: {
				threshold: { type: "integer", default: 10, [OVERRIDABLE_KEYWORD]: true },
			},
		},
	});

	it("effective returns the system value when no override", () => {
		expect(applyOverrides(schema, { endpoint: "https://system.example.invalid", tools: ["system"] }, {})).toEqual({
			endpoint: "https://system.example.invalid",
			tools: ["system"],
		});
	});

	it("effective returns a valid override", () => {
		expect(applyOverrides(schema, { endpoint: "https://system.example.invalid" }, {
			endpoint: "https://user.example.invalid",
		})).toEqual({ endpoint: "https://user.example.invalid" });
	});

	it("effective ignores an invalid override", () => {
		expect(applyOverrides(schema, { endpoint: "https://system.example.invalid" }, {
			endpoint: 7,
		})).toEqual({ endpoint: "https://system.example.invalid" });
	});

	it("effective treats an empty-string override as present", () => {
		expect(applyOverrides(schema, { endpoint: "https://system.example.invalid" }, {
			endpoint: "",
		})).toEqual({ endpoint: "" });
	});

	it("array override replaces the system list", () => {
		expect(applyOverrides(schema, { tools: ["system", "other"] }, {
			tools: ["user"],
		})).toEqual({ tools: ["user"] });
		expect(applyOverrides(schema, { tools: ["system"] }, { tools: [] })).toEqual({ tools: [] });
	});

	it("effective reads nested overrides", () => {
		expect(applyOverrides(schema, { group: { threshold: 10 } }, {
			group: { threshold: 3 },
		})).toEqual({ group: { threshold: 3 } });
	});

	it("an absent or null override retains the system value", () => {
		expect(applyOverrides(schema, { endpoint: "https://system.example.invalid" }, {
			endpoint: null,
		})).toEqual({ endpoint: "https://system.example.invalid" });
	});

	it("uses root definitions to validate a $ref override", () => {
		const system = {
			...objectSchema({
				endpoint: { $ref: "#/$defs/Endpoint", [OVERRIDABLE_KEYWORD]: true },
			}),
			$defs: { Endpoint: { type: "string", minLength: 3 } },
		};
		expect(applyOverrides(system, {}, { endpoint: "https://user.example.invalid" })).toEqual({
			endpoint: "https://user.example.invalid",
		});
		expect(applyOverrides(system, { endpoint: "https://system.example.invalid" }, { endpoint: "x" })).toEqual({
			endpoint: "https://system.example.invalid",
		});
	});
});

describe("mergedUserSchema", () => {
	it("marks override leaves and keeps the userSchema root open", () => {
		const merged = mergedUserSchema(
			objectSchema({
				endpoint: { type: "string", default: "https://system.example.invalid", [OVERRIDABLE_KEYWORD]: true },
				group: {
					type: "object",
					properties: {
						threshold: { type: "integer", default: 10, [OVERRIDABLE_KEYWORD]: true },
					},
				},
			}),
			objectSchema({
				nickname: { type: "string", default: "tester" },
				group: {
					type: "object",
					properties: { note: { type: "string", default: "personal" } },
				},
			}),
		);
		expect(merged).toEqual({
			type: "object",
			properties: {
				nickname: { type: "string", default: "tester" },
				endpoint: { type: "string", "x-sigrun-inherit": true },
				group: {
					type: "object",
					properties: {
						note: { type: "string", default: "personal" },
						threshold: { type: "integer", "x-sigrun-inherit": true },
					},
				},
			},
		});
		expect(merged?.additionalProperties).toBeUndefined();
	});

	it("preserves personal object keywords and stored table rows", async () => {
		const merged = mergedUserSchema(
			objectSchema({
				group: {
					type: "object",
					properties: {
						threshold: { type: "integer", [OVERRIDABLE_KEYWORD]: true },
					},
				},
			}),
			objectSchema({
				group: {
					type: "object",
					title: "Personal group",
					description: "Personal settings",
					required: ["note"],
					properties: { note: { type: "string", default: "personal" } },
					additionalProperties: { type: "string" },
				},
			}),
		);
		const group = (merged?.properties as Record<string, JsonSchema>).group!;
		expect(group).toMatchObject({
			title: "Personal group",
			description: "Personal settings",
			required: ["note"],
			additionalProperties: { type: "string" },
		});
		const { checkStoredSettings } = await import("../src/settings/schema/defaults.js");
		const checked = checkStoredSettings(merged!, {
			group: { note: "personal", acme: "keep me", threshold: 3 },
		});
		expect(checked.repairs).toEqual([]);
		expect(checked.value).toEqual({
			group: { note: "personal", acme: "keep me", threshold: 3 },
		});
	});

	it("carries system $defs and strips server env fallbacks from override leaves", () => {
		const system = {
			...objectSchema({
				endpoint: {
					$ref: "#/$defs/Endpoint",
					[OVERRIDABLE_KEYWORD]: true,
				},
				envEndpoint: {
					type: "string",
					"x-sigrun-env": "ACME_PERSONAL_URL",
					[OVERRIDABLE_KEYWORD]: true,
				},
			}),
			$defs: { Endpoint: { type: "string", minLength: 3 } },
		};
		const merged = mergedUserSchema(system, undefined);
		expect(merged?.$defs).toEqual(system.$defs);
		expect(merged?.properties).toMatchObject({
			endpoint: { type: "string", minLength: 3, "x-sigrun-inherit": true },
			envEndpoint: { type: "string", "x-sigrun-inherit": true },
		});
		expect((merged?.properties as Record<string, JsonSchema>).envEndpoint).not.toHaveProperty("x-sigrun-env");
	});

	it("merges personal and system definition bags", () => {
		const merged = mergedUserSchema(
			{
				...objectSchema({ endpoint: { type: "string", [OVERRIDABLE_KEYWORD]: true } }),
				$defs: { SystemEndpoint: { type: "string" } },
				definitions: { SystemEndpoint: { type: "string" } },
			},
			{
				...objectSchema({ nickname: { $ref: "#/$defs/PersonalName" } }),
				$defs: { PersonalName: { type: "string", minLength: 3 } },
				definitions: { PersonalName: { type: "string", minLength: 3 } },
			},
		);
		expect(merged?.$defs).toEqual({
			PersonalName: { type: "string", minLength: 3 },
			SystemEndpoint: { type: "string" },
		});
		expect(merged?.definitions).toEqual({
			PersonalName: { type: "string", minLength: 3 },
			SystemEndpoint: { type: "string" },
		});
	});

	it("is undefined when neither schema has properties", () => {
		expect(mergedUserSchema(objectSchema({}), undefined)).toBeUndefined();
	});
});

// ─── 5-10. core effective settings ──────────────────────────────────────

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
		// The boot sweep's curation-history migration (boot.ts curationOf) is
		// fire-and-forget and crash-safe by design; it writes
		// data/users/<user>/curation/history/MIGRATED ~5 ms AFTER close
		// returns. Under full-suite load that lands mid-rm (ENOTEMPTY, main
		// CI 2026-11-18), so let rm retry like the neighbouring suites do.
		await rm(dir, { recursive: true, force: true, maxRetries: 5 });
	});
});
