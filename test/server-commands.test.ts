/**
 * Task 7: the slash-command catalog — `GET /v1/commands` serves the thin
 * metadata list the composer's `/` menu consumes, and every catalog entry's
 * `endpoint` must resolve to a REAL registered route (the catalog is a map
 * over existing endpoints; a dangling path would make the menu execute a
 * 404).
 *
 * Hermetic pattern: faux provider + tmp workspace + `app.inject()` (see
 * server-submissions.test.ts). One booted server covers both tests.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { SLASH_COMMANDS } from "../src/server/commands.js";
import { createServer } from "../src/server/index.js";
import { seededIdentity } from "./helpers/identity.js";
import type { FastifyInstance } from "fastify";

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

async function bootServer(): Promise<FastifyInstance> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-commands-"));
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	const contributor: ProviderContributor = {
		name: "ext-faux",
		providers: [{ provider: faux.provider }],
	};
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_AUTH: "none",
		SIGRUN_WORKSPACE_PATH: dir,
	});
	const opened: OpenedHarness = await openHarness(config, {
		identity: await seededIdentity(dir),
		extensions: [contributor],
		env: {},
	});
	const app = await createServer(opened, config);
	cleanups.push(async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	});
	return app;
}

describe("GET /v1/commands", () => {
	test("serves the catalog: the known set with metadata shape", async () => {
		const app = await bootServer();
		const response = await app.inject({ method: "GET", url: "/v1/commands" });
		expect(response.statusCode).toBe(200);
		const body = response.json() as {
			commands: {
				name: string;
				description: string;
				argsHint?: string;
				endpoint: { method: string; path: string };
			}[];
		};
		expect(body.commands.map((c) => c.name)).toEqual([
			"new",
			"fork",
			"compact",
			"export",
			"import",
			"name",
			"model",
			"thinking",
		]);
		for (const command of body.commands) {
			expect(typeof command.description).toBe("string");
			expect(command.description.length).toBeGreaterThan(0);
			expect(["GET", "POST", "PATCH"]).toContain(command.endpoint.method);
			expect(command.endpoint.path).toMatch(/^\/v1\//);
		}
		// The argless commands carry NO argsHint; the arg-taking ones do.
		const byName = new Map(body.commands.map((c) => [c.name, c]));
		expect(byName.get("new")?.argsHint).toBeUndefined();
		expect(byName.get("export")?.argsHint).toBeUndefined();
		expect(byName.get("fork")?.argsHint).toBe("[at]");
		expect(byName.get("compact")?.argsHint).toBe("[instructions]");
		expect(byName.get("import")?.argsHint).toBe("<jsonl>");
		expect(byName.get("name")?.argsHint).toBe("<name>");
		expect(byName.get("model")?.argsHint).toBe("<provider/model>");
		expect(byName.get("thinking")?.argsHint).toBe("<level>");
	});

	test("every catalog entry's endpoint resolves to a real registered route", async () => {
		const app = await bootServer();
		for (const command of SLASH_COMMANDS.values()) {
			expect(
				app.hasRoute({ method: command.endpoint.method, url: command.endpoint.path }),
				`${command.name} -> ${command.endpoint.method} ${command.endpoint.path}`,
			).toBe(true);
		}
	});

	test("the registry is keyed by bare name (menu lookups)", () => {
		expect(SLASH_COMMANDS.get("name")?.endpoint).toEqual({
			method: "PATCH",
			path: "/v1/conversations/:id/meta",
		});
		// /model and /thinking share the configure endpoint — each sends
		// exactly one of its two body fields.
		expect(SLASH_COMMANDS.get("model")?.endpoint).toEqual(
			SLASH_COMMANDS.get("thinking")?.endpoint,
		);
	});
});
