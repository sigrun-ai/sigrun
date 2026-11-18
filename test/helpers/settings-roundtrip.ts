/**
 * Settings form round-trip (handback A6): render a schema-declared settings
 * surface from a stored document, build the form's initial values with a
 * REAL client's `initialValue` (webui or tui), save them back untouched,
 * and return the stored document. Catches the write-shape-vs-read-shape
 * class (0.18 provider-openai flat drop, 0.21 E1 row corruption, A1 root
 * groups rendering defaults).
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { FormBlock, JsonObject, JsonValue, Tree } from "@sigrun/shared/blocks";
import { loadConfig } from "../../src/config.js";
import { openHarness } from "../../src/harness/boot.js";
import type { ProviderContributor } from "../../src/harness/providers/index.js";
import { createServer } from "../../src/server/index.js";
import { applyDefaults } from "../../src/settings/schema/defaults.js";
import type { JsonSchema } from "../../src/settings/schema/index.js";
import * as webuiValues from "../../webui/src/blocks/form/values.js";
import * as tuiValues from "../../tui/src/blocks/form/values.js";
import { seededIdentity } from "./identity.js";

export type RoundTripClient = "webui" | "tui";

export interface RoundTripOptions {
	/** Render + save the personal (user-scope) page instead of the system page. */
	readonly scope?: "system" | "user";
	/** The user's stored overrides document (user-settings/alice/<slug>.json). */
	readonly userStored?: Record<string, unknown>;
}

export interface RoundTripResult {
	/** The surface's bound settings object, as the server rendered it. */
	readonly rendered: Record<string, JsonValue>;
	/** The client's initial form values (disabled fields dropped). */
	readonly initial: JsonObject;
	/** The stored document after the untouched save (the scope's file). */
	readonly after: Record<string, unknown>;
}

const SLUG = "acme-roundtrip";
const FIXTURE = pathToFileURL(
	join(import.meta.dirname, "..", "fixtures", "fixture-settings-roundtrip", "index.js"),
).href;
const CLIENTS = { webui: webuiValues, tui: tuiValues } as const;

const cleanups: Array<() => Promise<void>> = [];

/** Tear down every harness a round trip booted (call from afterEach). */
export async function cleanupRoundTrips(): Promise<void> {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	delete (globalThis as { __acmeRoundtripSchema?: unknown }).__acmeRoundtripSchema;
}

async function readJson(path: string): Promise<Record<string, unknown>> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
}

function resolvePointer(data: unknown, pointer: string): unknown {
	let cursor = data;
	for (const raw of pointer.split("/").slice(1)) {
		const segment = raw.replaceAll("~1", "/").replaceAll("~0", "~");
		if (typeof cursor !== "object" || cursor === null) return undefined;
		cursor = (cursor as Record<string, unknown>)[segment];
	}
	return cursor;
}

export async function roundTrip(
	schema: JsonSchema,
	stored: Record<string, unknown>,
	client: RoundTripClient,
	options: RoundTripOptions = {},
): Promise<RoundTripResult> {
	(globalThis as { __acmeRoundtripSchema?: unknown }).__acmeRoundtripSchema = schema;
	const dir = await mkdtemp(join(tmpdir(), "sigrun-roundtrip-"));
	const configDir = join(dir, "config");
	await mkdir(join(configDir, "settings"), { recursive: true });
	await writeFile(join(configDir, "settings", `${SLUG}.json`), JSON.stringify(stored));
	const userFile = join(configDir, "user-settings", "alice", `${SLUG}.json`);
	if (options.userStored !== undefined) {
		await mkdir(join(configDir, "user-settings", "alice"), { recursive: true });
		await writeFile(userFile, JSON.stringify(options.userStored));
	}
	const faux = fauxProvider({ provider: "faux", models: [{ id: "m", contextWindow: 128_000 }] });
	const contributor: ProviderContributor = { name: "ext-faux", providers: [{ provider: faux.provider }] };
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_CONFIG_DIR: configDir,
		SIGRUN_DATA_DIR: join(dir, "data"),
		SIGRUN_CACHE_DIR: join(dir, "cache"),
		SIGRUN_STATE_DIR: join(dir, "state"),
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
		SIGRUN_AUTH: "token",
	});
	const identity = await seededIdentity(join(dir, "seed"), "alice");
	const opened = await openHarness(config, {
		identity,
		extensions: [contributor],
		extensionSpecifiers: [FIXTURE],
		env: { SIGRUN_CONFIG_DIR: configDir },
		settingsDir: dir,
		builtins: false,
		expectHostBridge: true,
	});
	const { token } = await opened.identity.tokens.create("alice-cli", "alice");
	const app = await createServer(opened, config, [], {});
	cleanups.push(async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		// Boot-time curation migrations write after close (see
		// settings-effective.test.ts): let rm retry.
		await rm(dir, { recursive: true, force: true, maxRetries: 5 });
	});

	const surface = `/v1/ext/${SLUG}/surfaces/${options.scope === "user" ? "user-settings" : "settings"}`;
	const headers = { authorization: `Bearer ${token}` };
	const got = await app.inject({ method: "GET", url: surface, headers });
	expect(got.statusCode, got.body).toBe(200);
	const body = got.json() as { tree: Tree; data: Record<string, unknown>; rev: number };
	const block = body.tree.root as FormBlock;
	expect(block.type).toBe("form");
	const bound = (resolvePointer(body.data, block.bind ?? "") ?? {}) as Record<string, JsonValue>;
	const values = CLIENTS[client];
	const initial: JsonObject = {};
	for (const field of values.collectFields(block)) {
		if (field.disabled === true) continue;
		initial[field.name] = values.initialValue(field, bound);
	}
	const saved = await app.inject({
		method: "POST",
		url: `${surface}/actions`,
		headers,
		payload: { action: "save", actionId: "roundtrip", params: {}, payload: { rev: body.rev, values: initial } },
	});
	expect(saved.statusCode, saved.body).toBe(200);
	expect(saved.json(), saved.body).toMatchObject({ ok: true });
	const after = options.scope === "user"
		? await readJson(userFile)
		: await readJson(join(configDir, "settings", `${SLUG}.json`));
	return { rendered: bound, initial, after };
}

/**
 * The round-trip contract: the save changed nothing the schema can see.
 * Defaults apply to a FIXPOINT on both sides: `applyDefaults` fills an
 * absent group with its own `default: {}` without descending into it, so
 * an untouched save that materialises the children's defaults (spec
 * non-goal) is semantically equal and must compare equal. A stored value
 * is never replaced by a default, so a clobber still fails.
 */
export function expectRoundTrip(
	schema: JsonSchema,
	before: Record<string, unknown>,
	after: Record<string, unknown>,
): void {
	expect(withAllDefaults(schema, after)).toEqual(withAllDefaults(schema, before));
}

function withAllDefaults(schema: JsonSchema, value: Record<string, unknown>): Record<string, unknown> {
	let current = value;
	for (let pass = 0; pass < 16; pass++) {
		const next = applyDefaults(schema, current);
		if (JSON.stringify(next) === JSON.stringify(current)) return next;
		current = next;
	}
	throw new Error("applyDefaults did not reach a fixpoint");
}
