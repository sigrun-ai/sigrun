/**
 * Task 3 (TUI plan): durable conversation enumeration.
 *
 * `GET /v1/conversations` lists ALL durable conversations from storage —
 * the scan is authoritative (spec §5 / Review Focus 5), not the in-memory
 * tracked set the current process created:
 *
 *  - the restart case: a conversation created on a FIRST server still
 *    lists on a SECOND server booted against the same storage file (the
 *    tracked set forgot it — the durable scan cannot);
 *  - the cron case: a conversation created through the harness directly
 *    (no route) lists too;
 *  - the identity seam rides along: `owner` appears on a summary when the
 *    conversation's session-meta doc carries one (Task 2's stamp).
 *
 * Hermetic pattern: faux provider + tmp workspace + `app.inject()` (see
 * auth-hook.test.ts). The restart case tears the first server down
 * COMPLETELY (app.close + harness.close) before the second boot — one
 * process owns the sqlite file.
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
	/** Tears the server down COMPLETELY (restart case: frees the db file). */
	close: () => Promise<void>;
}

/** Boot a hermetic harness + server over one storage file; no cleanup hook —
 * the caller owns the lifetime (the restart test closes mid-test, then boots
 * again over the SAME file). */
async function bootServer(storagePath: string): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-enum-"));
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	faux.setResponses([fauxAssistantMessage("ok")]);
	const contributor: ProviderContributor = {
		name: "ext-faux",
		providers: [{ provider: faux.provider }],
	};
	const config0 = loadConfig({
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: storagePath,
		SIGRUN_AUTH: "none",
		SIGRUN_WORKSPACE_PATH: dir,
	});
	// API-only shape (server.test.ts's hermetic override): the gate OFF,
	// never depending on whether the repo's webui/dist happens to be built.
	const config = {
		...config0,
		webui: { ...config0.webui, enabled: false },
	};
	const opened = await openHarness(config, {
		identity: await seededIdentity(dir),
		extensions: [contributor],
		env: {},
	});
	const app = await createServer(opened, config);
	const close = async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	};
	return { app, opened, close };
}

/** One shared storage file for the restart scenario (closed servers free it). */
const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

/** Create one conversation via the API; returns its id. */
async function createViaRoute(
	app: FastifyInstance,
	user?: string,
): Promise<number> {
	const response = await app.inject({
		method: "POST",
		url: "/v1/conversations",
		headers: user === undefined ? {} : { "x-sigrun-user": user },
	});
	expect(response.statusCode).toBe(201);
	return response.json().id;
}

/** The listing's conversations array. */
async function listConversations(app: FastifyInstance) {
	const response = await app.inject({ method: "GET", url: "/v1/conversations" });
	expect(response.statusCode).toBe(200);
	return response.json().conversations as {
		id: number;
		root: boolean;
		entryCount: number;
		owner?: string;
	}[];
}

// ---------------------------------------------------------------------------
// The restart case (Review Focus 5)
// ---------------------------------------------------------------------------

describe("GET /v1/conversations across a restart", () => {
	test("a first server's conversations list on a second server (same storage)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-enum-restart-"));
		const storagePath = join(dir, "sigrun.db");
		try {
			const first = await bootServer(storagePath);
			const created = await createViaRoute(first.app, "alice");
			// Tear the first server down COMPLETELY: the restart case is a
			// fresh process state, not a second app over one harness.
			await first.close();
			const second = await bootServer(storagePath);
			try {
				const conversations = await listConversations(second.app);
				const ids = conversations.map((c) => c.id);
				expect(ids).toContain(created);
				// The summary fields survive the restart: root flag, entry
				// count, and the stamped owner (Task 2's doc is durable).
				const summary = conversations.find((c) => c.id === created);
				expect(summary).toBeDefined();
				expect(summary!.root).toBe(false);
				expect(typeof summary!.entryCount).toBe("number");
				expect(summary!.owner).toBe("alice");
			} finally {
				await second.close();
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// The cron case: conversations the route never created
// ---------------------------------------------------------------------------

describe("GET /v1/conversations × harness-created conversations", () => {
	test("a conversation created through the harness directly lists (cron case)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-enum-cron-"));
		const { app, opened, close } = await bootServer(join(dir, "sigrun.db"));
		cleanups.push(close);
		const cronConversation = await opened.harness.createConversation(
			{ ownership: { kind: "ownerless" } },
			BACKGROUND_CONTEXT,
		);
		const conversations = await listConversations(app);
		const ids = conversations.map((c) => c.id);
		expect(ids).toContain(cronConversation.id);
		// No session-meta doc was ever written for it: no owner key.
		const summary = conversations.find((c) => c.id === cronConversation.id);
		expect(summary).toBeDefined();
		expect("owner" in summary!).toBe(false);
	});

	test("summaries keep id/root/entryCount for every durable conversation", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-enum-shape-"));
		const { app, opened, close } = await bootServer(join(dir, "sigrun.db"));
		cleanups.push(close);
		await createViaRoute(app);
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const conversations = await listConversations(app);
		expect(conversations.length).toBeGreaterThanOrEqual(2);
		// Ascending id order (scan order), root flagged exactly once.
		const ids = conversations.map((c) => c.id);
		expect(ids).toEqual([...ids].sort((a, b) => a - b));
		const roots = conversations.filter((c) => c.root);
		expect(roots.map((c) => c.id)).toEqual([root.id]);
		for (const conversation of conversations) {
			expect(typeof conversation.id).toBe("number");
			expect(typeof conversation.entryCount).toBe("number");
		}
	});
});
