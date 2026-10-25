/**
 * Multi-user M2 Task 3: per-user tools.
 *
 * Selection is convenience; the execute-time wrapper is the boundary. The
 * tests therefore drive the real registry, durable Agent/SessionMeta docs,
 * shared conversation ops, and the HTTP/host configure paths.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	AgentDoc,
	createRegistry,
	defineTool,
	type Conversation,
	type ConversationId,
	type Extension,
	type ToolExecutionApi,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import { afterAll, describe, expect, test, vi } from "vitest";
import { loadConfig, type SigrunConfig } from "../src/config.js";
import type { SigrunHost } from "../src/extension.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import {
	isUserEntryName,
	rewriteSelection,
	sweepUserSelections,
	UserToolRegistry,
	userEntryName,
} from "../src/harness/user-tools.js";
import { createConversationOp, forkOp } from "../src/server/conversation-ops.js";
import { stampOwnerInCommit, stampSessionOwner } from "../src/server/helpers.js";
import { transferOwnership } from "../src/server/ownership.js";
import { createServer } from "../src/server/index.js";
import { SessionMetaDoc } from "../src/server/session-meta.js";
import { seededIdentity } from "./helpers/identity.js";

const ACME_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-user-tools", "index.js"),
).href;

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

interface Boot {
	readonly opened: OpenedHarness;
	readonly config: SigrunConfig;
	readonly dir: string;
}

async function boot(options: {
	readonly dir?: string;
	readonly specifier?: string;
	readonly settings?: { readonly extensions?: readonly Extension[] };
} = {}): Promise<Boot> {
	const dir = options.dir ?? (await mkdtemp(join(tmpdir(), "sigrun-user-tools-")));
	await writeFile(join(dir, "settings.json"), '{"namingModel":false}');
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_AUTH: "token",
		SIGRUN_WORKSPACE_PATH: dir,
		SIGRUN_CONFIG_DIR: dir,
	});
	const opened = await openHarness(config, {
		identity: await seededIdentity(dir),
		extensionSpecifiers: [options.specifier ?? ACME_SPECIFIER],
		settings: options.settings,
		env: {},
		isolationProbe: async () => ({ available: true, abi: 6 }),
	});
	cleanups.push(async () => {
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	});
	return { opened, config, dir };
}

function acmeHost(opened: OpenedHarness): SigrunHost {
	const host = opened.seamHosts.get("acme");
	if (host === undefined) throw new Error("acme host missing");
	return host;
}

function probe(name = "acme_probe", execute = vi.fn(async () => ({
	output: [{ type: "text" as const, text: "inner ran" }],
}))): ToolRegistration {
	return defineTool({
		name,
		description: "Per-user probe",
		parameters: Type.Object({}),
		execute,
	});
}

function names(conversation: Conversation): Promise<readonly string[]> {
	return conversation.agent(BACKGROUND_CONTEXT).then((agent) =>
		agent.extensions.map((extension) => extension.name),
	);
}

async function storedSelection(
	opened: OpenedHarness,
	id: ConversationId,
): Promise<unknown> {
	return (
		await opened.harness.snapshot(AgentDoc, id, BACKGROUND_CONTEXT)
	)?.extensions;
}

/**
 * The extension names one stored selection adds or names. Selections are
 * per-install state, so a boot whose built-ins declare per-user tools adds
 * `<slug>@<owner>` entries beside the ones a test wrote — asserting on the
 * membership of the names this test cares about keeps that true without
 * pinning the whole list to whatever else the boot installed.
 */
function selectionNames(selection: unknown): readonly string[] {
	if (Array.isArray(selection)) return selection as readonly string[];
	if (typeof selection !== "object" || selection === null) return [];
	const add = (selection as { readonly add?: unknown }).add;
	return Array.isArray(add) ? (add as readonly string[]) : [];
}

async function withArraySelection(
	opened: OpenedHarness,
	conversation: Conversation,
	extensions: readonly string[],
): Promise<void> {
	await conversation.commit(async (tx) => {
		const agent = await tx.doc(AgentDoc, conversation.id);
		agent.extensions = [...extensions];
	}, BACKGROUND_CONTEXT);
}

