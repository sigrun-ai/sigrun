/**
 * Ask-user Task 1: declinable interaction records — the decline path as a
 * first-class peer of the answer path (spec §5.1–5.2).
 *
 * A record carrying `declinable: true` may be DECLINED by a human (never
 * auto-answered): the decline sets `status: "skipped"` with
 * `declinedVia` ("button" from the route/host; "message" is Task 2's
 * admitted-message path), sweeps any unread secret delivery, and fires
 * ONE `interactionSettled` payload carrying `declinedVia`.
 *
 * The seam boot mirrors test/interaction-decide.test.ts (openHarness +
 * createServer + seededIdentity); the fixture `fixture-declinable`
 * declares the `decl.ask` kind, captures its host on
 * `globalThis.__declinableHost`, and records every `interactionSettled`
 * payload on `globalThis.__declinableSettled`.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import {
	applyDecline,
	InteractionDoc,
	recordSecretDelivery,
	takeSecretDelivery,
	validateInteraction,
	type InteractionRecord,
	type StoredInteractionRecord,
} from "../src/harness/interactions.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import type { SeamHost } from "../src/harness/seam-host.js";
import { createServer } from "../src/server/index.js";
import { seededIdentity } from "./helpers/identity.js";

/** The declinable fixture entry (host capture + interactionSettled records). */
const DECLINABLE_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-declinable", "index.js"),
).href;

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

interface TestServer {
	app: FastifyInstance;
	opened: OpenedHarness;
}

/**
 * Boot one hermetic server with the declinable fixture loaded. `auth` is
 * "none" (naive single-operator) or "token" (the read-only sharee case).
 */
async function bootServer(authMethod: "none" | "token"): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-decline-"));
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
		SIGRUN_AUTH: authMethod,
		SIGRUN_WORKSPACE_PATH: dir,
		SIGRUN_CONFIG_DIR: join(dir, "config"),
		SIGRUN_CACHE_DIR: join(dir, "cache"),
		SIGRUN_STATE_DIR: join(dir, "state"),
	});
	// Same disable as the other server suites: no auto-naming calls.
	await writeFile(join(dir, "settings.json"), '{"namingModel": false}');
	const identity = await seededIdentity(dir, "alice");
	if (authMethod === "token") {
		await identity.users.add({ user: "bob", admin: false, source: "cli" });
	}
	const opened = await openHarness(config, {
		identity,
		extensions: [contributor],
		env: {},
		extensionSpecifiers: [DECLINABLE_SPECIFIER],
		settingsDir: dir,
	});
	const app = await createServer(opened, {
		...config,
		webui: { ...config.webui, enabled: false },
	});
	cleanups.push(async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	});
	return { app, opened };
}

/** The fixture's captured seam host (tests seed + decline through it). */
function declinableHost(): SeamHost {
	const host = (globalThis as Record<string, unknown>).__declinableHost as
		| SeamHost
		| undefined;
	if (host === undefined) throw new Error("declinable host not captured");
	return host;
}

/** The fixture's interactionSettled records (delivery order). */
function settledRecords(): Record<string, unknown>[] {
	const list = (globalThis as Record<string, unknown>).__declinableSettled;
	return Array.isArray(list) ? (list as Record<string, unknown>[]) : [];
}

/** Reset the fixture's interactionSettled records (tests own them). */
function resetSettled(): void {
	(globalThis as Record<string, unknown>).__declinableSettled = [];
}

