/**
 * Task 5 (a/b/c): session management — fork, export, import.
 *
 * `POST /v1/conversations/:id/fork` forks the history at one entry id
 * (`{at?}`; absent = the newest entry) and returns the new conversation the
 * create-route way (`201 {id, view}`).
 *
 * `GET /v1/conversations/:id/export` serves the whole history as JSONL
 * (application/x-ndjson), one entry object per line, OLDEST-first (the
 * reverse of the newest-first entries query) so an import replays the
 * transcript in order.
 *
 * `POST /v1/conversations/import` takes the raw JSONL body, creates a new
 * conversation, and appends each parsed entry in order inside one commit —
 * fresh entry ids (stale id/conversationId/byTaskId/head are dropped).
 *
 * Hermetic pattern: faux provider + tmp workspace + `app.inject()` (see
 * server-submissions.test.ts).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxProvider,
	type FauxProviderHandle,
} from "@earendil-works/pi-ai/providers/faux";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { createServer } from "../src/server/index.js";
import { SessionMetaDoc } from "../src/server/session-meta.js";
import { seededIdentity } from "./helpers/identity.js";
import type { FastifyInstance } from "fastify";

/** One hermetic server: harness + faux provider + Fastify app. */
interface TestServer {
	app: FastifyInstance;
	opened: OpenedHarness;
	workspace: string;
	faux: FauxProviderHandle;
}

/** Boot a hermetic server; the faux provider starts EMPTY — each test
 * scripts its own responses before submitting. */
async function bootServer(): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-sessmgmt-"));
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
	return { app, opened, workspace: dir, faux };
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

/** The wire view of one conversation (entries oldest-first). */
async function fetchView(app: FastifyInstance, id: number) {
	const response = await app.inject({
		method: "GET",
		url: `/v1/conversations/${id}`,
	});
	expect(response.statusCode).toBe(200);
	return response.json();
}

/** Submit one input and settle it; returns the settled record. */
async function submit(
	app: FastifyInstance,
	conversationId: number,
	input: string,
) {
	const response = await app.inject({
		method: "POST",
		url: `/v1/conversations/${conversationId}/submissions`,
		payload: { input },
		headers: { "content-type": "application/json" },
	});
	expect(response.statusCode).toBe(202);
	return response.json();
}

// ---------------------------------------------------------------------------
// POST /v1/conversations/:id/fork
// ---------------------------------------------------------------------------