describe("per-user registry and selection", () => {
	test("entry names are slug@user; default selections exclude every per-user entry", () => {
		expect(userEntryName("acme", "alice")).toBe("acme@alice");
		expect(isUserEntryName("acme@alice")).toBe(true);
		expect(isUserEntryName("acme")).toBe(false);
	});

	test("the boot default excludes per-user entries and filters caller-provided names", async () => {
		const { opened } = await boot({
			settings: {
				extensions: [
					{ name: "sigrun.coding-tools", tools: [] },
					{ name: "acme@alice", tools: [] },
				],
			},
		});
		const registry = new UserToolRegistry(opened.registry, () => ["acme"]);
		registry.set("acme", "alice", [probe()]);
		const root = await opened.harness.root(BACKGROUND_CONTEXT);
		expect(await names(root)).not.toContain("acme@alice");
		expect(await names(root)).toContain("sigrun.coding-tools");
	});

	test("alice's new conversation offers acme@alice and not acme@bob", async () => {
		const { opened, config } = await boot();
		acmeHost(opened).tools.setUserTools("alice", [probe()]);
		acmeHost(opened).tools.setUserTools("bob", [probe("bob_probe")]);
		const app = await createServer(opened, config);
		cleanups.push(async () => { await app.close(); });
		await opened.identity.users.add({ user: "alice", admin: false, source: "cli" });
		const { token } = await opened.identity.tokens.create("alice-cli", "alice");
		const response = await app.inject({
			method: "POST",
			url: "/v1/conversations",
			headers: { authorization: `Bearer ${token}` },
		});
		expect(response.statusCode).toBe(201);
		const conversation = await opened.harness.conversation(
			response.json().id,
			BACKGROUND_CONTEXT,
		);
		if (conversation === undefined) throw new Error("created conversation missing");
		const selected = await names(conversation);
		expect(selected).toContain("acme@alice");
		expect(selected).not.toContain("acme@bob");
		expect((await conversation.agent(BACKGROUND_CONTEXT)).tools.map((tool) => tool.name)).toContain("acme_probe");
	});

	test("an entry installed after creation appears without editing the conversation", async () => {
		const { opened } = await boot();
		acmeHost(opened).tools.setUserTools("alice", []);
		const root = await opened.harness.root(BACKGROUND_CONTEXT);
		await stampOwnerInCommit(root, "alice", opened);
		expect(await names(root)).not.toContain("acme@alice");
		acmeHost(opened).tools.setUserTools("alice", [probe()]);
		expect(await names(root)).toContain("acme@alice");
		expect((await root.agent(BACKGROUND_CONTEXT)).tools.map((tool) => tool.name)).toContain("acme_probe");
	});

	test("removeUser and removeSlug uninstall only the matching entries", () => {
		const registry = createRegistry();
		const users = new UserToolRegistry(registry, () => ["acme", "other"]);
		users.set("acme", "alice", [probe("a")]);
		users.set("acme", "bob", [probe("b")]);
		users.set("other", "alice", [probe("c")]);
		users.removeUser("alice");
		expect(registry.snapshot().installed().map((entry) => entry.name)).toEqual(["acme@bob"]);
		users.set("acme", "alice", [probe("a")]);
		users.removeSlug("acme");
		expect(registry.snapshot().installed()).toEqual([]);
	});

	test("quarantine removes a slug's per-user tool entries", async () => {
		const registry = createRegistry();
		const userTools = new UserToolRegistry(registry, () => ["acme"]);
		userTools.set("acme", "alice", [probe()]);
		const { loadExtensions } = await import("../src/harness/loader.js");
		const loaded = await loadExtensions([
			pathToFileURL(join(import.meta.dirname, "fixtures", "fixture-quarantined-user-tools", "index.js")).href,
		], registry, { onQuarantine: (slug) => userTools.removeSlug(slug) });
		expect(loaded.outcomes).toEqual([
			expect.objectContaining({ name: expect.stringContaining("fixture-quarantined-user-tools"), status: "quarantined" }),
		]);
		expect(registry.snapshot().installed().map((entry) => entry.name)).not.toContain("acme@alice");
	});

	test("setUserTools requires perUserTools: true", async () => {
		const { opened } = await boot({
			specifier: pathToFileURL(
				join(import.meta.dirname, "fixtures", "fixture-ext", "index.js"),
			).href,
		});
		const host = opened.seamHosts.get("sigrun-fixture-ext");
		expect(() => host?.tools.setUserTools("alice", [])).toThrow("perUserTools not declared");
	});
});