/** Await the fixture's interactionSettled delivery for one callId. */
async function waitForSettled(callId: string): Promise<Record<string, unknown>> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		const found = settledRecords().find((one) => one.callId === callId);
		if (found !== undefined) return found;
		if (Date.now() > deadline) {
			throw new Error(
				`no interactionSettled for ${callId} (recorded: ${JSON.stringify(settledRecords())})`,
			);
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

/** Seed one pending decl.ask record through the fixture's captured host. */
async function seed(
	opened: OpenedHarness,
	conversationId: number,
	callId: string,
	extra?: Partial<InteractionRecord>,
): Promise<void> {
	const root = await opened.harness.conversation(
		conversationId as never,
		BACKGROUND_CONTEXT,
	);
	if (root === undefined) throw new Error("conversation missing");
	await declinableHost().seedInteraction(
		conversationId as never,
		{
			kind: "decl.ask",
			callId,
			status: "pending",
			createdAt: 1,
			...(extra ?? {}),
		} as never,
		BACKGROUND_CONTEXT,
	);
}

/** A form tree with one `secret` field (the delivery-sweep case). */
function secretTree(): import("@sigrun/shared/blocks").Tree {
	return {
		v: 1,
		root: {
			type: "form",
			id: "creds",
			bind: "/values",
			mode: "submit",
			children: [{ type: "secret", name: "token", label: "API token" }],
		},
	};
}

// ─── Pure record validation (validateInteraction) ──────────────────────

describe("validateInteraction: the declinable envelope fields", () => {
	const base = {
		kind: "decl.ask",
		callId: "v1",
		status: "pending",
		createdAt: 1,
	};

	test("declinable: false is rejected", () => {
		expect(validateInteraction({ ...base, declinable: false })).toBe(
			"declinable must be true when present",
		);
	});

	test("declinable: true is accepted", () => {
		expect(validateInteraction({ ...base, declinable: true })).toBeNull();
	});

	test("an unknown declinedVia is rejected", () => {
		expect(validateInteraction({ ...base, declinedVia: "x" })).toBe(
			"declinedVia must be 'button' or 'message'",
		);
	});

	test("declinedVia: 'button' and 'message' are accepted", () => {
		expect(
			validateInteraction({ ...base, status: "skipped", declinedVia: "button" }),
		).toBeNull();
		expect(
			validateInteraction({ ...base, status: "skipped", declinedVia: "message" }),
		).toBeNull();
	});
});

// ─── applyDecline (the tracked-draft mutation) ─────────────────────────

describe("applyDecline", () => {
	function draft(over?: Partial<StoredInteractionRecord>): StoredInteractionRecord {
		return {
			kind: "decl.ask",
			callId: "d1",
			status: "pending",
			createdAt: 1,
			declinable: true,
			...(over ?? {}),
		};
	}

	test("a pending declinable draft declines, stamping the envelope", () => {
		const d = draft();
		expect(applyDecline(d, "button", 42, "alice")).toBe("declined");
		expect(d).toMatchObject({
			status: "skipped",
			settledAt: 42,
			answeredBy: "human",
			answeredByUser: "alice",
			declinedVia: "button",
		});
	});

	test("an answered draft is not_pending (first-wins)", () => {
		const d = draft({ status: "answered" });
		expect(applyDecline(d, "button", 42)).toBe("not_pending");
		expect(d.status).toBe("answered");
		expect(d.declinedVia).toBeUndefined();
	});

	test("a pending draft without declinable is not_declinable", () => {
		const d = draft();
		const { declinable: _drop, ...rest } = d;
		const plain = rest as StoredInteractionRecord;
		expect(applyDecline(plain, "button", 42)).toBe("not_declinable");
		expect(plain.status).toBe("pending");
	});
});

// ─── The decline route ─────────────────────────────────────────────────

describe("POST …/interactions/:callId/decline", () => {
	test("declining a pending declinable record: 200, skipped, gone from the pending lists", { timeout: 30_000 }, async () => {
		const { app, opened } = await bootServer("none");
		const root = await opened.harness.root(BACKGROUND_CONTEXT);
		resetSettled();
		await seed(opened, root.id, "decl-1", { declinable: true });

		const declined = await app.inject({
			method: "POST",
			url: `/v1/conversations/${root.id}/interactions/decl-1/decline`,
		});
		expect(declined.statusCode).toBe(200);
		expect(declined.json()).toEqual({
			callId: "decl-1",
			status: "skipped",
			declinedVia: "button",
		});

		// The stored record carries the decline envelope.
		const record = await opened.harness.snapshot(
			InteractionDoc,
			root.id,
			"decl-1",
			BACKGROUND_CONTEXT,
		);
		expect(record).toMatchObject({
			status: "skipped",
			answeredBy: "human",
			declinedVia: "button",
		});
		expect(record?.answeredByUser).toBeUndefined(); // no principal user

		// Absent from the per-conversation pending list and the inbox.
		const list = await app.inject({
			method: "GET",
			url: `/v1/conversations/${root.id}/interactions`,
		});
		expect(list.statusCode).toBe(200);
		expect(list.json().interactions).toEqual([]);
		const inbox = await app.inject({
			method: "GET",
			url: "/v1/interactions?status=pending",
		});
		expect(inbox.statusCode).toBe(200);
		expect(
			(inbox.json().interactions as { callId: string }[]).some(
				(one) => one.callId === "decl-1",
			),
		).toBe(false);
	});

	test("a second decline 404s not_pending; an unknown callId 404s no_such_interaction", { timeout: 30_000 }, async () => {
		const { app, opened } = await bootServer("none");
		const root = await opened.harness.root(BACKGROUND_CONTEXT);
		await seed(opened, root.id, "decl-2", { declinable: true });
		const first = await app.inject({
			method: "POST",
			url: `/v1/conversations/${root.id}/interactions/decl-2/decline`,
		});
		expect(first.statusCode).toBe(200);
		const second = await app.inject({
			method: "POST",
			url: `/v1/conversations/${root.id}/interactions/decl-2/decline`,
		});
		expect(second.statusCode).toBe(404);
		expect(second.json()).toEqual({ error: "not_pending" });
		const unknown = await app.inject({
			method: "POST",
			url: `/v1/conversations/${root.id}/interactions/nope/decline`,
		});
		expect(unknown.statusCode).toBe(404);
		expect(unknown.json()).toEqual({ error: "no_such_interaction" });
	});

	test("a pending record WITHOUT declinable 409s not_declinable", { timeout: 30_000 }, async () => {
		const { app, opened } = await bootServer("none");
		const root = await opened.harness.root(BACKGROUND_CONTEXT);
		await seed(opened, root.id, "decl-3"); // no declinable flag
		const declined = await app.inject({
			method: "POST",
			url: `/v1/conversations/${root.id}/interactions/decl-3/decline`,
		});
		expect(declined.statusCode).toBe(409);
		expect(declined.json()).toEqual({ error: "not_declinable" });
		// Untouched: still pending.
		const record = await opened.harness.snapshot(
			InteractionDoc,
			root.id,
			"decl-3",
			BACKGROUND_CONTEXT,
		);
		expect(record?.status).toBe("pending");
	});

	test("a read-only sharee gets the SAME response as the answer route (403 forbidden)", { timeout: 30_000 }, async () => {
		const { app, opened } = await bootServer("token");
		const { token: aliceToken } = await opened.identity.tokens.create(
			"test",
			"alice",
		);
		const { token: bobToken } = await opened.identity.tokens.create(
			"test",
			"bob",
		);
		const created = await app.inject({
			method: "POST",
			url: "/v1/conversations",
			headers: { authorization: `Bearer ${aliceToken}` },
		});
		expect(created.statusCode).toBe(201);
		const id: number = created.json().id;
		// Household-read: bob sees the conversation but may not write.
		const shared = await app.inject({
			method: "PATCH",
			url: `/v1/conversations/${id}/meta`,
			payload: { sharing: { scope: "household", level: "read" } },
			headers: {
				authorization: `Bearer ${aliceToken}`,
				"content-type": "application/json",
			},
		});
		expect(shared.statusCode).toBe(200);
		await seed(opened, id, "decl-4", { declinable: true });

		const bobHeaders = { authorization: `Bearer ${bobToken}` };
		const decline = await app.inject({
			method: "POST",
			url: `/v1/conversations/${id}/interactions/decl-4/decline`,
			headers: bobHeaders,
		});
		const answer = await app.inject({
			method: "POST",
			url: `/v1/conversations/${id}/interactions/decl-4/answer`,
			payload: { values: { decision: "allow" } },
			headers: { ...bobHeaders, "content-type": "application/json" },
		});
		expect(decline.statusCode).toBe(answer.statusCode);
		expect(decline.json()).toEqual(answer.json());
		expect(decline.statusCode).toBe(403);
		expect(decline.json()).toEqual({ error: "forbidden" });
	});

	test("a decline sweeps the record's unread secret delivery", { timeout: 30_000 }, async () => {
		const { app, opened } = await bootServer("none");
		const root = await opened.harness.root(BACKGROUND_CONTEXT);
		await seed(opened, root.id, "decl-5", {
			declinable: true,
			body: secretTree(),
		});
		// Record a real (unread) delivery for the still-PENDING record —
		// the shape a crash between an answer commit and the settle commit
		// leaves behind; a decline must never let it linger.
		recordSecretDelivery(root.id, "decl-5", {
			values: { token: "tok-acme-not-a-real-credential" },
		});
		const declined = await app.inject({
			method: "POST",
			url: `/v1/conversations/${root.id}/interactions/decl-5/decline`,
		});
		expect(declined.statusCode).toBe(200);
		// The delivery table no longer holds the record's true value.
		expect(takeSecretDelivery(root.id, "decl-5")).toBeUndefined();
	});
});

// ─── The host method (SigrunHost.declineInteraction) ───────────────────

describe("host.declineInteraction", () => {
	test("declines a pending declinable record as a human user; a second call is false", { timeout: 30_000 }, async () => {
		const { opened } = await bootServer("none");
		const root = await opened.harness.root(BACKGROUND_CONTEXT);
		resetSettled();
		await seed(opened, root.id, "decl-h1", { declinable: true });
		const host = declinableHost();
		const first = await host.declineInteraction(
			root.id as never,
			"decl-h1",
			BACKGROUND_CONTEXT,
			{ user: "alice" },
		);
		expect(first).toBe(true);
		const record = await opened.harness.snapshot(
			InteractionDoc,
			root.id,
			"decl-h1",
			BACKGROUND_CONTEXT,
		);
		expect(record).toMatchObject({
			status: "skipped",
			answeredBy: "human",
			answeredByUser: "alice",
			declinedVia: "button",
		});
		// A second decline: not pending → false.
		const second = await host.declineInteraction(
			root.id as never,
			"decl-h1",
			BACKGROUND_CONTEXT,
			{ user: "alice" },
		);
		expect(second).toBe(false);
		// A non-declinable pending record → false, untouched.
		await seed(opened, root.id, "decl-h2");
		const notDeclinable = await host.declineInteraction(
			root.id as never,
			"decl-h2",
			BACKGROUND_CONTEXT,
			{ user: "alice" },
		);
		expect(notDeclinable).toBe(false);
		const untouched = await opened.harness.snapshot(
			InteractionDoc,
			root.id,
			"decl-h2",
			BACKGROUND_CONTEXT,
		);
		expect(untouched?.status).toBe("pending");
	});
});

// ─── interactionSettled carries declinedVia (exactly once) ─────────────

describe("interactionSettled on decline", () => {
	test("one payload with {status: 'skipped', declinedVia: 'button'}", { timeout: 30_000 }, async () => {
		const { app, opened } = await bootServer("none");
		const root = await opened.harness.root(BACKGROUND_CONTEXT);
		resetSettled();
		await seed(opened, root.id, "decl-e1", { declinable: true });
		const declined = await app.inject({
			method: "POST",
			url: `/v1/conversations/${root.id}/interactions/decl-e1/decline`,
		});
		expect(declined.statusCode).toBe(200);
		const payload = await waitForSettled("decl-e1");
		expect(payload).toMatchObject({
			conversationId: root.id,
			callId: "decl-e1",
			kind: "decl.ask",
			status: "skipped",
			declinedVia: "button",
		});
		// Exactly once: no second delivery for the same callId.
		expect(
			settledRecords().filter((one) => one.callId === "decl-e1"),
		).toHaveLength(1);
	});
});
