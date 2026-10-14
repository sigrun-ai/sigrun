/**
 * Task 9a: server foundation — the §5 Fastify scaffold and the four
 * foundation endpoints (create/list/get conversation, meta).
 *
 * The server is a thin layer over `openHarness`'s `OpenedHarness` (spec §5:
 * "serialized native views, not a bespoke endpoint list"): conversation
 * endpoints return pi-durable's `ConversationView` verbatim; `GET /v1/meta`
 * returns the boot facts (harness version, the captured-schema version,
 * extension outcomes) plus the static healthy shape (aggregation is T9e).
 *
 * Hermetic pattern (compaction.test.ts): a faux provider serves `faux/m`
 * through a provider contributor; `openHarness(config, { env: {} })` boots in
 * a tmpdir; `createServer` builds the Fastify app; `app.inject()` exercises
 * routes in-process — no port, no network.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { createServer } from "../src/server/index.js";
import { SCHEMA_VERSION } from "../src/server/schema-fixture.js";
import type { FastifyInstance } from "fastify";

/** The pi-durable version `GET /v1/meta` must report (pinned dependency). */
const PI_DURABLE_VERSION = "1.0.2";

/** The test fixture extension package's entry (loader contract: default factory). */
const FIXTURE_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-ext", "index.js"),
).href;

/** One hermetic server: harness + faux provider + Fastify app. */
interface TestServer {
	app: FastifyInstance;
	opened: OpenedHarness;
	config: ReturnType<typeof loadConfig>;
}

/** Boot a hermetic harness + server in a tmpdir; registers cleanup. */
async function bootServer(options?: {
	extensionSpecifiers?: readonly string[];
}): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-server-"));
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	faux.setResponses([
		fauxAssistantMessage("hello answer"),
		fauxAssistantMessage("second answer"),
	]);
	const contributor: ProviderContributor = {
		name: "ext-faux",
		providers: [{ provider: faux.provider }],
	};
	const config0 = loadConfig({
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
	});
	// This suite asserts the API-only shape (channels: []): override the
	// bundle path to an absent dir so the result never depends on whether
	// the repo's real webui/dist happens to be built in this checkout.
	const config = {
		...config0,
		webuiBundle: join(dir, "no-webui-bundle"),
		webuiBundleExplicit: false,
	};
	const opened = await openHarness(config, {
		extensions: [contributor],
		env: {},
		extensionSpecifiers: options?.extensionSpecifiers,
	});
	const app = await createServer(opened, config);
	const teardown = async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	};
	cleanups.push(teardown);
	return { app, opened, config };
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

// ---------------------------------------------------------------------------
// POST /v1/conversations
// ---------------------------------------------------------------------------

describe("POST /v1/conversations", () => {
	test("creates a conversation and returns its id and view", async () => {
		const { app } = await bootServer();
		const response = await app.inject({
			method: "POST",
			url: "/v1/conversations",
		});
		expect(response.statusCode).toBe(201);
		const body = response.json();
		expect(typeof body.id).toBe("number");
		expect(body.view.conversation).toEqual({ id: body.id });
		// The native view shape: entries + built-in docs.
		expect(Array.isArray(body.view.entries)).toBe(true);
		expect(typeof body.view.docs).toBe("object");
		// New conversations default to the boot default model.
		expect(body.view.docs["pi.agent"]).toEqual({
			model: { provider: "faux", modelId: "m" },
		});
		// T9d: every wire view carries the derived steer field (idle here).
		expect(body.view.steer).toEqual({ busy: false, queued: 0 });
	});

	test("each create returns a distinct conversation", async () => {
		const { app } = await bootServer();
		const first = (await app.inject({ method: "POST", url: "/v1/conversations" })).json();
		const second = (await app.inject({ method: "POST", url: "/v1/conversations" })).json();
		expect(first.id).not.toBe(second.id);
	});
	test("rejects a create body with fields (fail-loud)", async () => {
		const { app } = await bootServer();
		const response = await app.inject({
			method: "POST",
			url: "/v1/conversations",
			payload: { model: "faux/other" },
			headers: { "content-type": "application/json" },
		});
		expect(response.statusCode).toBe(400);
		expect(response.json()).toEqual({ error: "invalid_body" });
	});

});

