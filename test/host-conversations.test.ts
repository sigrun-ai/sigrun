/**
 * Host conversation/identity/users/access APIs (core hardening W5
 * Task 5, spec §9.5/§9.7): the seam host's `conversations` / `users` /
 * `access` / `identity` surfaces over the server-provided host bridge —
 * the SAME code paths the HTTP routes run (src/server/conversation-ops.ts):
 * content-part resolution, the served-model check, and activity stamping
 * are identical by construction.
 *
 * Fixture: `fixture-channel` (slug `fixture-channel`) — a channel-bridge
 * factory that stashes the host on globalThis and exports `drive()`
 * (create owned by "alice" + submit "hello"). Boot is the
 * extension-commands pattern (token method, claimed directory, alice +
 * tester tokens) plus the faux provider (the server-submissions pattern)
 * so host submits really run and answer.
 *
 * Review Focus 5 (the plan): `create({owner: "unmapped-user"})` stamps
 * the given string as owner and neither create nor submit verifies
 * against the directory — extensions own their user mapping. Pinned as
 * "does not throw" (and the stamped owner is readable back through
 * `meta`).
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FastifyInstance } from "fastify";
import {
	fauxAssistantMessage,
	fauxProvider,
	type FauxProviderHandle,
} from "@earendil-works/pi-ai/providers/faux";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { loadConfig, type SigrunConfig } from "../src/config.js";
import type { SigrunHost } from "../src/extension.js";
import type { ConversationId } from "@earendil-works/pi-durable";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { SeamHost } from "../src/harness/seam-host.js";
import { createServer } from "../src/server/index.js";
import { seededIdentity } from "./helpers/identity.js";

const CHANNEL_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-channel", "index.js"),
).href;

/** The fixture's channel drive (create owned by "alice" + submit "hello"). */
async function drive(): Promise<ConversationId> {
	const fn = (globalThis as { __fixtureChannelDrive?: () => Promise<number> })
		.__fixtureChannelDrive;
	if (fn === undefined) throw new Error("fixture-channel drive not captured");
	return (await fn()) as ConversationId;
}

/** One hermetic boot: opened harness (+ fixture loaded) before the server. */
interface OpenedBoot {
	readonly opened: OpenedHarness;
	readonly config: SigrunConfig;
	/** The faux provider handle (append responses per test). */
	readonly faux: FauxProviderHandle;
	readonly dir: string;
}

/** An opened boot plus its server + the two user tokens. */
interface TestServer extends OpenedBoot {
	readonly app: FastifyInstance;
	readonly aliceToken: string;
	readonly testerToken: string;
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

/**
 * Boot the opened harness WITHOUT the server (the early-probe test needs
 * the gap between `openHarness` and `createServer`). The faux queue
 * starts with one answer; auto-naming is off (exact-response scripts,
 * the server-submissions pattern).
 */
async function bootOpened(
	env: Record<string, string> = {},
): Promise<OpenedBoot> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-host-conv-"));
	const configDir = join(dir, "config");
	const faux = fauxProvider({
		provider: "faux",
		// TWO models so host configure can switch (the server-configure
		// pattern — the HTTP twin's tests pin model m → m2).
		models: [
			{ id: "m", contextWindow: 128_000 },
			{ id: "m2", contextWindow: 128_000 },
		],
	});
	faux.setResponses([fauxAssistantMessage("channel answer")]);
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_AUTH: "token",
		SIGRUN_WORKSPACE_PATH: dir,
		SIGRUN_CONFIG_DIR: configDir,
		...env,
	});
	await writeFile(join(dir, "settings.json"), '{"namingModel": false}');
	const identity = await seededIdentity(dir);
	await identity.users.add({ user: "alice", admin: false, source: "cli" });
	const opened = await openHarness(config, {
		identity,
		// The faux provider CONTRIBUTOR (the file header's stated pattern —
		// without it the boot registers the env-degenerate OpenAI-compat
		// provider under "faux" and every run settles model_error with only
		// an aborted-partial assistant entry).
		extensions: [{ name: "ext-faux", providers: [{ provider: faux.provider }] }],
		extensionSpecifiers: [CHANNEL_SPECIFIER],
		env: { SIGRUN_CONFIG_DIR: configDir },
		settingsDir: dir,
	});
	cleanups.push(async () => {
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	});
	return { opened, config, faux, dir };
}