describe("the wrapper is the owner boundary", () => {
	test("array selection naming acme@bob on alice's conversation is rejected without invoking the inner tool", async () => {
		const { opened } = await boot();
		const inner = vi.fn(async () => ({ output: [{ type: "text" as const, text: "must not run" }] }));
		acmeHost(opened).tools.setUserTools("bob", [probe("shared_probe", inner)]);
		const root = await opened.harness.root(BACKGROUND_CONTEXT);
		await stampOwnerInCommit(root, "alice", opened);
		await withArraySelection(opened, root, ["acme@bob"]);
		const tool = (await root.agent(BACKGROUND_CONTEXT)).callable.find(
			(candidate) => candidate.name === "shared_probe",
		);
		if (tool === undefined) throw new Error("array-selected tool did not resolve");
		const result = await tool.execute({}, {
			conversationId: root.id,
			snapshot: opened.harness.snapshot.bind(opened.harness),
		} as unknown as ToolExecutionApi, BACKGROUND_CONTEXT);
		expect(result).toEqual({
			output: [{ type: "text", text: "This tool belongs to another user." }],
			isError: true,
		});
		expect(inner).not.toHaveBeenCalled();
	});

	test("the owner is read from committed state on every call; the matching owner invokes the inner tool", async () => {
		const { opened } = await boot();
		const inner = vi.fn(async () => ({ output: [{ type: "text" as const, text: "allowed" }] }));
		acmeHost(opened).tools.setUserTools("alice", [probe("owner_probe", inner)]);
		const root = await opened.harness.root(BACKGROUND_CONTEXT);
		await stampOwnerInCommit(root, "alice", opened);
		const tool = (await root.agent(BACKGROUND_CONTEXT)).callable.find(
			(candidate) => candidate.name === "owner_probe",
		);
		if (tool === undefined) throw new Error("owner tool missing");
		const api = {
			conversationId: root.id,
			snapshot: opened.harness.snapshot.bind(opened.harness),
		} as unknown as ToolExecutionApi;
		expect((await tool.execute({}, api, BACKGROUND_CONTEXT)).output).toEqual([
			{ type: "text", text: "allowed" },
		]);
		await stampOwnerInCommit(root, "bob", opened);
		expect((await tool.execute({}, api, BACKGROUND_CONTEXT)).isError).toBe(true);
		expect(inner).toHaveBeenCalledTimes(1);
	});
});

