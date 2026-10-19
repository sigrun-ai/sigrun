/**
 * Task A1 (UI refresh): conversation-list metadata — the sidebar's one
 * request. `GET /v1/conversations` carries each conversation's
 * `name` (the user's `meta.name` winning over the server-owned
 * `meta.autoName`), `lastActivityAt` (stamped at submission admission and
 * again at run settlement), fork lineage (`parent: {id, at}` from the
 * durable conversation record), and the `archived`/`pinned` flags — so the
 * clients list without a per-row meta fetch.
 *
 * Hermetic pattern: faux provider + tmp workspace + `app.inject()` (see
 * session-management.test.ts). The admission test holds the generation
 * open on a manual gate (the sse-view.test.ts idiom): the POST waits for
 * settlement server-side, so the request is fired and only awaited after
 * the stamp is asserted.
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
import { SessionMetaDoc } from "../src/server/session-meta.js";
import { createServer } from "../src/server/index.js";
import { seededIdentity } from "./helpers/identity.js";
import type { FastifyInstance } from "fastify";

/** The pinned clock: every stamp is this exact ISO instant. */
const PINNED = "2026-01-02T03:04:05.000Z";

/** A manual gate the faux provider holds one generation open on. */
function makeGate(): { readonly promise: Promise<void>; release(): void } {
	let release: () => void = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

/** One hermetic server: harness + faux provider + Fastify app. */
interface TestServer {
	app: FastifyInstance;
	opened: OpenedHarness;
}

/** Boot a hermetic server. `now` pins the activity clock; `gate` holds the
 * first generation open until released. */
async function bootServer(options?: {
	now?: () => Date;
	gate?: { readonly promise: Promise<void> };
}): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-listmeta-"));
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	faux.setResponses([
		options?.gate === undefined
			? fauxAssistantMessage("answer")
			: async () => {
					await options.gate!.promise;
					return fauxAssistantMessage("gated answer");
				},
	]);
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
		...(options?.now === undefined ? {} : { now: options.now }),
	});
	const app = await createServer(opened, config);
	const teardown = async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	};
	cleanups.push(teardown);
	return { app, opened };
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

/** One row of `GET /v1/conversations` (untyped: the assertions ARE the shape). */
type Row = Record<string, unknown>;

/** The listing's rows. */
async function listRows(app: FastifyInstance): Promise<Row[]> {
	const response = await app.inject({ method: "GET", url: "/v1/conversations" });
	expect(response.statusCode).toBe(200);
	return response.json().conversations as Row[];
}

