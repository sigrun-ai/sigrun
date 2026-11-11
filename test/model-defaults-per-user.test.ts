/**
 * Settings split Plan 2 Task 6: every model read follows the acting
 * user's effective default. These are end-to-end behavior tests over the
 * real conversation/job/curation paths (not call-spy tests).
 *
 * Fixtures own their literals: provider `acme-chat`, models `chat-1` and
 * `chat-2`, users alice/bob/carol, and `.invalid` hosts where needed.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc } from "@earendil-works/pi-durable";
import type { ConversationId, ModelRef } from "@earendil-works/pi-durable";
import {
	fauxAssistantMessage,
	fauxProvider,
	type FauxProviderHandle,
} from "@earendil-works/pi-ai/providers/faux";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { createServer } from "../src/server/index.js";
import { createConversationOp, forkOp } from "../src/server/conversation-ops.js";
import { CurationRunDoc } from "../src/curation/run-doc.js";
import { fireJob, type JobRuntimeDeps } from "../src/jobs/fire.js";
import { writeJobChange } from "../src/jobs/docs.js";
import { specHash } from "../src/jobs/spec.js";
import type { JobSpec } from "@sigrun/shared/jobs";
import type { IdentityStores } from "../src/harness/identity/index.js";
import { effectiveOwner as resolveEffectiveOwner } from "../src/harness/identity/primary-admin.js";
import { seededIdentity } from "./helpers/identity.js";

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});
afterEach(() => vi.restoreAllMocks());

interface Rig {
	opened: OpenedHarness;
	identity: IdentityStores;
	faux: FauxProviderHandle;
	jobDeps: JobRuntimeDeps;
	configDir: string;
}

async function override(
	rig: Rig,
	user: string,
	values: Record<string, unknown>,
): Promise<void> {
	await rig.opened.extensionStores.userExtensionStores("core", user).settings.set(values);
}

async function boot(options: {
	users?: readonly string[];
	responses?: readonly ReturnType<typeof fauxAssistantMessage>[];
} = {}): Promise<Rig> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-model-defaults-"));
	await writeFile(join(dir, "settings.json"), JSON.stringify({
		namingModel: false,
	}));
	const faux = fauxProvider({
		provider: "acme-chat",
		models: [
			{ id: "chat-1", contextWindow: 128_000, reasoning: true },
			{ id: "chat-2", contextWindow: 128_000, reasoning: true },
		],
	});
	faux.setResponses([...(options.responses ?? [])]);
	const identity = await seededIdentity(dir, "alice");
	for (const user of options.users ?? ["bob", "carol"]) {
		if (identity.users.get(user) === undefined) {
			await identity.users.add({ user, admin: false, source: "cli" });
		}
	}
	const contributor: ProviderContributor = {
		name: "acme-chat-extension",
		providers: [{ provider: faux.provider }],
	};
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "acme-chat/chat-1",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
		SIGRUN_CONFIG_DIR: dir,
		SIGRUN_DATA_DIR: join(dir, "data"),
		SIGRUN_STATE_DIR: join(dir, "state"),
		SIGRUN_CACHE_DIR: join(dir, "cache"),
		SIGRUN_AUTH: "token",
		SIGRUN_ISOLATION: "off",
	});
	const opened = await openHarness(config, {
		identity,
		extensions: [contributor],
		builtins: true,
		env: { SIGRUN_CONFIG_DIR: dir },
		settingsDir: dir,
		extensionSpecifiers: [],
	});
	const app = await createServer(opened, config);
	cleanups.push(async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	});
	const jobDeps: JobRuntimeDeps = {
		harness: opened.harness,
		storage: opened.storage,
		registry: opened.registry,
		models: opened.models,
		defaultModel: opened.defaultModel,
		defaultModelFor: opened.defaultModelFor,
		now: () => 1_000,
		defaultTz: "UTC",
		gatewayLoaded: false,
		effectiveOwner: (owner) => resolveEffectiveOwner(identity.users.list(), owner),
	};
	return { opened, identity, faux, jobDeps, configDir: dir };
}

async function agentModel(opened: OpenedHarness, id: number): Promise<ModelRef | undefined> {
	const conversation = await opened.harness.conversation(id as ConversationId, BACKGROUND_CONTEXT);
	if (conversation === undefined) throw new Error(`conversation ${id} missing`);
	return (await conversation.agent(BACKGROUND_CONTEXT)).model;
}

async function seedJob(rig: Rig, owner: string, id = "file:model-default"): Promise<void> {
	const spec: JobSpec = {
		name: "Model default probe",
		schedule: { every: "60s" },
		action: { kind: "prompt", prompt: "acme job", conversation: "new" },
	};
	const now = new Date(1_000).toISOString();
	await rig.opened.harness.commit(async (tx) => {
		await writeJobChange(tx, id, {
			source: "file",
			spec,
			owner,
			enabled: true,
			createdAt: now,
			hash: specHash(id, spec),
			state: "waiting",
		}, owner, now);
	}, BACKGROUND_CONTEXT);
}

describe("per-user chat defaults", () => {
	test("a new conversation starts on its owner's override", async () => {
		const rig = await boot();
		await override(rig, "bob", { defaultModel: "acme-chat/chat-2" });
		const created = await createConversationOp({ opened: rig.opened } as never, { owner: "bob" });
		expect(await agentModel(rig.opened, created.id as number)).toEqual({
			provider: "acme-chat",
			modelId: "chat-2",
		});
	});

	test("another user gets the system default", async () => {
		const rig = await boot();
		await override(rig, "bob", { defaultModel: "acme-chat/chat-2" });
		const created = await createConversationOp({ opened: rig.opened } as never, { owner: "carol" });
		expect(await agentModel(rig.opened, created.id as number)).toEqual(rig.opened.defaultModel);
	});

	test("a fork whose parent stored no model takes the fork owner's default", async () => {
		const rig = await boot({ responses: [fauxAssistantMessage("acme history")] });
		await override(rig, "bob", { defaultModel: "acme-chat/chat-2" });
		const parent = await rig.opened.harness.createConversation({
			ownership: { kind: "ownerless" },
			agent: { model: rig.opened.defaultModel },
		}, BACKGROUND_CONTEXT);
		const submission = await parent.submit({
			type: "input",
			content: [{ type: "text", text: "acme history" }],
		}, BACKGROUND_CONTEXT);
		expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe("done");
		await parent.commit(async (tx) => {
			delete (await tx.doc(AgentDoc, parent.id)).model;
		}, BACKGROUND_CONTEXT);
		const forked = await forkOp({ opened: rig.opened } as never, parent, { owner: "bob" });
		expect(await agentModel(rig.opened, forked.id as number)).toEqual({
			provider: "acme-chat",
			modelId: "chat-2",
		});
	});

	test("a job fire uses its owner's override", async () => {
		const rig = await boot();
		await override(rig, "bob", { defaultModel: "acme-chat/chat-2" });
		await seedJob(rig, "bob");
		const result = await fireJob(rig.jobDeps, "file:model-default", "file:model-default:1000", 1_000, BACKGROUND_CONTEXT);
		expect(result.outcome).toBe("running");
		expect(await agentModel(rig.opened, result.conversationId as number)).toEqual({
			provider: "acme-chat",
			modelId: "chat-2",
		});
	});

	test("an orphaned job uses the primary admin's override", async () => {
		const rig = await boot();
		await override(rig, "alice", { defaultModel: "acme-chat/chat-2" });
		await override(rig, "bob", { defaultModel: "acme-chat/removed-user-model" });
		await seedJob(rig, "bob");
		await rig.identity.users.remove("bob");
		const result = await fireJob(rig.jobDeps, "file:model-default", "file:model-default:1000", 1_000, BACKGROUND_CONTEXT);
		expect(result.outcome).toBe("running");
		expect(await agentModel(rig.opened, result.conversationId as number)).toEqual({
			provider: "acme-chat",
			modelId: "chat-2",
		});
	});

	test("curation runs use their owner's default", async () => {
		const rig = await boot({ responses: [fauxAssistantMessage("acme digest")] });
		await override(rig, "bob", { defaultModel: "acme-chat/chat-2" });
		const result = await rig.opened.curationHost.digestRun("bob", {
			instruction: "acme digest",
			allow: ["skill_manage"],
			maxToolCalls: 1,
			maxOutputTokens: 4_000,
			deadlineMs: 20_000,
			reviewId: "acme-digest-model",
			input: "acme digest input",
		});
		expect(result.status).toBe("completed");
		let cursor: Awaited<ReturnType<typeof rig.opened.storage.scanConversations>>["next"];
		let runId: number | undefined;
		for (;;) {
			const page = await rig.opened.storage.scanConversations({ order: "descending" }, 50, cursor, BACKGROUND_CONTEXT);
			for (const record of page.items) {
				const run = await rig.opened.harness.snapshot(CurationRunDoc, record.id, BACKGROUND_CONTEXT);
				if (run?.reviewId === "acme-digest-model") runId = record.id as number;
			}
			if (page.next === undefined || runId !== undefined) break;
			cursor = page.next;
		}
		expect(runId).toBeDefined();
		expect(await agentModel(rig.opened, runId as number)).toEqual({
			provider: "acme-chat",
			modelId: "chat-2",
		});
	});

	test("a corrupt core override falls back to the system default and warns once per user", async () => {
		const rig = await boot({ responses: [fauxAssistantMessage("acme system answer")] });
		await mkdir(join(rig.configDir, "user-settings", "bob"), { recursive: true });
		await writeFile(
			join(rig.configDir, "user-settings", "bob", "core.json"),
			"{not json",
		);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const created = await createConversationOp({ opened: rig.opened } as never, { owner: "bob" });
		expect(await agentModel(rig.opened, created.id as number)).toEqual(rig.opened.defaultModel);
		const conversation = await rig.opened.harness.conversation(created.id as ConversationId, BACKGROUND_CONTEXT);
		if (conversation === undefined) throw new Error("conversation missing");
		const submission = await conversation.submit({
			type: "input",
			content: [{ type: "text", text: "run despite the corrupt override" }],
		}, BACKGROUND_CONTEXT);
		expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe("done");
		await rig.opened.defaultModelFor("bob");
		expect(warn.mock.calls.filter(([message]) =>
			String(message).includes('defaultModel override for "bob" could not be read'),
		)).toHaveLength(1);
	});

	test("an unserved override falls back to the system default", async () => {
		const rig = await boot({ responses: [fauxAssistantMessage("acme system answer")] });
		await override(rig, "bob", { defaultModel: "acme-chat/not-served" });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const created = await createConversationOp({ opened: rig.opened } as never, { owner: "bob" });
		expect(await agentModel(rig.opened, created.id as number)).toEqual(rig.opened.defaultModel);
		const conversation = await rig.opened.harness.conversation(created.id as ConversationId, BACKGROUND_CONTEXT);
		if (conversation === undefined) throw new Error("conversation missing");
		const submission = await conversation.submit({
			type: "input",
			content: [{ type: "text", text: "run on the system default" }],
		}, BACKGROUND_CONTEXT);
		expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe("done");
		await rig.opened.defaultModelFor("bob");
		expect(warn.mock.calls.filter(([message]) => String(message).includes("acme-chat/not-served"))).toHaveLength(1);
	});

	test("defaultModelFor(undefined) is the system default", async () => {
		const rig = await boot();
		expect(await rig.opened.defaultModelFor(undefined)).toEqual(rig.opened.defaultModel);
	});
});