describe("owner writes rewrite selections in the same commits", () => {
	test("bob forks alice's conversation: both shapes lose *@alice; only the object shape gains acme@bob", async () => {
		const { opened, config } = await boot();
		acmeHost(opened).tools.setUserTools("alice", [probe("alice_probe")]);
		acmeHost(opened).tools.setUserTools("bob", [probe("bob_probe")]);
		const app = await createServer(opened, config);
		cleanups.push(async () => { await app.close(); });
		const ctx = app.sigrunContext;
		for (const shape of ["object", "array"] as const) {
			const source = await createConversationOp(ctx, { owner: "alice" });
		const sourceId = source.id as ConversationId;
			const sourceConversation = await opened.harness.conversation(sourceId, BACKGROUND_CONTEXT);
			if (sourceConversation === undefined) throw new Error("source missing");
			await sourceConversation.submit({ type: "input", content: [{ type: "text", text: "history" }] }, BACKGROUND_CONTEXT);
			await sourceConversation.waitForIdle(BACKGROUND_CONTEXT);
			if (shape === "array") {
				await withArraySelection(opened, sourceConversation, ["acme@alice", "unresolved-late-entry"]);
			}
			const forked = await forkOp(ctx, sourceConversation, { owner: "bob" });
			const forkedId = forked.id as ConversationId;
		const stored = await storedSelection(opened, forkedId);
			const serialized = JSON.stringify(stored);
			expect(serialized).not.toContain("@alice");
			if (shape === "object") {
				expect(selectionNames(stored)).toContain("acme@bob");
				const fork = await opened.harness.conversation(forkedId, BACKGROUND_CONTEXT);
				if (fork === undefined) throw new Error("fork missing");
				expect(await names(fork)).toContain("acme@bob");
			} else {
				expect(stored).toEqual(["unresolved-late-entry"]);
			}
		}
	});

	test("a same-owner fork keeps the owner's entries in both selection shapes", async () => {
		const { opened, config } = await boot();
		acmeHost(opened).tools.setUserTools("alice", [probe("same_owner_probe")]);
		const app = await createServer(opened, config);
		cleanups.push(async () => { await app.close(); });
		for (const shape of ["object", "array"] as const) {
			const source = await createConversationOp(app.sigrunContext, { owner: "alice" });
			const sourceId = source.id as ConversationId;
			const sourceConversation = await opened.harness.conversation(sourceId, BACKGROUND_CONTEXT);
			if (sourceConversation === undefined) throw new Error("source missing");
			await sourceConversation.submit({ type: "input", content: [{ type: "text", text: "history" }] }, BACKGROUND_CONTEXT);
			await sourceConversation.waitForIdle(BACKGROUND_CONTEXT);
			if (shape === "array") await withArraySelection(opened, sourceConversation, ["acme@alice"]);
			const before = await storedSelection(opened, sourceId);
			const forked = await forkOp(app.sigrunContext, sourceConversation, { owner: "alice" });
			const forkedId = forked.id as ConversationId;
			expect(await storedSelection(opened, forkedId)).toEqual(before);
			const fork = await opened.harness.conversation(forkedId, BACKGROUND_CONTEXT);
			if (fork === undefined) throw new Error("fork missing");
			expect(await names(fork)).toContain("acme@alice");
		}
	});

	test("re-stamping the same owner leaves the selection untouched", async () => {
		const { opened, config } = await boot();
		acmeHost(opened).tools.setUserTools("alice", [probe()]);
		const app = await createServer(opened, config);
		cleanups.push(async () => { await app.close(); });
		const created = await createConversationOp(app.sigrunContext, { owner: "alice" });
		const conversation = await opened.harness.conversation(created.id as ConversationId, BACKGROUND_CONTEXT);
		if (conversation === undefined) throw new Error("conversation missing");
		await conversation.commit(async (tx) => {
			(await tx.doc(AgentDoc, conversation.id)).extensions = {
				add: ["keep", "acme@alice"],
				remove: ["drop"],
			};
		}, BACKGROUND_CONTEXT);
		const before = await storedSelection(opened, conversation.id);
		await stampSessionOwner(conversation, "alice", opened);
		expect(await storedSelection(opened, conversation.id)).toEqual(before);
	});

	test("transfer alice to bob rewrites both selection shapes", async () => {
		const { opened, config } = await boot();
		acmeHost(opened).tools.setUserTools("alice", [probe("alice_transfer")]);
		acmeHost(opened).tools.setUserTools("bob", [probe("bob_transfer")]);
		await opened.identity.users.add({ user: "bob", admin: false, source: "cli" });
		const app = await createServer(opened, config);
		cleanups.push(async () => { await app.close(); });
		for (const shape of ["object", "array"] as const) {
			const created = await createConversationOp(app.sigrunContext, { owner: "alice" });
			const id = created.id as ConversationId;
			const conversation = await opened.harness.conversation(id, BACKGROUND_CONTEXT);
			if (conversation === undefined) throw new Error("source missing");
			if (shape === "array") await withArraySelection(opened, conversation, ["acme@alice"]);
			await transferOwnership(app.sigrunContext, "alice", "bob");
			const stored = await storedSelection(opened, id);
			expect(JSON.stringify(stored)).not.toContain("@alice");
			if (shape === "object") expect(selectionNames(stored)).toContain("acme@bob");
			else expect(stored).toEqual([]);
		}
	});

	test("rewriteSelection preserves other edits and array exactness", async () => {
		const { opened } = await boot();
		const root = await opened.harness.root(BACKGROUND_CONTEXT);
		await root.commit(async (tx) => {
			const agent = await tx.doc(AgentDoc, root.id);
			agent.extensions = { add: ["keep", "acme@alice"], remove: ["drop", "other@alice"] };
		}, BACKGROUND_CONTEXT);
		await root.commit(async (tx) => {
			await rewriteSelection(tx, root.id, "alice", "bob", ["acme"]);
		}, BACKGROUND_CONTEXT);
		expect(await storedSelection(opened, root.id)).toEqual({
			add: ["keep", "acme@bob"],
			remove: ["drop"],
		});
		await withArraySelection(opened, root, ["keep", "other@alice"]);
		await root.commit(async (tx) => {
			await rewriteSelection(tx, root.id, "alice", "bob", ["acme"]);
		}, BACKGROUND_CONTEXT);
		expect(await storedSelection(opened, root.id)).toEqual(["keep"]);
	});
});