/** Create one conversation via the route; returns its id. */
async function createViaRoute(app: FastifyInstance): Promise<number> {
	// No content-type: the create takes no body (a typed empty POST would
	// trip Fastify's empty-JSON-body rejection, not the route).
	const response = await app.inject({
		method: "POST",
		url: "/v1/conversations",
	});
	expect(response.statusCode).toBe(201);
	return response.json().id as number;
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

/** `PATCH .../meta` with a JSON body. */
async function patchMeta(
	app: FastifyInstance,
	conversationId: number,
	body: Record<string, unknown>,
) {
	return app.inject({
		method: "PATCH",
		url: `/v1/conversations/${conversationId}/meta`,
		payload: body,
		headers: { "content-type": "application/json" },
	});
}

/** Poll `check` until it holds (10ms interval, 5s cap) — the settle stamp
 * lands on the event bus's drain loop, a macrotask after the run's commit. */
async function waitFor(what: string, check: () => Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	expect(await check(), `timed out waiting for ${what}`).toBe(true);
}

// ---------------------------------------------------------------------------
// GET /v1/conversations — one request, full sidebar metadata
// ---------------------------------------------------------------------------

describe("GET /v1/conversations list metadata", () => {
	test("list carries archived/pinned/name without a per-row meta fetch", async () => {
		const { app } = await bootServer();
		const first = await createViaRoute(app);
		const second = await createViaRoute(app);
		const patched = await patchMeta(app, second, {
			name: "Alpha",
			pinned: true,
			archived: true,
		});
		expect(patched.statusCode).toBe(200);
		const rows = await listRows(app);
		const named = rows.find((row) => row.id === second);
		expect(named).toBeDefined();
		expect(named).toMatchObject({
			name: "Alpha",
			pinned: true,
			archived: true,
		});
		const untouched = rows.find((row) => row.id === first);
		expect(untouched).toBeDefined();
		expect(untouched).toMatchObject({ pinned: false, archived: false });
		expect("name" in untouched!).toBe(false);
	});

	test("user name wins over auto name in the list", async () => {
		const { app, opened } = await bootServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		// The auto name is server-owned state (A2's auto-namer writes it);
		// write it directly, the way that writer will.
		await root.commit(async (tx) => {
			const draft = await tx.doc(SessionMetaDoc, root.id);
			draft.autoName = "Auto";
		}, BACKGROUND_CONTEXT);
		expect(
			(await listRows(app)).find((row) => row.id === root.id)?.name,
		).toBe("Auto");
		// A user name PATCH wins while set…
		await patchMeta(app, root.id, { name: "Mine" });
		expect(
			(await listRows(app)).find((row) => row.id === root.id)?.name,
		).toBe("Mine");
		// …and clearing it falls back to the auto name.
		await patchMeta(app, root.id, { name: null });
		expect(
			(await listRows(app)).find((row) => row.id === root.id)?.name,
		).toBe("Auto");
	});

	test("fork carries parent {id, at}", async () => {
		const { app, opened } = await bootServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const settled = await submit(app, root.id, "hello");
		expect(settled.status).toBe("done");
		const at = settled.answer;
		expect(typeof at).toBe("number");
		const forked = await app.inject({
			method: "POST",
			url: `/v1/conversations/${root.id}/fork`,
			payload: { at },
			headers: { "content-type": "application/json" },
		});
		expect(forked.statusCode).toBe(201);
		const forkId = forked.json().id as number;
		const rows = await listRows(app);
		expect(rows.find((row) => row.id === forkId)?.parent).toEqual({
			id: root.id,
			at,
		});
		expect("parent" in rows.find((row) => row.id === root.id)!).toBe(false);
	});

	test("settled run stamps lastActivityAt; a never-used conversation has none", async () => {
		const { app, opened } = await bootServer({ now: () => new Date(PINNED) });
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const fresh = await createViaRoute(app);
		await submit(app, root.id, "hello");
		await waitFor("the settle stamp", async () => {
			const row = (await listRows(app)).find((one) => one.id === root.id);
			return row?.lastActivityAt !== undefined;
		});
		const rows = await listRows(app);
		expect(rows.find((row) => row.id === root.id)?.lastActivityAt).toBe(PINNED);
		expect(
			"lastActivityAt" in rows.find((row) => row.id === fresh)!,
		).toBe(false);
	});

	test("submission admission stamps lastActivityAt before the run settles", async () => {
		const gate = makeGate();
		const { app, opened } = await bootServer({
			now: () => new Date(PINNED),
			gate,
		});
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		// The route waits for settlement, so fire it and hold the run open:
		// while the generation is gated, the stamp must ALREADY be there.
		const pending = app.inject({
			method: "POST",
			url: `/v1/conversations/${root.id}/submissions`,
			payload: { input: "held" },
			headers: { "content-type": "application/json" },
		});
		try {
			await waitFor("the admission stamp", async () => {
				const row = (await listRows(app)).find((one) => one.id === root.id);
				return row?.lastActivityAt !== undefined;
			});
			expect(
				(await listRows(app)).find((row) => row.id === root.id)
					?.lastActivityAt,
			).toBe(PINNED);
		} finally {
			// Release even on failure: a wedged generation would hang teardown.
			gate.release();
		}
		const response = await pending;
		expect(response.statusCode).toBe(202);
	});
});