describe("POST /v1/conversations/:id/fork", () => {
	test("fork with explicit `at` keeps the parent's entries up to `at`", async () => {
		const { app, opened, faux } = await bootServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		// Two settled turns → the source conversation has ≥2 entries.
		faux.setResponses([
			fauxAssistantMessage("first answer"),
			fauxAssistantMessage("second answer"),
		]);
		await submit(app, root.id, "first");
		await submit(app, root.id, "second");
		const parent = await fetchView(app, root.id);
		expect(parent.entries.length).toBeGreaterThanOrEqual(2);
		// Fork at the FIRST entry (id order): the fork keeps up to `at`.
		const at = parent.entries[0].id;
		const forked = await app.inject({
			method: "POST",
			url: `/v1/conversations/${root.id}/fork`,
			payload: { at },
			headers: { "content-type": "application/json" },
		});
		expect(forked.statusCode).toBe(201);
		const body = forked.json();
		expect(body.id).not.toBe(root.id);
		// The fork's view shows exactly the parent's prefix through `at`.
		const kept = parent.entries.filter(
			(e: { id: number }) => e.id <= at,
		);
		expect(body.view.entries.map((e: { id: number }) => e.id)).toEqual(
			kept.map((e: { id: number }) => e.id),
		);
		// The fork is durable: it lists (Task 3's scan, not a tracked set).
		const listed = (
			await app.inject({ method: "GET", url: "/v1/conversations" })
		).json();
		expect(
			listed.conversations.some((c: { id: number }) => c.id === body.id),
		).toBe(true);
	});

	test("fork without `at` defaults to the newest entry", async () => {
		const { app, opened, faux } = await bootServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		faux.setResponses([fauxAssistantMessage("answer")]);
		await submit(app, root.id, "hello");
		const parent = await fetchView(app, root.id);
		const forked = await app.inject({
			method: "POST",
			url: `/v1/conversations/${root.id}/fork`,
			payload: {},
			headers: { "content-type": "application/json" },
		});
		expect(forked.statusCode).toBe(201);
		const body = forked.json();
		expect(body.id).not.toBe(root.id);
		// Newest = whole visible history.
		expect(body.view.entries.map((e: { id: number }) => e.id)).toEqual(
			parent.entries.map((e: { id: number }) => e.id),
		);
	});

	test("fork gets \"<name> (fork)\" and drops the copied user name", async () => {
		const { app, opened, faux } = await bootServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		faux.setResponses([fauxAssistantMessage("answer")]);
		await submit(app, root.id, "hello");
		// Let the background auto-namer settle out (it fails on the empty
		// script; its attempt bookkeeping must not leak into the assertions).
		await opened.eventBus.drain(5_000, BACKGROUND_CONTEXT);
		await opened.autoNamer.idle();
		// Name the source "Alpha" through the meta route.
		const patched = await app.inject({
			method: "PATCH",
			url: `/v1/conversations/${root.id}/meta`,
			payload: { name: "Alpha" },
			headers: { "content-type": "application/json" },
		});
		expect(patched.statusCode).toBe(200);
		// Exhaust the source's naming attempts (a host-owned field, so it is
		// seeded through the doc the same way the namer writes it): the fork
		// must NOT inherit the dead count — it stays eligible for auto naming
		// (the plan's Task D deviation (c)).
		const source = await opened.harness.conversation(root.id, BACKGROUND_CONTEXT);
		expect(source).toBeDefined();
		await source!.commit(async (tx) => {
			const draft = await tx.doc(SessionMetaDoc, root.id);
			draft.autoNameAttempts = 3;
		}, BACKGROUND_CONTEXT);
		const forked = await app.inject({
			method: "POST",
			url: `/v1/conversations/${root.id}/fork`,
			payload: {},
			headers: { "content-type": "application/json" },
		});
		expect(forked.statusCode).toBe(201);
		const forkId = forked.json().id as number;
		const listed = (
			await app.inject({ method: "GET", url: "/v1/conversations" })
		).json();
		const forkRow = listed.conversations.find(
			(c: { id: number }) => c.id === forkId,
		);
		expect(forkRow.name).toBe("Alpha (fork)");
		// The fork's own meta carries no USER name — its display name is the
		// server-set fork autoName, and the copied `name` is gone.
		const meta = (
			await app.inject({ method: "GET", url: `/v1/conversations/${forkId}/meta` })
		).json();
		expect("name" in meta).toBe(false);
		expect(meta.autoName).toBe("Alpha (fork)");
		// And no inherited attempt count: the fork is naming-fresh.
		expect("autoNameAttempts" in meta).toBe(false);
	});

	test("unknown conversation → 404; bad `at` → 400 invalid_field", async () => {
		const { app, opened, faux } = await bootServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		faux.setResponses([fauxAssistantMessage("answer")]);
		await submit(app, root.id, "hello");
		const unknown = await app.inject({
			method: "POST",
			url: "/v1/conversations/99999/fork",
			payload: {},
			headers: { "content-type": "application/json" },
		});
		expect(unknown.statusCode).toBe(404);
		// Non-number `at` → invalid_field.
		const badType = await app.inject({
			method: "POST",
			url: `/v1/conversations/${root.id}/fork`,
			payload: { at: "nope" },
			headers: { "content-type": "application/json" },
		});
		expect(badType.statusCode).toBe(400);
		expect(badType.json().error).toBe("invalid_field");
		// An id the conversation never had → invalid_field (never a silent
		// empty fork).
		const badId = await app.inject({
			method: "POST",
			url: `/v1/conversations/${root.id}/fork`,
			payload: { at: 999999 },
			headers: { "content-type": "application/json" },
		});
		expect(badId.statusCode).toBe(400);
		expect(badId.json().error).toBe("invalid_field");
		// Unknown key → invalid_field.
		const badKey = await app.inject({
			method: "POST",
			url: `/v1/conversations/${root.id}/fork`,
			payload: { at: 1, extra: true },
			headers: { "content-type": "application/json" },
		});
		expect(badKey.statusCode).toBe(400);
		expect(badKey.json().error).toBe("invalid_field");
	});
});