describe("configure and boot sweep", () => {
	test("the sweep skips storage when there are no per-user slugs", async () => {
		const scanConversations = vi.fn();
		const storage = { scanConversations } as unknown as Parameters<typeof sweepUserSelections>[1];
		const harness = {} as Parameters<typeof sweepUserSelections>[0];
		await expect(sweepUserSelections(harness, storage, [])).resolves.toEqual({ scanned: 0, changed: 0 });
		expect(scanConversations).not.toHaveBeenCalled();
	});
	test("configure with another user's entry is rejected on both the route and host bridge", async () => {
		const { opened, config } = await boot();
		acmeHost(opened).tools.setUserTools("bob", [probe()]);
		const app = await createServer(opened, config);
		cleanups.push(async () => { await app.close(); });
		await opened.identity.users.add({ user: "alice", admin: false, source: "cli" });
		const { token } = await opened.identity.tokens.create("alice-cli", "alice");
		const created = await app.inject({
			method: "POST",
			url: "/v1/conversations",
			headers: { authorization: `Bearer ${token}` },
		});
		const id = created.json().id as ConversationId;
		const response = await app.inject({
			method: "POST",
			url: `/v1/conversations/${id}/configure`,
			headers: { authorization: `Bearer ${token}` },
			payload: { extensions: ["acme@bob"] },
		});
		expect(response.statusCode).toBe(400);
		expect(response.json()).toEqual({ error: "invalid_field", field: "extensions" });
		await expect(acmeHost(opened).conversations.configure(id, {
			extensions: ["acme@bob"],
		})).rejects.toMatchObject({
			name: "ConversationOpError",
			body: { error: "invalid_field", field: "extensions" },
		});
		const conversation = await opened.harness.conversation(id, BACKGROUND_CONTEXT);
		if (conversation === undefined) throw new Error("conversation missing");
		expect(await storedSelection(opened, id)).not.toEqual(["acme@bob"]);
		await expect(acmeHost(opened).conversations.configure(id, {
			extensions: ["acme@alice"],
		})).resolves.toBeUndefined();
	});

	test("host create rejects another user's per-user entry", async () => {
		const { opened, config } = await boot();
		acmeHost(opened).tools.setUserTools("bob", [probe()]);
		const app = await createServer(opened, config);
		cleanups.push(async () => { await app.close(); });
		await expect(acmeHost(opened).conversations.create({
			owner: "alice",
			agent: { extensions: ["acme@bob"] },
		})).rejects.toMatchObject({
			name: "ConversationOpError",
			body: { error: "invalid_field", field: "agent.extensions" },
		});
	});

	test("the boot sweep adds missing owner entries once and a second boot changes nothing", async () => {
		const first = await boot();
		const root = await first.opened.harness.root(BACKGROUND_CONTEXT);
		// Legacy durable state: owner metadata exists, but the selection
		// predates M2 and has no owner entries. Do not use the new stamp
		// helper here — its correct same-commit rewrite would repair it now.
		await root.commit(async (tx) => {
			(await tx.doc(SessionMetaDoc, root.id)).owner = "alice";
		}, BACKGROUND_CONTEXT);
		expect(await storedSelection(first.opened, root.id)).toBeUndefined();
		const id = root.id;
		await first.opened.harness.close(BACKGROUND_CONTEXT);

		const second = await boot({ dir: first.dir });
		expect(second.opened.userToolSweep.changed).toBe(1);
		expect(selectionNames(await storedSelection(second.opened, id))).toContain("acme@alice");
		await second.opened.harness.close(BACKGROUND_CONTEXT);

		const third = await boot({ dir: first.dir });
		expect(selectionNames(await storedSelection(third.opened, id))).toContain("acme@alice");
		expect(third.opened.userToolSweep.changed).toBe(0);
	});
});
