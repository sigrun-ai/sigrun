/**
 * Core hardening W3 Task 5 (spec §7.5): the cross-conversation
 * interactions inbox, `GET /v1/interactions?status=pending`.
 *
 * The inbox is how "answer the agent from my phone" works without
 * opening each conversation: ONE list over every conversation the caller
 * can see, served from the session-singleton `InteractionsIndexDoc`
 * (seed/answer/expire commits maintain it — one snapshot per request,
 * no cache to invalidate), then per-conversation access filtering
 * (`accessOf` via each conversation's SessionMeta — hidden is ABSENT,
 * the list-side half of the §5.9 hidden-is-404 rule) and the pending
 * records themselves. Answers still go through the per-conversation
 * answer route.
 *
 * Hermetic pattern (sharing.test.ts): faux provider + tmp workspace +
 * `app.inject()` under the token method, users bob/dave; interactions
 * are seeded through the fixture-seam host (its seedInteraction
 * maintains the index in the same commit as the record — the same path
 * extensions take). The restart case closes the harness and reopens on
 * the SAME storage dir, pinning that the index doc is durable.
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
import { loadConfig, type SigrunConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import type { SeamHost } from "../src/harness/seam-host.js";
import { createServer } from "../src/server/index.js";
import { seededIdentity } from "./helpers/identity.js";
import { askTree } from "./helpers/trees.js";
import type { InboxInteraction } from "@sigrun/shared/views";

/** The fixture-seam entry (its host seeds interactions through the seam). */
const SEAM_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-seam", "index.js"),
).href;

interface TestServer {
	app: FastifyInstance;
	opened: OpenedHarness;
	config: SigrunConfig;
	/** The storage/workspace dir (caller-owned when passed to bootServer). */
	dir: string;
	/** Idempotent close: app + harness, plus the dir when bootServer made it. */
	close: () => Promise<void>;
}

/**
 * Boot one hermetic CLAIMED server under the token method over `dir`
 * (a fresh tmp dir when omitted — then close() removes it). Users bob
 * and dave are the directory principals; re-seeding the same dir (the
 * restart case) is idempotent.
 */
