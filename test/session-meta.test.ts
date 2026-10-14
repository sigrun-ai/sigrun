/**
 * Task 10: session-meta document + sidebar resource.
 *
 * `GET /v1/conversations/:id/meta` serves the conversation-scoped session-meta
 * document (kind `sigrun.session-meta`): defaults when the doc was never
 * written — a read NEVER materializes the doc (spec §5: defaults are free;
 * sidebar reads happen constantly, a write per read would churn every
 * revision). `PATCH /v1/conversations/:id/meta` MERGES the body into the doc:
 * per-field shallow set, `draft` sub-merges its own fields, explicit `null`
 * resets a field to its default (`owner: null` removes the field), `tagged`
 * replaces wholesale (arrays never merge element-wise), `source` accepts only
 * `"user"|"cron"`. Validation mirrors the configure endpoint: unknown key →
 * 400 `invalid_field` (naming the key); wrong types → 400 `invalid_body`.
 *
 * Hermetic pattern: faux provider + tmp workspace + `app.inject()` (see
 * server-configure.test.ts). The durability test CLOSES the harness and
 * re-opens it on the same storage path — the doc lives in storage, so meta
 * survives restart by construction (documents are durable).
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
import {
	DEFAULT_SESSION_META,
	SessionMetaDoc,
} from "../src/server/session-meta.js";
import type { FastifyInstance } from "fastify";

/** One hermetic server: harness + faux provider + Fastify app. */
interface TestServer {
	app: FastifyInstance;
	opened: OpenedHarness;
}