// ---------------------------------------------------------------------------
// GET /v1/conversations/:id/export
// ---------------------------------------------------------------------------

describe("GET /v1/conversations/:id/export", () => {
	test("export is JSONL, oldest-first, one entry object per line", async () => {
		const { app, opened, faux } = await bootServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		faux.setResponses([
			fauxAssistantMessage("first answer"),
			fauxAssistantMessage("second answer"),
		]);
		await submit(app, root.id, "first");
		await submit(app, root.id, "second");
		const exported = await app.inject({
			method: "GET",
			url: `/v1/conversations/${root.id}/export`,
		});
		expect(exported.statusCode).toBe(200);
		expect(exported.headers["content-type"]).toContain(
			"application/x-ndjson",
		);
		const lines = (exported.body as string)
			.split("\n")
			.filter((line) => line !== "");
		expect(lines.length).toBeGreaterThanOrEqual(2);
		const entries = lines.map((line) => JSON.parse(line));
		// Oldest-first: ids strictly ascending.
		const ids = entries.map((entry: { id: number }) => entry.id);
		expect([...ids].sort((a, b) => a - b)).toEqual(ids);
		// Each line is an entry object (kind discriminator present).
		for (const entry of entries) {
			expect(typeof entry.kind).toBe("string");
		}
	});

	test("unknown conversation → 404", async () => {
		const { app } = await bootServer();
		const exported = await app.inject({
			method: "GET",
			url: "/v1/conversations/99999/export",
		});
		expect(exported.statusCode).toBe(404);
	});
});

// ---------------------------------------------------------------------------
// POST /v1/conversations/import
// ---------------------------------------------------------------------------

describe("POST /v1/conversations/import", () => {
	test("an export round-trips: same entries in order, then a continue leg settles", async () => {
		const { app, opened, faux } = await bootServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		faux.setResponses([
			fauxAssistantMessage("first answer"),
			fauxAssistantMessage("second answer"),
		]);
		await submit(app, root.id, "first");
		await submit(app, root.id, "second");
		const exported = await app.inject({
			method: "GET",
			url: `/v1/conversations/${root.id}/export`,
		});
		const imported = await app.inject({
			method: "POST",
			url: "/v1/conversations/import",
			payload: exported.body,
			headers: { "content-type": "application/x-ndjson" },
		});
		expect(imported.statusCode).toBe(201);
		const body = imported.json();
		expect(body.id).not.toBe(root.id);
		// Same content in order — fresh ids, so compare the (kind, model/data)
		// projection, oldest-first.
		const source = (exported.body as string)
			.split("\n")
			.filter((line) => line !== "")
			.map((line) => JSON.parse(line));
		const copy = body.view.entries;
		expect(copy.length).toBe(source.length);
		for (const [index, entry] of source.entries()) {
			expect(copy[index].kind).toBe(entry.kind);
			expect(copy[index].model ?? null).toEqual(entry.model ?? null);
			expect(copy[index].data ?? null).toEqual(entry.data ?? null);
		}
		// The continue leg: a submission to the imported copy settles done —
		// the import produced a working conversation, not a dead transcript.
		faux.setResponses([fauxAssistantMessage("continued answer")]);
		const continued = await submit(app, body.id, "continue");
		expect(continued.status).toBe("done");
		const continuedView = await fetchView(app, body.id);
		expect(
			continuedView.entries.some(
				(e: { kind: string }) => e.kind === "pi.assistant",
			),
		).toBe(true);
	});

	test("unparseable line → 400 invalid_body; empty body → 400", async () => {
		const { app } = await bootServer();
		const garbage = await app.inject({
			method: "POST",
			url: "/v1/conversations/import",
			payload: '{"kind":"pi.user"}\nnot json\n',
			headers: { "content-type": "application/x-ndjson" },
		});
		expect(garbage.statusCode).toBe(400);
		expect(garbage.json().error).toBe("invalid_body");
		const empty = await app.inject({
			method: "POST",
			url: "/v1/conversations/import",
			payload: "",
			headers: { "content-type": "application/x-ndjson" },
		});
		expect(empty.statusCode).toBe(400);
		expect(empty.json().error).toBe("invalid_body");
	});
});