async function bootServer(dir?: string): Promise<TestServer> {
	const own = dir === undefined;
	const root = own
		? await mkdtemp(join(tmpdir(), "sigrun-inbox-"))
		: dir;
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
		SIGRUN_STORAGE_PATH: join(root, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: root,
		SIGRUN_CONFIG_DIR: join(root, "config"),
		SIGRUN_CACHE_DIR: join(root, "cache"),
		SIGRUN_STATE_DIR: join(root, "state"),
		SIGRUN_AUTH: "token",
	};
	const config = loadConfig(env);
	const identity = await seededIdentity(root);
	for (const user of ["bob", "dave"]) {
		if (identity.users.get(user) === undefined) {
			await identity.users.add({ user, admin: false, source: "cli" });
		}
	}
	const opened = await openHarness(config, {
		extensions: [contributor],
		env,
		identity,
		settingsDir: root,
		extensionSpecifiers: [SEAM_SPECIFIER],
	});
	const app = await createServer(opened, config, [], {
		listenHost: "127.0.0.1",
	});
	let closed = false;
	const close = async (): Promise<void> => {
		if (closed) return;
		closed = true;
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		if (own) await rm(root, { recursive: true, force: true });
	};
	cleanups.push(close);
	return { app, opened, config, dir: root, close };
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

/** The fixture-seam host (its `seedInteraction` maintains the index). */
function seamHost(opened: OpenedHarness): SeamHost {
	const host = opened.seamHosts.get("sigrun-fixture-seam");
	if (host === undefined) throw new Error("fixture-seam host not loaded");
	return host;
}

/** Seed one pending interaction in `conv` with a deterministic clock. */
async function seed(
	opened: OpenedHarness,
	conv: number,
	callId: string,
	createdAt: number,
): Promise<void> {
	await seamHost(opened).seedInteraction(
		conv as never,
		{
			kind: "fixture.ask",
			callId,
			status: "pending",
			createdAt,
			body: askTree(),
		},
		BACKGROUND_CONTEXT,
	);
}

/** Create a conversation as `token`'s user; returns its id. */
async function createConversation(
	app: FastifyInstance,
	token: string,
): Promise<number> {
	const created = await app.inject({
		method: "POST",
		url: "/v1/conversations",
		headers: auth(token),
	});
	expect(created.statusCode).toBe(201);
	return created.json().id as number;
}

/** The inbox list as one token sees it. */
async function inbox(
	app: FastifyInstance,
	token: string,
): Promise<InboxInteraction[]> {
	const response = await app.inject({
		method: "GET",
		url: "/v1/interactions?status=pending",
		headers: auth(token),
	});
	expect(response.statusCode).toBe(200);
	return response.json().interactions as InboxInteraction[];
}

describe("GET /v1/interactions (W3 Task 5)", () => {
	test("pending interactions across two conversations, each with its conversationId, createdAt ascending", async () => {
		const server = await bootServer();
		const bob = await mint(server.opened, "bob");
		const first = await createConversation(server.app, bob);
		const second = await createConversation(server.app, bob);
		// Seeded out of order: the response must sort ascending by createdAt.
		await seed(server.opened, first, "inbox-first", 2_000);
		await seed(server.opened, second, "inbox-second", 1_000);
		const listed = await inbox(server.app, bob);
		expect(listed.map((row) => row.callId)).toEqual([
			"inbox-second",
			"inbox-first",
		]);
		expect(listed.map((row) => row.conversationId)).toEqual([
			second,
			first,
		]);
		// The record rides as-is (envelope + body) beside the id.
		expect(listed[0]?.kind).toBe("fixture.ask");
		expect(listed[0]?.body).toEqual(askTree());
		// Absent status defaults to pending (the only indexed state).
		const bare = await server.app.inject({
			method: "GET",
			url: "/v1/interactions",
			headers: auth(bob),
		});
		expect(bare.statusCode).toBe(200);
		expect(bare.json().interactions).toHaveLength(2);
	});

	test("an answered interaction is absent (the index settles with the record)", async () => {
		const server = await bootServer();
		const bob = await mint(server.opened, "bob");
		const conv = await createConversation(server.app, bob);
		await seed(server.opened, conv, "inbox-kept", 1_000);
		await seed(server.opened, conv, "inbox-answered", 2_000);
		const applied = await seamHost(server.opened).answerInteraction(
			conv as never,
			"inbox-answered",
			{ values: { decision: "allow" } },
			BACKGROUND_CONTEXT,
		);
		expect(applied).toBe(true);
		const listed = await inbox(server.app, bob);
		expect(listed.map((row) => row.callId)).toEqual(["inbox-kept"]);
	});

	test("another user's private conversation is absent from the inbox", async () => {
		const server = await bootServer();
		const bob = await mint(server.opened, "bob");
		const dave = await mint(server.opened, "dave");
		const bobs = await createConversation(server.app, bob);
		const daves = await createConversation(server.app, dave);
		await seed(server.opened, bobs, "inbox-private", 1_000);
		await seed(server.opened, daves, "inbox-daves", 2_000);
		// Hidden is ABSENT from lists (§5.9): dave sees only his own.
		expect(
			(await inbox(server.app, dave)).map((row) => row.callId),
		).toEqual(["inbox-daves"]);
		expect(
			(await inbox(server.app, bob)).map((row) => row.callId),
		).toEqual(["inbox-private"]);
	});

	test("status other than pending → 400 invalid_field status", async () => {
		const server = await bootServer();
		const bob = await mint(server.opened, "bob");
		const response = await server.app.inject({
			method: "GET",
			url: "/v1/interactions?status=answered",
			headers: auth(bob),
		});
		expect(response.statusCode).toBe(400);
		expect(response.json()).toEqual({
			error: "invalid_field",
			field: "status",
		});
	});

	test("restart: after close + reopen on the same storage the inbox still lists the pending ones", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-inbox-restart-"));
		try {
			const first = await bootServer(dir);
			const bob = await mint(first.opened, "bob");
			const a = await createConversation(first.app, bob);
			const b = await createConversation(first.app, bob);
			await seed(first.opened, a, "restart-a", 1_000);
			await seed(first.opened, b, "restart-b", 2_000);
			expect((await inbox(first.app, bob)).map((r) => r.callId)).toEqual([
				"restart-a",
				"restart-b",
			]);
			// Close EVERYTHING over this storage, then boot a fresh server
			// on it — the InteractionsIndexDoc must have survived.
			await first.close();
			const second = await bootServer(dir);
			const bobAgain = await mint(second.opened, "bob");
			const relisted = await inbox(second.app, bobAgain);
			expect(relisted.map((row) => row.callId)).toEqual([
				"restart-a",
				"restart-b",
			]);
			expect(relisted.map((row) => row.conversationId)).toEqual([a, b]);
			await second.close();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
