/**
 * Core hardening W1 Task 5 (spec §5.9, ruling 6/10): per-resource sharing
 * and content access.
 *
 * Two halves:
 *
 * - the `accessOf` rule-order matrix (the pure shared-leaf function the
 *   server resolves every `:id` route through);
 * - the wire behavior over the token method (users bob, carol (admin),
 *   dave): hidden-is-404 on every `:id` route and absence from lists;
 *   household-read grants read but not write; people-write grants submit
 *   and interaction answers (recorded as `answeredByUser`); `sharing` on
 *   `PATCH …/meta` is owner/superuser-only (403 otherwise); `owner` in a
 *   patch is a 400 `invalid_field`; and a fork resets to private owned by
 *   the forker.
 *
 * Admin is NOT the superuser (§5.8: the superuser is the naive no-header
 * principal or a service token) — carol-admin gets the same hidden-404
 * any non-shared user gets.
 *
 * Hermetic pattern (users-api.test.ts): faux provider + tmp workspace +
 * `app.inject()`; identity pre-seeded claimed via {@link seededIdentity}.
 * The stream-status probe needs a REAL loopback socket (a hijacked SSE
 * reply never settles under light-my-request — sse-view.test.ts), so the
 * app also listens on an ephemeral port.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FastifyInstance } from "fastify";
import {
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import {
	accessOf,
	isSharing,
	type Access,
	type AccessPrincipal,
	type Sharing,
} from "@sigrun/shared/access";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import { InteractionDoc } from "../src/harness/interactions.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import type { SeamHost } from "../src/harness/seam-host.js";
import { createServer } from "../src/server/index.js";
import { SessionMetaDoc } from "../src/server/session-meta.js";
import { seededIdentity } from "./helpers/identity.js";

/** The fixture-seam entry: its seam host seeds the answered interaction. */
const SEAM_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-seam", "index.js"),
).href;

interface TestServer {
	app: FastifyInstance;
	opened: OpenedHarness;
	/** The loopback port the app listens on (the SSE probe needs a socket). */
	port: number;
}

/**
 * Boot one hermetic CLAIMED server under the token method: `tester` is the
 * seeded admin; bob (owner), carol (admin — NOT the superuser), and dave
 * are the directory users the scenarios act through.
 */
async function bootServer(): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-sharing-"));
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	faux.setResponses([fauxAssistantMessage("ok")]);
	const contributor: ProviderContributor = {
		name: "ext-faux",
		providers: [{ provider: faux.provider }],
	};
	const env = {
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
		SIGRUN_CONFIG_DIR: join(dir, "config"),
		SIGRUN_CACHE_DIR: join(dir, "cache"),
		SIGRUN_STATE_DIR: join(dir, "state"),
		SIGRUN_AUTH: "token",
	};
	const config = loadConfig(env);
	const identity = await seededIdentity(dir);
	await identity.users.add({ user: "bob", admin: false, source: "cli" });
	await identity.users.add({
		user: "carol",
		name: "Carol",
		admin: true,
		source: "cli",
	});
	await identity.users.add({ user: "dave", admin: false, source: "cli" });
	const opened = await openHarness(config, {
		extensions: [contributor],
		env,
		identity,
		extensionSpecifiers: [SEAM_SPECIFIER],
	});
	const app = await createServer(opened, config, [], {
		listenHost: "127.0.0.1",
	});
	await app.listen({ port: 0, host: "127.0.0.1" });
	const address = app.server.address();
	if (address === null || typeof address === "string") {
		throw new Error("listen did not bind a port");
	}
	const teardown = async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	};
	cleanups.push(teardown);
	return { app, opened, port: address.port };
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

/** Mint a token for `user` (the token method's credential). */
async function mint(opened: OpenedHarness, user: string): Promise<string> {
	const { token } = await opened.identity.tokens.create("test", user);
	return token;
}

/** The Bearer header set for one token. */
function auth(token: string): Record<string, string> {
	return { authorization: `Bearer ${token}` };
}

/** JSON headers + auth for a request with a body. */
function authJson(token: string): Record<string, string> {
	return { ...auth(token), "content-type": "application/json" };
}

