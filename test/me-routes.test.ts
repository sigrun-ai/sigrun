/**
 * Multi-user M2 Task 2: the self-only /v1/me extension stores API.
 *
 * Real token principals drive the real server. Alice, bob, and the
 * seeded admin have separate files; the response-body sweep proves a
 * written secret VALUE never comes back through any route in this suite.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import { createServer } from "../src/server/index.js";
import { seededIdentity } from "./helpers/identity.js";

const FIXTURE = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-stores", "index.js"),
).href;
const SLUG = "acme-tool";
const ALICE_SECRET = "alice-secret-value-never-on-the-wire";
const bodies: string[] = [];

let app: FastifyInstance;
let opened: OpenedHarness;
let dir: string;
let aliceToken: string;
let bobToken: string;
let adminToken: string;

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "sigrun-me-routes-"));
	const env = {
		SIGRUN_DEFAULT_MODEL: "openai/gpt-test",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
		SIGRUN_CONFIG_DIR: join(dir, "config"),
		SIGRUN_DATA_DIR: join(dir, "data"),
		SIGRUN_CACHE_DIR: join(dir, "cache"),
		SIGRUN_STATE_DIR: join(dir, "state"),
		SIGRUN_AUTH: "token",
		SIGRUN_API_TOKEN: "service-token-for-userless-route-test",
		SIGRUN_WEBUI: "false",
	};
	const config = loadConfig(env);
	const identity = await seededIdentity(join(dir, "seed"));
	await identity.users.add({ user: "alice", admin: false, source: "cli" });
	await identity.users.add({ user: "bob", admin: false, source: "cli" });
	opened = await openHarness(config, {
		identity,
		env,
		builtins: false,
		extensionSpecifiers: [FIXTURE],
		isolationProbe: async () => ({ available: true, abi: 6 }),
	});
	aliceToken = (await opened.identity.tokens.create("alice-test", "alice")).token;
	bobToken = (await opened.identity.tokens.create("bob-test", "bob")).token;
	adminToken = (await opened.identity.tokens.create("tester-test", "tester")).token;
	app = await createServer(opened, config, [], { listenHost: "0.0.0.0" });
});

afterAll(async () => {
	await app.close();
	await opened.harness.close(BACKGROUND_CONTEXT);
	await rm(dir, { recursive: true, force: true });
});

async function call(options: {
	method: "GET" | "PUT" | "DELETE";
	url: string;
	token?: string;
	payload?: unknown;
}): Promise<{ status: number; body: string; json: () => any }> {
	const response = await app.inject({
		method: options.method,
		url: options.url,
		headers: {
			...(options.token === undefined
				? {}
				: { authorization: `Bearer ${options.token}` }),
			...(options.payload === undefined
				? {}
				: { "content-type": "application/json" }),
		},
		...(options.payload === undefined ? {} : { payload: options.payload as any }),
	});
	bodies.push(response.body);
	return {
		status: response.statusCode,
		body: response.body,
		json: () => response.json(),
	};
}

describe("/v1/me extension settings", () => {
	test("PUT then GET round-trips the caller's settings", async () => {
		const put = await call({
			method: "PUT",
			url: `/v1/me/extensions/${SLUG}/settings`,
			token: aliceToken,
			payload: { theme: "dark", nested: { retries: 2 } },
		});
		expect(put.status).toBe(200);
		expect(put.json()).toEqual({
			settings: { theme: "dark", nested: { retries: 2 } },
			pendingRestart: [],
		});
		const get = await call({
			method: "GET",
			url: `/v1/me/extensions/${SLUG}/settings`,
			token: aliceToken,
		});
		expect(get.status).toBe(200);
		expect(get.json()).toEqual(put.json());
	});
});

describe("/v1/me extension secrets", () => {
	test("bob's key listing never shows alice's keys; PUT/DELETE return 204", async () => {
		expect((await call({
			method: "PUT",
			url: `/v1/me/extensions/${SLUG}/secrets/alice-only`,
			token: aliceToken,
			payload: { value: ALICE_SECRET },
		})).status).toBe(204);
		expect((await call({
			method: "PUT",
			url: `/v1/me/extensions/${SLUG}/secrets/bob-only`,
			token: bobToken,
			payload: { value: "bob-secret-value-never-on-the-wire" },
		})).status).toBe(204);

		const alice = await call({
			method: "GET",
			url: `/v1/me/extensions/${SLUG}/secrets`,
			token: aliceToken,
		});
		expect(alice.status).toBe(200);
		expect(alice.json()).toEqual({ keys: ["alice-only"] });
		const bob = await call({
			method: "GET",
			url: `/v1/me/extensions/${SLUG}/secrets`,
			token: bobToken,
		});
		expect(bob.status).toBe(200);
		expect(bob.json()).toEqual({ keys: ["bob-only"] });
		expect(bob.body).not.toContain("alice-only");

		const deleted = await call({
			method: "DELETE",
			url: `/v1/me/extensions/${SLUG}/secrets/bob-only`,
			token: bobToken,
		});
		expect(deleted.status).toBe(204);
		expect(deleted.body).toBe("");
		expect((await call({
			method: "GET",
			url: `/v1/me/extensions/${SLUG}/secrets`,
			token: bobToken,
		})).json()).toEqual({ keys: [] });
	});

	test("an admin cannot select or reach alice's stores through any route", async () => {
		// No cross-user route or selector exists. An attempted ?user=alice
		// override is ignored: the admin sees their OWN empty stores, never
		// alice's. Once the admin has their own values, ?user=alice remains
		// pinned to the admin, so the self surface itself stays usable.
		for (const route of [
			{ method: "GET" as const, url: `/v1/me/extensions/${SLUG}/settings?user=alice` },
			{ method: "GET" as const, url: `/v1/me/extensions/${SLUG}/secrets?user=alice` },
		]) {
			const response = await call({ ...route, token: adminToken });
			expect(response.status, `${route.method} ${route.url}`).toBe(200);
			expect(response.body).not.toContain("alice-only");
			expect(response.body).not.toContain("dark");
		}
		const put = await call({
			method: "PUT",
			url: `/v1/me/extensions/${SLUG}/settings?user=alice`,
			token: adminToken,
			payload: { owner: "admin-own-store" },
		});
		expect(put.status).toBe(200);
		expect((await call({
			method: "GET",
			url: `/v1/me/extensions/${SLUG}/settings?user=alice`,
			token: adminToken,
		})).json()).toEqual({
			settings: { owner: "admin-own-store" },
			pendingRestart: [],
		});
		// The other-user attempts did not mutate alice's settings/secrets.
		expect((await call({
			method: "GET",
			url: `/v1/me/extensions/${SLUG}/secrets`,
			token: aliceToken,
		})).json()).toEqual({ keys: ["alice-only"] });
		expect((await call({
			method: "GET",
			url: `/v1/me/extensions/${SLUG}/settings`,
			token: aliceToken,
		})).json()).toEqual({
			settings: { theme: "dark", nested: { retries: 2 } },
			pendingRestart: [],
		});
	});

	test("unknown slugs are 404; a principal without a directory user is 400", async () => {
		for (const method of ["GET", "PUT"] as const) {
			expect((await call({
				method,
				url: "/v1/me/extensions/ghost/settings",
				token: aliceToken,
				...(method === "PUT" ? { payload: {} } : {}),
			})).status).toBe(404);
		}
		expect((await call({
			method: "GET",
			url: "/v1/me/extensions/ghost/secrets",
			token: aliceToken,
		})).status).toBe(404);
		const service = await call({
			method: "GET",
			url: `/v1/me/extensions/${SLUG}/secrets`,
			token: "service-token-for-userless-route-test",
		});
		expect(service.status).toBe(400);
		expect(service.json()).toEqual({ error: "named_user_required" });
	});
});

test("no route response ever contains a secret value", () => {
	for (const secret of [ALICE_SECRET, "bob-secret-value-never-on-the-wire"]) {
		for (const body of bodies) expect(body).not.toContain(secret);
	}
});
