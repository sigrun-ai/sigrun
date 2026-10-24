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
import { afterAll, describe, expect, test, vi } from "vitest";
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
 * first generation open until released; `auth`/`users` boot the token
 * posture (directory users beyond the seeded admin, for the mine filter). */
async function bootServer(options?: {
	now?: () => Date;
	gate?: { readonly promise: Promise<void> };
	auth?: "none" | "token";
	users?: readonly string[];
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
	const identity = await seededIdentity(dir);
	for (const user of options?.users ?? []) {
		if (identity.users.get(user) === undefined) {
			await identity.users.add({ user, admin: false, source: "cli" });
		}
	}
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_AUTH: options?.auth ?? "none",
		SIGRUN_WORKSPACE_PATH: dir,
	});
	const opened = await openHarness(config, {
		identity,
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

/** Submit one input and settle it (the §7.1 bounded wait); returns the
 *  settled record. */
async function submit(
	app: FastifyInstance,
	conversationId: number,
	input: string,
) {
	const response = await app.inject({
		method: "POST",
		url: `/v1/conversations/${conversationId}/submissions?waitMs=5000`,
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
		expect(settled.submission.status).toBe("done");
		const at = settled.submission.answer;
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

	test("creation and settled runs both stamp lastActivityAt", async () => {
		const { app, opened } = await bootServer({ now: () => new Date(PINNED) });
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const fresh = await createViaRoute(app);
		// Creation IS activity: a fresh conversation sorts at the TOP from the
		// moment it exists (it used to carry no stamp until its first submit,
		// sorting to the bottom of "Earlier").
		expect(
			(await listRows(app)).find((row) => row.id === fresh)?.lastActivityAt,
		).toBe(PINNED);
		await submit(app, root.id, "hello");
		await waitFor("the settle stamp", async () => {
			const row = (await listRows(app)).find((one) => one.id === root.id);
			return row?.lastActivityAt !== undefined;
		});
		const rows = await listRows(app);
		expect(rows.find((row) => row.id === root.id)?.lastActivityAt).toBe(PINNED);
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
		// The route returns at admission (§7.1), so fire it and hold the run
		// open: while the generation is gated, the stamp must ALREADY be there.
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

// ---------------------------------------------------------------------------
// The lean list (core hardening W3 Task 2): scan records + session-meta
// snapshots only — no view reads, no entryCount, archived/mine filters.
// ---------------------------------------------------------------------------

describe("GET /v1/conversations lean list", () => {
	test("summaries carry no entryCount key", async () => {
		const { app } = await bootServer();
		await createViaRoute(app);
		await createViaRoute(app);
		const rows = await listRows(app);
		expect(rows.length).toBeGreaterThanOrEqual(2);
		for (const row of rows) {
			expect("entryCount" in row).toBe(false);
		}
	});

	test("?archived=false omits archived; ?archived=true only archived; absent = all", async () => {
		const { app } = await bootServer();
		const live = await createViaRoute(app);
		const archived = await createViaRoute(app);
		expect((await patchMeta(app, archived, { archived: true })).statusCode).toBe(200);
		const rows = await listRows(app);
		expect(rows.map((row) => row.id)).toEqual(
			expect.arrayContaining([live, archived]),
		);
		const active = await app.inject({
			method: "GET",
			url: "/v1/conversations?archived=false",
		});
		expect(active.statusCode).toBe(200);
		const activeRows = active.json().conversations as Row[];
		expect(activeRows.map((row) => row.id)).toContain(live);
		expect(activeRows.map((row) => row.id)).not.toContain(archived);
		for (const row of activeRows) expect(row.archived).toBe(false);
		const onlyArchived = await app.inject({
			method: "GET",
			url: "/v1/conversations?archived=true",
		});
		expect(onlyArchived.statusCode).toBe(200);
		expect((onlyArchived.json().conversations as Row[]).map((row) => row.id)).toEqual([
			archived,
		]);
	});

	test("a non-boolean archived value is a fail-loud 400", async () => {
		const { app } = await bootServer();
		const response = await app.inject({
			method: "GET",
			url: "/v1/conversations?archived=maybe",
		});
		expect(response.statusCode).toBe(400);
		expect(response.json()).toEqual({ error: "invalid_field", field: "archived" });
	});

	test("?mine=true returns only the caller's conversations (token identities)", async () => {
		const { app, opened } = await bootServer({
			auth: "token",
			users: ["alice", "bob"],
		});
		const aliceToken = (await opened.identity.tokens.create("t", "alice")).token;
		const bobToken = (await opened.identity.tokens.create("t", "bob")).token;
		const createAs = async (token: string): Promise<number> => {
			const response = await app.inject({
				method: "POST",
				url: "/v1/conversations",
				headers: { authorization: `Bearer ${token}` },
			});
			expect(response.statusCode).toBe(201);
			return response.json().id as number;
		};
		const aliceId = await createAs(aliceToken);
		const bobId = await createAs(bobToken);
		// A conversation alice can SEE but does not own (household read
		// sharing) — without it the unfiltered and mine lists would coincide
		// (a non-owner's private rows are hidden, not listed).
		const shared = await app.inject({
			method: "PATCH",
			url: `/v1/conversations/${bobId}/meta`,
			payload: { sharing: { scope: "household", level: "read" } },
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${bobToken}`,
			},
		});
		expect(shared.statusCode).toBe(200);
		const listAs = async (token: string, query = ""): Promise<number[]> => {
			const response = await app.inject({
				method: "GET",
				url: `/v1/conversations${query}`,
				headers: { authorization: `Bearer ${token}` },
			});
			expect(response.statusCode).toBe(200);
			return (response.json().conversations as Row[]).map((row) => row.id as number);
		};
		// Unfiltered, alice sees her own, the shared one, and the boot root
		// (ownerless); ?mine narrows to exactly her own row.
		const unfiltered = await listAs(aliceToken);
		expect(unfiltered).toEqual(expect.arrayContaining([aliceId, bobId]));
		expect(await listAs(aliceToken, "?mine=true")).toEqual([aliceId]);
		expect(await listAs(bobToken, "?mine=true")).toEqual([bobId]);
	});

	test("a people share grants a stored group and hides non-members", async () => {
		const { app, opened } = await bootServer({
			auth: "token",
			users: ["alice", "bob", "carol"],
		});
		await opened.identity.users.setGroups("alice", "test", ["family"]);
		const tokens = Object.fromEntries(
			await Promise.all(
				["alice", "bob", "carol"].map(async (user) => [
					user,
					(await opened.identity.tokens.create("t", user)).token,
				]),
			),
		) as Record<string, string>;
		const created = await app.inject({
			method: "POST",
			url: "/v1/conversations",
			headers: { authorization: `Bearer ${tokens.bob}` },
		});
		expect(created.statusCode).toBe(201);
		const id = created.json().id as number;
		const shared = await app.inject({
			method: "PATCH",
			url: `/v1/conversations/${id}/meta`,
			payload: {
				sharing: {
					scope: "people",
					users: [],
					groups: ["family"],
					level: "read",
				},
			},
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${tokens.bob}`,
			},
		});
		expect(shared.statusCode).toBe(200);
		for (const [user, expected] of [
			["alice", 200],
			["carol", 404],
		] as const) {
			const view = await app.inject({
				method: "GET",
				url: `/v1/conversations/${id}`,
				headers: { authorization: `Bearer ${tokens[user]}` },
			});
			expect(view.statusCode).toBe(expected);
			const list = await app.inject({
				method: "GET",
				url: "/v1/conversations",
				headers: { authorization: `Bearer ${tokens[user]}` },
			});
			expect(list.statusCode).toBe(200);
			expect(
				(list.json().conversations as Row[]).some((row) => row.id === id),
			).toBe(user === "alice");
		}
	});

	test("GET /v1/conversations performs zero view reads", async () => {
		const { app, opened } = await bootServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		await createViaRoute(app);
		// Every conversation handle shares ConversationImpl's prototype, so
		// ONE spy there observes viewState on every instance the route (or
		// anything else in this request) could resolve.
		const proto = Object.getPrototypeOf(root) as {
			viewState: (context: unknown) => Promise<unknown>;
		};
		const spy = vi.spyOn(proto, "viewState");
		try {
			const response = await app.inject({ method: "GET", url: "/v1/conversations" });
			expect(response.statusCode).toBe(200);
			expect((response.json().conversations as Row[]).length).toBeGreaterThanOrEqual(2);
			expect(spy).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});
});
