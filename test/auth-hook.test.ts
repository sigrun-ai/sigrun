/**
 * Task 2 (TUI plan): the server auth hook — the identity seam.
 *
 * `X-Sigrun-User` resolves on EVERY request; the conversation create/fork/
 * import routes stamp the resolved identity as `SessionMeta.owner` (spec §5:
 * the owner seam — "exists in schema from day 1", the header is its first
 * writer).
 *
 * Naive mode (v1): the hook VERIFIES NOTHING — trusted-network posture, no
 * auth flow. Header absent/empty → no identity → behavior exactly today's
 * (Review Focus 4: the request proceeds, `owner` stays unset and the meta
 * doc stays unmaterialized — defaults are free).
 *
 * Fork and import stamp the CALLER's identity, not the source's: a fork's
 * session-meta doc copies the parent's current state (`fork: "current"`),
 * so the caller's header OVERWRITES the copied owner.
 *
 * Hermetic pattern: faux provider + tmp workspace + `app.inject()` (see
 * session-management.test.ts).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { seededIdentity } from "./helpers/identity.js";
import type { FastifyInstance } from "fastify";

/** One hermetic server: harness + faux provider + Fastify app. */
interface TestServer {
	app: FastifyInstance;
	opened: OpenedHarness;
	faux: ReturnType<typeof fauxProvider>;
}

/** Boot a hermetic server in a tmpdir; registers cleanup. */
async function bootServer(): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-authhook-"));
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	faux.setResponses([fauxAssistantMessage("ok")]);
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
	const opened = await openHarness(config, {
		identity: await seededIdentity(dir),
		extensions: [contributor],
		env: {},
	});
	const app = await createServer(opened, config);
	const teardown = async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	};
	cleanups.push(teardown);
	return { app, opened, faux };
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

/** Create one conversation, optionally as an identified caller. */
async function createConversation(
	app: FastifyInstance,
	user?: string,
): Promise<number> {
	const response = await app.inject({
		method: "POST",
		url: "/v1/conversations",
		// No content-type: create takes no fields (an absent body is valid),
		// and a bare `application/json` with no payload is Fastify's empty-
		// JSON-body 400, not the route's contract.
		headers: user === undefined ? {} : { "x-sigrun-user": user },
	});
	expect(response.statusCode).toBe(201);
	return response.json().id;
}

/** Read one conversation's session meta. */
async function fetchMeta(app: FastifyInstance, id: number) {
	const response = await app.inject({
		method: "GET",
		url: `/v1/conversations/${id}/meta`,
	});
	expect(response.statusCode).toBe(200);
	return response.json();
}

/** Submit one input and settle it (forks need a parent with history). */
async function submit(app: FastifyInstance, id: number, input: string) {
	const response = await app.inject({
		method: "POST",
		url: `/v1/conversations/${id}/submissions`,
		payload: { input },
		headers: { "content-type": "application/json" },
	});
	expect(response.statusCode).toBe(202);
	return response.json();
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

describe("POST /v1/conversations × X-Sigrun-User", () => {
	test("header present → meta serves owner: alice", async () => {
		const { app } = await bootServer();
		const id = await createConversation(app, "alice");
		const meta = await fetchMeta(app, id);
		expect(meta.owner).toBe("alice");
	});

	test("no header → request succeeds, owner absent (naive mode, RF4)", async () => {
		const { app } = await bootServer();
		const id = await createConversation(app);
		const meta = await fetchMeta(app, id);
		// Exactly today's behavior: unset owner, untouched defaults.
		expect("owner" in meta).toBe(false);
		expect(meta.pinned).toBe(false);
		expect(meta.tagged).toEqual([]);
		expect(meta.source).toBe("user");
	});

	test("empty/whitespace header → no identity; padded name trims", async () => {
		const { app } = await bootServer();
		const blank = await createConversation(app, "   ");
		expect("owner" in (await fetchMeta(app, blank))).toBe(false);
		const padded = await createConversation(app, "  alice  ");
		expect((await fetchMeta(app, padded)).owner).toBe("alice");
	});
});

// ---------------------------------------------------------------------------
// fork
// ---------------------------------------------------------------------------

describe("POST /v1/conversations/:id/fork × X-Sigrun-User", () => {
	test("fork stamps the CALLER's identity, not the source's", async () => {
		const { app, faux } = await bootServer();
		const parent = await createConversation(app, "alice");
		faux.setResponses([fauxAssistantMessage("answer")]);
		await submit(app, parent, "hello");
		const forked = await app.inject({
			method: "POST",
			url: `/v1/conversations/${parent}/fork`,
			payload: {},
			headers: { "x-sigrun-user": "bob", "content-type": "application/json" },
		});
		expect(forked.statusCode).toBe(201);
		const meta = await fetchMeta(app, forked.json().id);
		// The fork's doc copied the parent's owner ("current" fork semantics)
		// — the caller's header overwrites it.
		expect(meta.owner).toBe("bob");
	});

	test("fork WITHOUT the header inherits the parent's owner (pi-durable meta copy)", async () => {
		const { app, faux } = await bootServer();
		const parent = await createConversation(app, "alice");
		faux.setResponses([fauxAssistantMessage("answer")]);
		await submit(app, parent, "hello");
		const forked = await app.inject({
			method: "POST",
			url: `/v1/conversations/${parent}/fork`,
			payload: {},
			headers: { "content-type": "application/json" },
		});
		expect(forked.statusCode).toBe(201);
		const meta = await fetchMeta(app, forked.json().id);
		// C1: no caller header → no overwrite → the doc's "current" fork
		// semantics carry the parent's stamped owner through unchanged.
		expect(meta.owner).toBe("alice");
	});
});

// ---------------------------------------------------------------------------
// import
// ---------------------------------------------------------------------------

describe("POST /v1/conversations/import × X-Sigrun-User", () => {
	test("import stamps the CALLER's identity, not the source's", async () => {
		const { app, faux } = await bootServer();
		const source = await createConversation(app, "alice");
		faux.setResponses([fauxAssistantMessage("answer")]);
		await submit(app, source, "hello");
		const exported = await app.inject({
			method: "GET",
			url: `/v1/conversations/${source}/export`,
		});
		expect(exported.statusCode).toBe(200);
		const imported = await app.inject({
			method: "POST",
			url: "/v1/conversations/import",
			payload: exported.body,
			headers: {
				"x-sigrun-user": "carol",
				"content-type": "application/x-ndjson",
			},
		});
		expect(imported.statusCode).toBe(201);
		const meta = await fetchMeta(app, imported.json().id);
		expect(meta.owner).toBe("carol");
	});
});