/** Boot a hermetic server in a tmpdir; registers cleanup. */
async function bootServer(): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-meta-"));
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
		SIGRUN_WORKSPACE_PATH: dir,
	});
	const opened = await openHarness(config, {
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
	return { app, opened };
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

/** `GET .../meta` for one conversation. */
async function getMeta(app: FastifyInstance, conversationId: number) {
	return app.inject({
		method: "GET",
		url: `/v1/conversations/${conversationId}/meta`,
	});
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

/** The fresh-conversation default served before any PATCH. */
const DEFAULT_BODY = {
	...DEFAULT_SESSION_META,
	draft: { ...DEFAULT_SESSION_META.draft },
};

// ---------------------------------------------------------------------------
// GET /v1/conversations/:id/meta
// ---------------------------------------------------------------------------

describe("GET /v1/conversations/:id/meta", () => {
	test("serves the default meta for a fresh conversation", async () => {
		const { app, opened } = await bootServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const response = await getMeta(app, root.id);
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual(DEFAULT_BODY);
	});

	test("a read never materializes the doc (snapshot stays undefined)", async () => {
		const { app, opened } = await bootServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		await getMeta(app, root.id);
		await getMeta(app, root.id);
		// The read served defaults WITHOUT writing: the doc is still absent.
		const snapshot = await opened.harness.snapshot(
			SessionMetaDoc,
			root.id,
			BACKGROUND_CONTEXT,
		);
		expect(snapshot).toBeUndefined();
	});

	test("404s for an unknown conversation id", async () => {
		const { app } = await bootServer();
		const response = await getMeta(app, 999999);
		expect(response.statusCode).toBe(404);
		expect(response.json()).toEqual({ error: "conversation_not_found" });
	});
});

// ---------------------------------------------------------------------------
// PATCH /v1/conversations/:id/meta
// ---------------------------------------------------------------------------

describe("PATCH /v1/conversations/:id/meta", () => {
	test("sets pinned and tagged; other fields stay default", async () => {
		const { app, opened } = await bootServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const response = await patchMeta(app, root.id, {
			pinned: true,
			tagged: ["a", "b"],
		});
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({
			...DEFAULT_BODY,
			pinned: true,
			tagged: ["a", "b"],
		});
		// Stored, not just echoed.
		const stored = await opened.harness.snapshot(
			SessionMetaDoc,
			root.id,
			BACKGROUND_CONTEXT,
		);
		expect(stored?.pinned).toBe(true);
		expect(stored?.tagged).toEqual(["a", "b"]);
	});

	test("merges: a later draft.text patch preserves earlier tagged and draft.attachments", async () => {
		const { app, opened } = await bootServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		await patchMeta(app, root.id, {
			tagged: ["x"],
			draft: {
				text: "half-written",
				attachments: ["uploads/1/a.png"],
			},
		});
		// Only draft.text — attachments and tagged must survive.
		const response = await patchMeta(app, root.id, {
			draft: { text: "rewritten" },
		});
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({
			...DEFAULT_BODY,
			tagged: ["x"],
			draft: { text: "rewritten", attachments: ["uploads/1/a.png"] },
		});
	});

	test("replaces tagged wholesale (no element-wise merge)", async () => {
		const { app, opened } = await bootServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		await patchMeta(app, root.id, { tagged: ["a", "b"] });
		const response = await patchMeta(app, root.id, { tagged: ["c"] });
		expect(response.statusCode).toBe(200);
		expect(response.json().tagged).toEqual(["c"]);
	});

	test("null clears: pinned and draft reset to defaults", async () => {
		const { app, opened } = await bootServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		await patchMeta(app, root.id, {
			pinned: true,
			tagged: ["a"],
			draft: { text: "kept?", attachments: ["u/1/x"] },
		});
		const response = await patchMeta(app, root.id, {
			pinned: null,
			draft: null,
		});
		expect(response.statusCode).toBe(200);
		// Null clears ONLY the nulled fields: pinned and draft reset, but
		// tagged (set, not nulled) survives — per-field clear semantics.
		expect(response.json()).toEqual({
			...DEFAULT_BODY,
			tagged: ["a"],
		});
	});

	test("null clears tagged, archived, and source as well (the full clear table)", async () => {
		const { app, opened } = await bootServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		await patchMeta(app, root.id, {
			tagged: ["a"],
			archived: true,
			source: "cron",
		});
		const response = await patchMeta(app, root.id, {
			tagged: null,
			archived: null,
			source: null,
		});
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual(DEFAULT_BODY);
	});

	test("a draft sub-key null resets that sub-field only", async () => {
		const { app, opened } = await bootServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		await patchMeta(app, root.id, {
			draft: { text: "kept", attachments: ["u/1/x"] },
		});
		const response = await patchMeta(app, root.id, {
			draft: { attachments: null },
		});
		expect(response.statusCode).toBe(200);
		expect(response.json().draft).toEqual({ text: "kept", attachments: [] });
	});

	test("source accepts user and cron; owner round-trips and null removes it", async () => {
		const { app, opened } = await bootServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const cron = await patchMeta(app, root.id, {
			source: "cron",
			owner: "mike",
		});
		expect(cron.statusCode).toBe(200);
		expect(cron.json().source).toBe("cron");
		expect(cron.json().owner).toBe("mike");
		const user = await patchMeta(app, root.id, { source: "user" });
		expect(user.statusCode).toBe(200);
		expect(user.json().source).toBe("user");
		expect(user.json().owner).toBe("mike");
		const cleared = await patchMeta(app, root.id, { owner: null });
		expect(cleared.statusCode).toBe(200);
		expect(cleared.json().owner).toBeUndefined();
		expect(cleared.json()).not.toHaveProperty("owner");
	});

	test("name round-trips: PATCH sets it, GET serves it, null removes it", async () => {
		const { app, opened } = await bootServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const named = await patchMeta(app, root.id, { name: "Debugging the fork" });
		expect(named.statusCode).toBe(200);
		expect(named.json().name).toBe("Debugging the fork");
		// A fresh GET (not the PATCH echo) serves the stored name.
		const served = await getMeta(app, root.id);
		expect(served.statusCode).toBe(200);
		expect(served.json().name).toBe("Debugging the fork");
		const cleared = await patchMeta(app, root.id, { name: null });
		expect(cleared.statusCode).toBe(200);
		// Cleared = ABSENT (name is optional-only, not a defaulted field).
		expect(cleared.json()).not.toHaveProperty("name");
		const after = await getMeta(app, root.id);
		expect(after.json()).toEqual(DEFAULT_BODY);
	});

	test("rejects name: 42 (400, the owner-type rule: wrong type = invalid_body)", async () => {
		const { app, opened } = await bootServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const bad = await patchMeta(app, root.id, { name: 42 });
		expect(bad.statusCode).toBe(400);
		expect(bad.json()).toEqual({ error: "invalid_body" });
		// The rejected patch never touched the doc.
		const final = await getMeta(app, root.id);
		expect(final.json()).toEqual(DEFAULT_BODY);
	});

	test("rejects source: bogus (400), unknown field (invalid_field), wrong type (invalid_body)", async () => {
		const { app, opened } = await bootServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const badSource = await patchMeta(app, root.id, { source: "bogus" });
		expect(badSource.statusCode).toBe(400);
		const unknown = await patchMeta(app, root.id, { priority: 1 });
		expect(unknown.statusCode).toBe(400);
		expect(unknown.json()).toEqual({
			error: "invalid_field",
			field: "priority",
		});
		const wrongType = await patchMeta(app, root.id, { pinned: "yes" });
		expect(wrongType.statusCode).toBe(400);
		const badTagged = await patchMeta(app, root.id, { tagged: "not-array" });
		expect(badTagged.statusCode).toBe(400);
		const badTaggedElem = await patchMeta(app, root.id, { tagged: ["a", 3] });
		expect(badTaggedElem.statusCode).toBe(400);
		const badDraft = await patchMeta(app, root.id, {
			draft: { text: 42 },
		});
		expect(badDraft.statusCode).toBe(400);
		const badDraftKey = await patchMeta(app, root.id, {
			draft: { text: "ok", italic: true },
		});
		expect(badDraftKey.statusCode).toBe(400);
		expect(badDraftKey.json()).toEqual({
			error: "invalid_field",
			field: "draft.italic",
		});
		// Nothing was applied by any rejected patch.
		const final = await getMeta(app, root.id);
		expect(final.json()).toEqual(DEFAULT_BODY);
	});

	test("rejects a non-object or empty body", async () => {
		const { app, opened } = await bootServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const notObject = await app.inject({
			method: "PATCH",
			url: `/v1/conversations/${root.id}/meta`,
			payload: [1, 2],
			headers: { "content-type": "application/json" },
		});
		expect(notObject.statusCode).toBe(400);
		const empty = await patchMeta(app, root.id, {});
		expect(empty.statusCode).toBe(400);
		expect(empty.json()).toEqual({ error: "invalid_body" });
		// An empty draft sub-object changes nothing either — same client-error
		// rule as the top-level empty body (fail-loud consistency).
		const emptyDraft = await patchMeta(app, root.id, { draft: {} });
		expect(emptyDraft.statusCode).toBe(400);
		expect(emptyDraft.json()).toEqual({ error: "invalid_body" });
	});

	test("404s for an unknown conversation id", async () => {
		const { app } = await bootServer();
		const response = await patchMeta(app, 999999, { pinned: true });
		expect(response.statusCode).toBe(404);
		expect(response.json()).toEqual({ error: "conversation_not_found" });
	});
});

// ---------------------------------------------------------------------------
// Durability: meta survives a harness reopen
// ---------------------------------------------------------------------------
describe("session-meta durability", () => {
	test("meta survives closing and reopening the harness", async () => {
		// Fully manual lifecycle (harness-open.test.ts pattern): the server
		// closes mid-test, so the shared bootServer teardown would double-close.
		const dir = await mkdtemp(join(tmpdir(), "sigrun-meta-reopen-"));
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
			SIGRUN_WORKSPACE_PATH: dir,
		});
		const first = await openHarness(config, {
			extensions: [contributor],
			env: {},
		});
		const app = await createServer(first, config);
		try {
			const root = await first.harness.root(BACKGROUND_CONTEXT, {
				agent: { model: first.defaultModel },
			});
			await patchMeta(app, root.id, {
				pinned: true,
				tagged: ["durable"],
				draft: { text: "wip", attachments: ["uploads/1/a.png"] },
				source: "cron",
				owner: "mike",
			});
			await app.close();
			await first.harness.close(BACKGROUND_CONTEXT);

			// Re-open the SAME storage path: the doc lives in storage, so the
			// meta survives restart by construction (documents are durable).
			const reopened = await openHarness(config, {
				extensions: [contributor],
				env: {},
			});
			try {
				const snapshot = await reopened.harness.snapshot(
					SessionMetaDoc,
					root.id,
					BACKGROUND_CONTEXT,
				);
				expect(snapshot).toEqual({
					pinned: true,
					tagged: ["durable"],
					archived: false,
					draft: { text: "wip", attachments: ["uploads/1/a.png"] },
					source: "cron",
					owner: "mike",
				});
			} finally {
				await reopened.harness.close(BACKGROUND_CONTEXT);
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