// ---------------------------------------------------------------------------
// GET /v1/conversations
// ---------------------------------------------------------------------------

describe("GET /v1/conversations", () => {
	test("lists the root conversation plus server-created ones", async () => {
		const { app, opened } = await bootServer();
		const created = (
			await app.inject({ method: "POST", url: "/v1/conversations" })
		).json();
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const response = await app.inject({ method: "GET", url: "/v1/conversations" });
		expect(response.statusCode).toBe(200);
		const body = response.json();
		expect(body.conversations.map((c: { id: number }) => c.id)).toEqual([
			root.id,
			created.id,
		]);
		for (const conversation of body.conversations) {
			expect(typeof conversation.id).toBe("number");
			expect(typeof conversation.entryCount).toBe("number");
		}
	});

	test("the root conversation is the default and always listed", async () => {
		const { app, opened } = await bootServer();
		const response = await app.inject({ method: "GET", url: "/v1/conversations" });
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		expect(response.json().conversations[0].id).toBe(root.id);
	});
});

// ---------------------------------------------------------------------------
// GET /v1/conversations/:id
// ---------------------------------------------------------------------------

describe("GET /v1/conversations/:id", () => {
	test("returns the conversation's serialized native view", async () => {
		const { app, opened } = await bootServer();
		// A live turn through the harness: the server's view must reflect it.
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const submission = await root.submit(
			{ type: "input", content: "hello" },
			BACKGROUND_CONTEXT,
		);
		expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe("done");

		const response = await app.inject({
			method: "GET",
			url: `/v1/conversations/${root.id}`,
		});
		expect(response.statusCode).toBe(200);
		const view = response.json();
		expect(view.conversation).toEqual({ id: root.id });
		expect(view.entries.length).toBeGreaterThanOrEqual(2);
		// The settled turn is visible: user entry then assistant answer.
		const kinds = view.entries.map((entry: { kind: string }) => entry.kind);
		expect(kinds).toContain("pi.user");
		expect(kinds).toContain("pi.assistant");
		expect(view.docs["pi.usage"].models["faux/m"].input).toBeGreaterThan(0);
		// The settled turn is complete: steer back to idle on the wire view.
		expect(view.steer).toEqual({ busy: false, queued: 0 });
	});

	test("404s for an unknown conversation id", async () => {
		const { app } = await bootServer();
		const response = await app.inject({
			method: "GET",
			url: "/v1/conversations/999999",
		});
		expect(response.statusCode).toBe(404);
		expect(response.json()).toEqual({ error: "conversation_not_found" });
	});

	test("404s for a non-numeric id", async () => {
		const { app } = await bootServer();
		const response = await app.inject({
			method: "GET",
			url: "/v1/conversations/not-a-number",
		});
		// Malformed ids are a client error, not a missing conversation.
		expect(response.statusCode).toBe(400);
	});

});

// ---------------------------------------------------------------------------
// GET /v1/meta
// ---------------------------------------------------------------------------

describe("GET /v1/meta", () => {
	test("returns the static healthy shape with real boot facts", async () => {
		const { app } = await bootServer();
		const response = await app.inject({ method: "GET", url: "/v1/meta" });
		expect(response.statusCode).toBe(200);
		const meta = response.json();
		expect(meta).toEqual({
			harnessVersion: PI_DURABLE_VERSION,
			schemaVersion: SCHEMA_VERSION,
			extensions: [],
			health: { backup: "unconfigured", memory: "ok", providers: "ok" },
			capabilities: { backup: false, channels: [] },
		});
	});

	test("surfaces extension outcomes including quarantined ones", async () => {
		const { app } = await bootServer({
			extensionSpecifiers: [FIXTURE_SPECIFIER, "./no-such-extension"],
		});
		const meta = (await app.inject({ method: "GET", url: "/v1/meta" })).json();
		expect(meta.extensions).toEqual([
			{ name: "sigrun.fixture-ext", status: "ok" },
			{
				name: "./no-such-extension",
				status: "quarantined",
				error: expect.stringContaining("no-such-extension") as unknown,
			},
		]);
	});
});