/** The fixture-seam host (its `seedInteraction` maintains the index). */
function seamHost(opened: OpenedHarness): SeamHost {
	const host = opened.seamHosts.get("sigrun-fixture-seam");
	if (host === undefined) throw new Error("fixture-seam host not loaded");
	return host;
}

/**
 * `GET …/stream` status over a REAL socket: fetch resolves once the
 * response HEADERS arrive, so the status is observable even though the
 * SSE body never ends; the abort tears the socket down immediately.
 */
async function streamStatus(
	port: number,
	id: number,
	token: string,
): Promise<number> {
	const controller = new AbortController();
	const response = await fetch(
		`http://127.0.0.1:${port}/v1/conversations/${id}/stream`,
		{ headers: auth(token), signal: controller.signal },
	);
	const { status } = response;
	controller.abort();
	return status;
}

// ---------------------------------------------------------------------------
// accessOf: the rule-order matrix (spec §5.9)
// ---------------------------------------------------------------------------

describe("accessOf rule order", () => {
	const dave: AccessPrincipal = { user: "dave" };
	test.each<{
		name: string;
		principal: AccessPrincipal;
		resource: { owner?: string; sharing?: Sharing };
		expected: Access;
	}>([
		{
			name: "owner writes",
			principal: { user: "bob" },
			resource: { owner: "bob" },
			expected: "write",
		},
		{
			name: "ownerless is household write",
			principal: dave,
			resource: {},
			expected: "write",
		},
		{
			name: "ownerless anonymous writes",
			principal: {},
			resource: {},
			expected: "write",
		},
		{
			name: "private other is hidden",
			principal: dave,
			resource: { owner: "bob", sharing: { scope: "private" } },
			expected: "none",
		},
		{
			name: "unshared other is hidden",
			principal: dave,
			resource: { owner: "bob" },
			expected: "none",
		},
		{
			name: "household read",
			principal: dave,
			resource: { owner: "bob", sharing: { scope: "household", level: "read" } },
			expected: "read",
		},
		{
			name: "household write",
			principal: dave,
			resource: { owner: "bob", sharing: { scope: "household", level: "write" } },
			expected: "write",
		},
		{
			name: "people in the list get the level",
			principal: dave,
			resource: {
				owner: "bob",
				sharing: { scope: "people", users: ["dave"], level: "write" },
			},
			expected: "write",
		},
		{
			name: "people out of the list are hidden",
			principal: { user: "carol" },
			resource: {
				owner: "bob",
				sharing: { scope: "people", users: ["dave"], level: "write" },
			},
			expected: "none",
		},
		{
			name: "superuser writes anything",
			principal: { user: "carol", superuser: true },
			resource: { owner: "bob" },
			expected: "write",
		},
		{
			name: "user-less non-superuser gets nothing from household sharing",
			principal: {},
			resource: { owner: "bob", sharing: { scope: "household", level: "write" } },
			expected: "none",
		},
		{
			name: "user-less superuser still writes (rule 1 first)",
			principal: { superuser: true },
			resource: { owner: "bob" },
			expected: "write",
		},
	])("$name", ({ principal, resource, expected }) => {
		expect(accessOf(principal, resource)).toBe(expected);
	});

	test("isSharing validates the wire shape strictly", () => {
		expect(isSharing({ scope: "private" })).toBe(true);
		expect(isSharing({ scope: "household", level: "read" })).toBe(true);
		expect(
			isSharing({ scope: "people", users: ["dave"], level: "write" }),
		).toBe(true);
		expect(isSharing({ scope: "household", level: "admin" })).toBe(false);
		expect(isSharing({ scope: "people", users: [42], level: "read" })).toBe(
			false,
		);
		expect(isSharing({ scope: "everyone" })).toBe(false);
		expect(isSharing("household")).toBe(false);
		expect(isSharing(null)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Wire behavior (token method; bob owns, carol admin, dave shared-with)
// ---------------------------------------------------------------------------

describe("hidden is 404 and absent from lists", () => {
	test("bob's private conversation → carol-admin 404s; it is absent from carol's list", async () => {
		const { app, opened } = await bootServer();
		const bobToken = await mint(opened, "bob");
		const carolToken = await mint(opened, "carol");
		const created = await app.inject({
			method: "POST",
			url: "/v1/conversations",
			headers: auth(bobToken),
		});
		expect(created.statusCode).toBe(201);
		const id: number = created.json().id;

		// Hidden is 404 (never a 403 tell) — even for an admin: the admin
		// flag is not the superuser under the token method.
		const hidden = await app.inject({
			method: "GET",
			url: `/v1/conversations/${id}`,
			headers: auth(carolToken),
		});
		expect(hidden.statusCode).toBe(404);
		expect(hidden.json()).toEqual({ error: "conversation_not_found" });

		// Absent from carol's list; present in bob's as owner-write.
		const carolList = await app.inject({
			method: "GET",
			url: "/v1/conversations",
			headers: auth(carolToken),
		});
		expect(
			(carolList.json().conversations as { id: number }[]).some(
				(row) => row.id === id,
			),
		).toBe(false);
		const bobList = await app.inject({
			method: "GET",
			url: "/v1/conversations",
			headers: auth(bobToken),
		});
		const bobRow = (bobList.json().conversations as Record<string, unknown>[]).find(
			(row) => row.id === id,
		);
		expect(bobRow).toMatchObject({ owner: "bob", access: "write" });
	});
});

describe("household read grants read only", () => {
	test("dave reads the view and the stream but cannot submit; the list says access read", async () => {
		const { app, opened, port } = await bootServer();
		const bobToken = await mint(opened, "bob");
		const daveToken = await mint(opened, "dave");
		const created = await app.inject({
			method: "POST",
			url: "/v1/conversations",
			headers: auth(bobToken),
		});
		const id: number = created.json().id;
		const shared = await app.inject({
			method: "PATCH",
			url: `/v1/conversations/${id}/meta`,
			payload: { sharing: { scope: "household", level: "read" } },
			headers: authJson(bobToken),
		});
		expect(shared.statusCode).toBe(200);

		// Read: the transcript view and the SSE stream both serve.
		const view = await app.inject({
			method: "GET",
			url: `/v1/conversations/${id}`,
			headers: auth(daveToken),
		});
		expect(view.statusCode).toBe(200);
		expect(await streamStatus(port, id, daveToken)).toBe(200);

		// Read is not write: submissions refuse with 403 (not 404 — the
		// resource is visible to dave).
		const submit = await app.inject({
			method: "POST",
			url: `/v1/conversations/${id}/submissions`,
			payload: { input: "hello" },
			headers: authJson(daveToken),
		});
		expect(submit.statusCode).toBe(403);
		expect(submit.json()).toEqual({ error: "forbidden" });

		// The list carries the grant.
		const daveList = await app.inject({
			method: "GET",
			url: "/v1/conversations",
			headers: auth(daveToken),
		});
		const row = (daveList.json().conversations as Record<string, unknown>[]).find(
			(entry) => entry.id === id,
		);
		expect(row).toMatchObject({
			access: "read",
			sharing: { scope: "household", level: "read" },
		});
	});
});

describe("people write + answeredByUser", () => {
	test("dave submits and answers an interaction; the answer records answeredByUser", async () => {
		const { app, opened } = await bootServer();
		const bobToken = await mint(opened, "bob");
		const daveToken = await mint(opened, "dave");
		const created = await app.inject({
			method: "POST",
			url: "/v1/conversations",
			headers: auth(bobToken),
		});
		const id: number = created.json().id;
		const shared = await app.inject({
			method: "PATCH",
			url: `/v1/conversations/${id}/meta`,
			payload: {
				sharing: { scope: "people", users: ["dave"], level: "write" },
			},
			headers: authJson(bobToken),
		});
		expect(shared.statusCode).toBe(200);

		// People-write: the submit runs (202, faux provider answers).
		const submit = await app.inject({
			method: "POST",
			url: `/v1/conversations/${id}/submissions`,
			payload: { input: "hello" },
			headers: authJson(daveToken),
		});
		expect(submit.statusCode).toBe(202);

		// Seed a pending interaction through the fixture-seam host (the
		// seam keeps the pending index in the same commit).
		const host = seamHost(opened);
		await host.seedInteraction(
			id as never,
			{
				kind: "fixture.ask",
				callId: "share-call",
				status: "pending",
				createdAt: Date.now(),
			},
			BACKGROUND_CONTEXT,
		);
		const answer = await app.inject({
			method: "POST",
			url: `/v1/conversations/${id}/interactions/share-call/answer`,
			payload: { values: { decision: "allow" } },
			headers: authJson(daveToken),
		});
		expect(answer.statusCode).toBe(200);
		const record = await opened.harness.snapshot(
			InteractionDoc,
			id as never,
			"share-call",
			BACKGROUND_CONTEXT,
		);
		expect(record).toMatchObject({
			status: "answered",
			answeredBy: "human",
			answeredByUser: "dave",
		});
	});
});

describe("PATCH …/meta authority", () => {
	test("dave (shared write, not the owner) may patch name but not sharing; owner is a 400 invalid_field", async () => {
		const { app, opened } = await bootServer();
		const bobToken = await mint(opened, "bob");
		const daveToken = await mint(opened, "dave");
		const created = await app.inject({
			method: "POST",
			url: "/v1/conversations",
			headers: auth(bobToken),
		});
		const id: number = created.json().id;
		await app.inject({
			method: "PATCH",
			url: `/v1/conversations/${id}/meta`,
			payload: {
				sharing: { scope: "people", users: ["dave"], level: "write" },
			},
			headers: authJson(bobToken),
		});

		// sharing is owner/superuser-only: a shared-write caller gets 403.
		const resharing = await app.inject({
			method: "PATCH",
			url: `/v1/conversations/${id}/meta`,
			payload: { sharing: { scope: "household", level: "write" } },
			headers: authJson(daveToken),
		});
		expect(resharing.statusCode).toBe(403);
		expect(resharing.json()).toEqual({ error: "forbidden" });

		// owner is server-only: any patch carrying it is a 400 invalid_field.
		const ownerPatch = await app.inject({
			method: "PATCH",
			url: `/v1/conversations/${id}/meta`,
			payload: { owner: "dave" },
			headers: authJson(daveToken),
		});
		expect(ownerPatch.statusCode).toBe(400);
		expect(ownerPatch.json()).toEqual({
			error: "invalid_field",
			field: "owner",
		});

		// Ordinary write surface works.
		const renamed = await app.inject({
			method: "PATCH",
			url: `/v1/conversations/${id}/meta`,
			payload: { name: "x" },
			headers: authJson(daveToken),
		});
		expect(renamed.statusCode).toBe(200);
		expect(renamed.json().name).toBe("x");
	});
});

describe("fork resets to private", () => {
	test("dave's fork of a shared conversation is owned by dave and carries no sharing", async () => {
		const { app, opened } = await bootServer();
		const bobToken = await mint(opened, "bob");
		const daveToken = await mint(opened, "dave");
		const created = await app.inject({
			method: "POST",
			url: "/v1/conversations",
			headers: auth(bobToken),
		});
		const id: number = created.json().id;
		// A fork needs at least one entry — submit one first and settle it
		// (the §7.1 bounded wait).
		const submit = await app.inject({
			method: "POST",
			url: `/v1/conversations/${id}/submissions?waitMs=5000`,
			payload: { input: "seed" },
			headers: authJson(bobToken),
		});
		expect(submit.statusCode).toBe(202);
		await app.inject({
			method: "PATCH",
			url: `/v1/conversations/${id}/meta`,
			payload: { sharing: { scope: "household", level: "write" } },
			headers: authJson(bobToken),
		});

		const forked = await app.inject({
			method: "POST",
			url: `/v1/conversations/${id}/fork`,
			headers: auth(daveToken),
		});
		expect(forked.statusCode).toBe(201);
		const forkId: number = forked.json().id;

		// The copied meta doc (fork:"current") carries the source's sharing —
		// the fork route RESET it: owner = the forker, sharing gone (private).
		const meta = await opened.harness.snapshot(
			SessionMetaDoc,
			forkId as never,
			BACKGROUND_CONTEXT,
		);
		expect(meta?.owner).toBe("dave");
		expect(meta).not.toHaveProperty("sharing");

		// ...and the source's sharing is untouched.
		const sourceMeta = await opened.harness.snapshot(
			SessionMetaDoc,
			id as never,
			BACKGROUND_CONTEXT,
		);
		expect(sourceMeta?.sharing).toEqual({
			scope: "household",
			level: "write",
		});
	});
});