/** Boot opened + server + tokens (the common shape). */
async function bootServer(
	env: Record<string, string> = {},
): Promise<TestServer> {
	const boot = await bootOpened(env);
	const { opened } = boot;
	const { token: aliceToken } = await opened.identity.tokens.create(
		"alice-cli",
		"alice",
	);
	const { token: testerToken } = await opened.identity.tokens.create(
		"tester-cli",
		"tester",
	);
	const app = await createServer(opened, boot.config);
	cleanups.push(async () => {
		await app.close();
	});
	return { ...boot, app, aliceToken, testerToken };
}

/** The fixture-channel seam host (the extension-facing surface under test). */
function channelHost(opened: OpenedHarness): SeamHost & SigrunHost {
	const host = opened.seamHosts.get("fixture-channel");
	if (host === undefined) throw new Error("fixture-channel host not loaded");
	return host as SeamHost & SigrunHost;
}

/** One authenticated GET; returns the parsed body. */
async function getJson(
	app: FastifyInstance,
	url: string,
	token: string,
): Promise<unknown> {
	const response = await app.inject({
		method: "GET",
		url,
		headers: { authorization: `Bearer ${token}` },
	});
	expect(response.statusCode).toBe(200);
	return response.json();
}

/** Poll the conversation view until an assistant entry lands (or fail). */
async function waitForAssistant(
	app: FastifyInstance,
	token: string,
	id: number,
): Promise<Record<string, unknown>> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		const view = (await getJson(
			app,
			`/v1/conversations/${id}`,
			token,
		)) as {
			entries: readonly { kind: string }[];
		};
		const answer = view.entries.find((entry) => entry.kind === "pi.assistant");
		if (answer !== undefined) return answer as Record<string, unknown>;
		if (Date.now() > deadline) {
			throw new Error(`no pi.assistant entry in conversation ${id} yet`);
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

/** The current record of one submission id (the abort test's poll). */
async function submissionOf(
	opened: OpenedHarness,
	id: number,
): Promise<{ status: string; reason?: string }> {
	const submission = await opened.harness.submission(
		id as never,
		BACKGROUND_CONTEXT,
	);
	if (submission === undefined) throw new Error(`submission ${id} not found`);
	return await submission.status(BACKGROUND_CONTEXT);
}

/** Whether the conversation has a live run (the placement poll). */
async function agentLive(
	opened: OpenedHarness,
	id: ConversationId,
): Promise<unknown> {
	const conversation = await opened.harness.conversation(
		id,
		BACKGROUND_CONTEXT,
	);
	if (conversation === undefined) {
		throw new Error(`conversation ${id} not found`);
	}
	const view = await conversation.viewState(BACKGROUND_CONTEXT);
	return view.value.docs["pi.live"];
}

describe("host.conversations over the shared conversation ops", () => {
	test("drive() creates + submits; the list shows owner + source; the transcript has the turn", { timeout: 30_000 }, async () => {
		const { app, aliceToken } = await bootServer();
		const id = await drive();
		expect(typeof id).toBe("number");
		// GET /v1/conversations as alice: the driven row carries the stamped
		// owner and the source (the extension slug — the §9.5 default).
		const listed = (await getJson(app, "/v1/conversations", aliceToken)) as {
			conversations: readonly {
				id: number;
				owner?: string;
				source?: string;
			}[];
		};
		const row = listed.conversations.find(
			(conversation) => conversation.id === id,
		);
		expect(row).toBeDefined();
		expect(row?.owner).toBe("alice");
		expect(row?.source).toBe("fixture-channel");
		// The transcript: the user entry "hello" plus the faux answer (the
		// same submit path as the HTTP route — a real run happened).
		const answer = await waitForAssistant(app, aliceToken, id);
		expect(answer).toBeDefined();
		const view = (await getJson(app, `/v1/conversations/${id}`, aliceToken)) as {
			entries: readonly {
				id: number;
				kind: string;
				model?: readonly {
					content: string | readonly { type: string; text?: string }[];
				}[];
			}[];
		};
		const user = view.entries.find((entry) => entry.kind === "pi.user");
		expect(user?.model?.[0]?.content).toEqual([{ type: "text", text: "hello" }]);
	});

	test("watch delivers the acquisition snapshot and later frames; stop() resolves", { timeout: 30_000 }, async () => {
		const { opened, faux } = await bootServer();
		const host = channelHost(opened);
		const id = await drive();
		const frames: { conversation: { id: number }; entries: unknown[] }[] = [];
		const stop = await host.conversations.watch(id, (view) => {
			frames.push(
				view as unknown as { conversation: { id: number }; entries: unknown[] },
			);
		});
		// The acquisition frame is the first listener call (snapshot-first,
		// the SSE stream's shape).
		expect(frames.length).toBeGreaterThanOrEqual(1);
		expect(frames[0]?.conversation.id).toBe(id);
		// A later submit produces a new frame (the assistant entry lands).
		faux.appendResponses([fauxAssistantMessage("watch answer")]);
		await host.conversations.submit(id, [{ type: "text", text: "watch turn" }]);
		const deadline = Date.now() + 10_000;
		while (
			!frames.some((frame) =>
				frame.entries.some(
					(entry) => (entry as { kind?: string }).kind === "pi.assistant",
				),
			)
		) {
			if (Date.now() > deadline) throw new Error("no watch frame arrived");
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		await stop();
	});
});

describe("host identity, users, and access (spec §9.7)", () => {
	test("actingUser reads the owner; accessOf resolves; users.list serves the directory", async () => {
		const { opened } = await bootServer();
		const host = channelHost(opened);
		const id = await drive();
		expect(await host.identity.actingUser(id)).toBe("alice");
		expect(
			await host.access.accessOf({ user: "bob" }, { owner: "alice" }),
		).toBe("none");
		const users = await host.users.list();
		expect(users.some((user) => user.user === "alice")).toBe(true);
		const alice = await host.users.get("alice");
		expect(alice?.user).toBe("alice");
		expect(await host.users.get("nosuch")).toBeUndefined();
	});

	test("a Principal input maps admin/service to superuser semantics like the server does", async () => {
		const { opened } = await bootServer();
		const host = channelHost(opened);
		// The anonymous naive principal is the loopback superuser; an
		// authenticated non-admin is not.
		expect(
			await host.access.accessOf(
				{
					user: undefined,
					admin: false,
					service: false,
					method: "none",
				},
				{ owner: "alice" },
			),
		).toBe("write");
		expect(
			await host.access.accessOf(
				{
					user: "bob",
					admin: false,
					service: false,
					method: "token",
				},
				{ owner: "alice" },
			),
		).toBe("none");
	});
});

describe("unmapped users (Review Focus 5: extensions own their user mapping)", () => {
	test("create({owner}) and submit({user}) with a user NOT in the directory do not throw; the owner stamps verbatim", { timeout: 30_000 }, async () => {
		const { opened } = await bootServer();
		const host = channelHost(opened);
		const id = await host.conversations.create({ owner: "unmapped-user" });
		expect(typeof id).toBe("number");
		const record = await host.conversations.submit(
			id,
			[{ type: "text", text: "from an unmapped channel user" }],
			{ user: "unmapped-user" },
		);
		expect(record.conversationId).toBe(id);
		expect(["queued", "placed", "done"]).toContain(record.status);
		// The given string stamps as owner — no verification, no rewriting.
		const meta = await host.conversations.meta(id);
		expect(meta.owner).toBe("unmapped-user");
	});
});

describe("host conversation ops (gateway C4a — the HTTP twins in-process)", () => {
	/** A gated faux response: the run cannot settle until `release()`. */
	function gatedResponse(): {
		readonly step: () => Promise<AssistantMessage>;
		readonly release: () => void;
	} {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		return {
			step: async () => {
				await gate;
				return fauxAssistantMessage("gated answer");
		},
			release: () => release(),
		};
	}

	/** Resolve a conversation's agent through the opened harness. */
	async function agentOf(
		opened: OpenedHarness,
		id: ConversationId,
	): Promise<{ model?: { provider: string; modelId: string }; thinkingLevel: string; tools: readonly { name: string }[] }> {
		const conversation = await opened.harness.conversation(id, BACKGROUND_CONTEXT);
		if (conversation === undefined) throw new Error(`conversation ${id} not found`);
		return await conversation.agent(BACKGROUND_CONTEXT);
	}

	/** Read the resolved agent the way the HTTP surface does (the settings/agent projection is server-side — the harness read is the observable). */
	async function waitFor(
		predicate: () => Promise<boolean>,
		what: string,
	): Promise<void> {
		const deadline = Date.now() + 10_000;
		while (!(await predicate())) {
			if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}

	test("configure applies model+thinking; the agent read shows the same values as the HTTP twin", { timeout: 30_000 }, async () => {
		const { opened } = await bootServer();
		const host = channelHost(opened);
		const id = await host.conversations.create({ owner: "alice" });
		await host.conversations.configure(id, {
			model: "faux/m2",
			thinking: "high",
		});
		const agent = await agentOf(opened, id);
		expect(agent.model).toEqual({ provider: "faux", modelId: "m2" });
		expect(agent.thinkingLevel).toBe("high");
	});

	test("abort during a faux run settles it; abort on an idle conversation resolves (no throw)", { timeout: 30_000 }, async () => {
		const { opened, faux } = await bootServer();
		const host = channelHost(opened);
		const id = await host.conversations.create({ owner: "alice" });
		const gate = gatedResponse();
		faux.setResponses([gate.step]);
		const record = await host.conversations.submit(id, [
			{ type: "text", text: "held open" },
		]);
		await waitFor(
			async () => (await agentLive(opened, id)) !== undefined,
			"the run to place",
		);
		expect(["placed", "queued"]).toContain(record.status);
		// Abort while the run is live: the host call resolves (void) and the
		// submission settles — never a hang, never a throw.
		await host.conversations.abort(id);
		const conversation = await opened.harness.conversation(id, BACKGROUND_CONTEXT);
		if (conversation === undefined) throw new Error("conversation vanished");
		const submission = await opened.harness.submission(
			record.id as never,
			BACKGROUND_CONTEXT,
		);
		if (submission === undefined) throw new Error("submission handle lost");
		gate.release();
		const settled = await submission.wait(BACKGROUND_CONTEXT);
		expect(["done", "unanswered"]).toContain(settled.status);
		// An idle conversation: abort RESOLVES (chat /stop on an idle chat is
		// not an error — the plan's ruling).
		await expect(host.conversations.abort(id)).resolves.toBeUndefined();
	});

	test("compact creates the manual compaction task (pi.live.compactions / the task record)", { timeout: 60_000 }, async () => {
		// Forced keep-window (the compaction-test pattern): with the default
		// keepRecentTokens this tiny transcript has nothing to compact, and
		// the manual compaction completes without placing a summary — the
		// test would never see its entry. keepRecentTokens: 1 makes the cut
		// fall right before the newest entry; background off keeps the faux
		// queue deterministic.
		const { opened, faux } = await bootServer({
			SIGRUN_COMPACTION_KEEP_RECENT_TOKENS: "1",
			SIGRUN_COMPACTION_BACKGROUND_TOKENS: "0",
		});
		const host = channelHost(opened);
		const id = await host.conversations.create({ owner: "alice" });
		faux.appendResponses([fauxAssistantMessage("turn one answer")]);
		const first = await host.conversations.submit(id, [
			{ type: "text", text: `hello ${"filler ".repeat(200)}` },
		]);
		expect(["queued", "placed"]).toContain(first.status);
		await waitFor(
			async () => (await submissionOf(opened, first.id)).status === "done",
			"the first turn to settle",
		);
		await host.conversations.compact(id);
		// The manual compaction task exists: a pi.compaction entry lands once
		// the conversation idles (the compaction.test.ts observable, adapted to
		// the host boot — no forced thresholds here, so poll for the entry).
		await waitFor(
			async () => {
				const conversation = await opened.harness.conversation(id, BACKGROUND_CONTEXT);
				if (conversation === undefined) throw new Error("conversation vanished");
				const page = await conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
				return page.items.some((entry) => entry.kind === "pi.compaction");
			},
			"the manual compaction entry",
		);
	},
	);

	test("fork returns a new id whose meta is \"<source> (fork)\" and owner honors opts.owner", { timeout: 30_000 }, async () => {
		const { opened, faux } = await bootServer();
		const host = channelHost(opened);
		const id = await host.conversations.create({ owner: "alice", name: "Alpha" });
		faux.appendResponses([fauxAssistantMessage("fork source answer")]);
		const record = await host.conversations.submit(id, [
			{ type: "text", text: "hello" },
		]);
		await waitFor(
			async () => (await submissionOf(opened, record.id)).status === "done",
			"the source turn to settle",
		);
		const forkId = await host.conversations.fork(id, { owner: "tester" });
		expect(forkId).not.toBe(id);
		const meta = await host.conversations.meta(forkId);
		expect(meta.autoName).toBe("Alpha (fork)");
		expect(meta.owner).toBe("tester");
		expect("name" in meta).toBe(false);
		// Fork with NO owner: the copied owner key is removed (the same reset
		// the header-less HTTP caller gets).
		const bare = await host.conversations.fork(id);
		const bareMeta = await host.conversations.meta(bare);
		expect("owner" in bareMeta).toBe(false);
	});

	test("patchMeta applies name+archived and meta reads both back; sharing from the host needs no principal (Review Focus 5)", { timeout: 30_000 }, async () => {
		const { opened, app, aliceToken, testerToken } = await bootServer();
		const host = channelHost(opened);
		const id = await host.conversations.create({ owner: "alice" });
		const patched = await host.conversations.patchMeta(id, {
			name: "x",
			archived: true,
		});
		expect(patched.name).toBe("x");
		expect(patched.archived).toBe(true);
		const meta = await host.conversations.meta(id);
		expect(meta.name).toBe("x");
		expect(meta.archived).toBe(true);
		// Sharing from the HOST (trusted, no principal): succeeds.
		const shared = await host.conversations.patchMeta(id, {
			sharing: { scope: "people", users: ["tester"], level: "write" },
		});
		expect(shared.sharing).toEqual({
			scope: "people",
			users: ["tester"],
			level: "write",
		});
		// The SAME body over HTTP as tester (a non-owner sharee): 403.
		const response = await app.inject({
			method: "PATCH",
			url: `/v1/conversations/${id}/meta`,
			payload: {
				sharing: { scope: "people", users: ["alice"], level: "write" },
			},
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${testerToken}`,
			},
		});
		expect(response.statusCode).toBe(403);
		expect(response.json()).toEqual({ error: "forbidden" });
		// Sanity: the HTTP route still works for the owner (the same op).
		const ownerPatch = await app.inject({
			method: "PATCH",
			url: `/v1/conversations/${id}/meta`,
			payload: { name: "renamed by owner" },
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${aliceToken}`,
			},
		});
		expect(ownerPatch.statusCode).toBe(200);
		expect((ownerPatch.json() as { name?: string }).name).toBe("renamed by owner");
	});

	test("create with agent.tools pins the offered tools; unknown names throw invalid_field", { timeout: 30_000 }, async () => {
		const { opened } = await bootServer();
		const host = channelHost(opened);
		const id = await host.conversations.create({
			owner: "alice",
			agent: { tools: ["read"] },
		});
		const agent = await agentOf(opened, id);
		expect(agent.tools.map((tool) => tool.name)).toEqual(["read"]);
		// An empty tools array: zero enabled tools (the array form selects
		// exactly its names — none).
		const empty = await host.conversations.create({
			owner: "alice",
			agent: { tools: [] },
		});
		const emptyAgent = await agentOf(opened, empty);
		expect(emptyAgent.tools).toEqual([]);
		// An unknown tool name: fail-loud invalid_field agent.tools.
		await expect(
			host.conversations.create({ owner: "alice", agent: { tools: ["nope"] } }),
		).rejects.toMatchObject({
			name: "ConversationOpError",
			body: { error: "invalid_field", field: "agent.tools" },
		});
	});

	test("Review Focus 2: every op on an unknown id throws conversation <id> not found", { timeout: 30_000 }, async () => {
		const { opened } = await bootServer();
		const host = channelHost(opened);
		const id = 999999 as ConversationId;
		await expect(host.conversations.abort(id)).rejects.toThrow(
			"conversation 999999 not found",
		);
		await expect(
			host.conversations.configure(id, { thinking: "high" }),
		).rejects.toThrow("conversation 999999 not found");
		await expect(host.conversations.compact(id)).rejects.toThrow(
			"conversation 999999 not found",
		);
		await expect(
			host.conversations.fork(id, { owner: "alice" }),
		).rejects.toThrow("conversation 999999 not found");
		await expect(
			host.conversations.patchMeta(id, { name: "x" }),
		).rejects.toThrow("conversation 999999 not found");
	});
});

describe("the seam binding contract (calls before the bridge binds)", () => {
	test("a host.conversations call made in the factory body does not resolve before boot completes — and settles once the server exists", { timeout: 30_000 }, async () => {
		const boot = await bootOpened();
		// Boot has resolved (openHarness returned); the server does not
		// exist yet, so the factory-body call is still pending — never an
		// early resolution and never a silent drop.
		const probe = (
			globalThis as {
				__fixtureChannelEarly?: { settled: boolean; promise: Promise<unknown> };
			}
		).__fixtureChannelEarly;
		expect(probe).toBeDefined();
		expect(probe?.settled).toBe(false);
		// Creating the server binds the host bridge; the waiting call then
		// runs and settles (no deadlock, no lost call).
		const app = await createServer(boot.opened, boot.config);
		cleanups.push(async () => {
			await app.close();
		});
		await probe?.promise;
		expect(probe?.settled).toBe(true);
	});
});
