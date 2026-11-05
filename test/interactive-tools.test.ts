/**
 * Ask-user Task 3 (spec §6): `interactiveTools` — tool names an extension
 * declares as needing a human present — are hidden in every
 * non-interactive run core creates.
 *
 * Coverage (the brief's cases):
 * - (a) `excludeInteractiveTools` edits the stored `AgentDoc.tools` filter
 *   from each of the three stored shapes: unset → `{remove}` edit,
 *   `{remove: ["x"]}` → the union (sorted), an explicit array → the array
 *   without the names.
 * - (b) the loader quarantines an extension whose `interactiveTools` names
 *   a tool it does not register (the message names the offending tool).
 * - (c) a `conversation: "new"` job fire's run conversation resolves an
 *   agent with `wait_for_human` in neither `tools` nor `callable`, while
 *   an ordinary conversation offers it in both.
 * - (d) `host.conversations.create({job, agent: {tools}})` filters the
 *   explicit selection the same way.
 *
 * Hermetic: faux provider + tmpdir + `openHarness` with the ask-wait
 * fixture (which declares `interactiveTools: ["wait_for_human"]`) through
 * `extensionEntries` (the curation-runs pattern). The job fire drives
 * `fireJob` directly with boot's threaded deps (the
 * curation-attribution pattern).
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
import {
	AgentDoc,
	type ConversationId,
} from "@earendil-works/pi-durable";
import type { JobSpec } from "@sigrun/shared/jobs";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { SeamHost } from "../src/harness/seam-host.js";
import type { SigrunHost } from "../src/extension.js";
import { excludeInteractiveTools } from "../src/harness/interactive-tools.js";
import { fireJob, type JobRuntimeDeps } from "../src/jobs/fire.js";
import { specHash } from "../src/jobs/spec.js";
import { writeJobChange } from "../src/jobs/docs.js";
import { createServer } from "../src/server/index.js";
import { seededIdentity } from "./helpers/identity.js";

/** The ask-wait fixture entry (declares wait_for_human interactive). */
const ASK_WAIT_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-ask-wait", "index.js"),
).href;

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

/** Boot one hermetic harness with the ask-wait fixture installed. */
async function bootAskWait(): Promise<{
	opened: OpenedHarness;
	config: ReturnType<typeof loadConfig>;
}> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-interactive-tools-"));
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	faux.setResponses([fauxAssistantMessage("answer")]);
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
		SIGRUN_CONFIG_DIR: join(dir, "config"),
	});
	await writeFile(join(dir, "settings.json"), '{"namingModel": false}');
	const identity = await seededIdentity(dir);
	if (identity.users.get("alice") === undefined) {
		await identity.users.add({ user: "alice", admin: false, source: "cli" });
	}
	const opened = await openHarness(config, {
		identity,
		extensions: [{ name: "ext-faux", providers: [{ provider: faux.provider }] }],
		env: { SIGRUN_CONFIG_DIR: join(dir, "config") },
		settingsDir: dir,
		extensionEntries: [{ name: "sigrun-fixture-ask-wait", entry: ASK_WAIT_SPECIFIER }],
	});
	cleanups.push(async () => {
		await opened.harness.close(BACKGROUND_CONTEXT).catch(() => {});
		await rm(dir, { recursive: true, force: true });
	});
	return { opened, config };
}

/** The fixture's seam host, typed as the extension-facing host. */
function askWaitHost(opened: OpenedHarness): SeamHost & SigrunHost {
	const host = opened.seamHosts.get("sigrun-fixture-ask-wait");
	if (host === undefined) throw new Error("ask-wait host not loaded");
	return host as SeamHost & SigrunHost;
}

// ─── (a) the AgentDoc.tools edit shapes ────────────────────────────────────

describe("excludeInteractiveTools (AgentDoc.tools edit shapes)", () => {
	test("unset tools gains a sorted {remove} edit", async () => {
		const { opened } = await bootAskWait();
		const conversation = await opened.harness.createConversation(
			{ ownership: { kind: "ownerless" }, agent: { model: opened.defaultModel } },
			BACKGROUND_CONTEXT,
		);
		await conversation.commit(
			async (tx) =>
				await excludeInteractiveTools(
					tx,
					conversation.id,
					opened.interactiveTools,
				),
			BACKGROUND_CONTEXT,
		);
		const stored = await opened.harness.snapshot(
			AgentDoc,
			conversation.id,
			BACKGROUND_CONTEXT,
		);
		expect(stored?.tools).toEqual({ remove: ["wait_for_human"] });
	});

	test("an existing {remove} edit gains the names (sorted union)", async () => {
		const { opened } = await bootAskWait();
		const conversation = await opened.harness.createConversation(
			{ ownership: { kind: "ownerless" }, agent: { model: opened.defaultModel } },
			BACKGROUND_CONTEXT,
		);
		await conversation.commit(async (tx) => {
			const agent = await tx.doc(AgentDoc, conversation.id);
			agent.tools = { remove: ["x"] };
		}, BACKGROUND_CONTEXT);
		await conversation.commit(
			async (tx) =>
				await excludeInteractiveTools(
					tx,
					conversation.id,
					opened.interactiveTools,
				),
			BACKGROUND_CONTEXT,
		);
		const stored = await opened.harness.snapshot(
			AgentDoc,
			conversation.id,
			BACKGROUND_CONTEXT,
		);
		expect(stored?.tools).toEqual({ remove: ["wait_for_human", "x"] });
	});

	test("an explicit array loses the names", async () => {
		const { opened } = await bootAskWait();
		const conversation = await opened.harness.createConversation(
			{ ownership: { kind: "ownerless" }, agent: { model: opened.defaultModel } },
			BACKGROUND_CONTEXT,
		);
		await conversation.commit(async (tx) => {
			const agent = await tx.doc(AgentDoc, conversation.id);
			agent.tools = ["read", "wait_for_human"];
		}, BACKGROUND_CONTEXT);
		await conversation.commit(
			async (tx) =>
				await excludeInteractiveTools(
					tx,
					conversation.id,
					opened.interactiveTools,
				),
			BACKGROUND_CONTEXT,
		);
		const stored = await opened.harness.snapshot(
			AgentDoc,
			conversation.id,
			BACKGROUND_CONTEXT,
		);
		expect(stored?.tools).toEqual(["read"]);
	});

	test("an empty name set is a no-op", async () => {
		const { opened } = await bootAskWait();
		const conversation = await opened.harness.createConversation(
			{ ownership: { kind: "ownerless" }, agent: { model: opened.defaultModel } },
			BACKGROUND_CONTEXT,
		);
		await conversation.commit(
			async (tx) =>
				await excludeInteractiveTools(tx, conversation.id, new Set()),
			BACKGROUND_CONTEXT,
		);
		const stored = await opened.harness.snapshot(
			AgentDoc,
			conversation.id,
			BACKGROUND_CONTEXT,
		);
		expect(stored?.tools).toBeUndefined();
	});
});

// ─── (b) loader validation ─────────────────────────────────────────────────

describe("interactiveTools loader validation", () => {
	test("an unregistered name quarantines the extension, naming it", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-interactive-bad-"));
		cleanups.push(async () => {
			await rm(dir, { recursive: true, force: true });
		});
		const entry = join(dir, "bad-interactive.js");
		await writeFile(
			entry,
			`// A fixture whose interactiveTools names a tool it never registers.
// Plain object shapes (the fixture-seam-bad-kinds pattern): the loader's
// structural isExtension read accepts the bare {name, tools} form, so the
// interactiveTools validation — not an import failure — is what rejects it.
export default function createBad() {
	return {
		interactiveTools: ["never_registered"],
		extension: {
			name: "sigrun-fixture-bad-interactive",
			tools: [
				{
					name: "some_tool",
					description: "A tool.",
					parameters: { type: "object", properties: {} },
					async execute() {
						return { output: [{ type: "text", text: "ok" }] };
					},
				},
			],
		},
	};
}
`,
		);
		const faux = fauxProvider({
			provider: "faux",
			models: [{ id: "m", contextWindow: 128_000 }],
		});
		const config = loadConfig({
			SIGRUN_DEFAULT_MODEL: "faux/m",
			SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
			SIGRUN_WORKSPACE_PATH: dir,
			SIGRUN_CONFIG_DIR: join(dir, "config"),
		});
		await writeFile(join(dir, "settings.json"), '{"namingModel": false}');
		const identity = await seededIdentity(dir);
		const opened = await openHarness(config, {
			identity,
			extensions: [
				{ name: "ext-faux", providers: [{ provider: faux.provider }] },
			],
			env: { SIGRUN_CONFIG_DIR: join(dir, "config") },
			settingsDir: dir,
			extensionEntries: [
				{ name: "sigrun-fixture-bad-interactive", entry: pathToFileURL(entry).href },
			],
		});
		cleanups.push(async () => {
			await opened.harness.close(BACKGROUND_CONTEXT).catch(() => {});
		});
		const outcome = opened.extensionOutcomes.find(
			(one) => one.name === "sigrun-fixture-bad-interactive",
		);
		expect(outcome?.status).toBe("quarantined");
		expect(outcome?.error).toContain(
			'interactiveTools names "never_registered", which this extension does not register',
		);
	});
});

// ─── (c) job fires hide interactive tools ──────────────────────────────────

describe("job fires hide interactive tools", () => {
	test("a conversation:\"new\" fire's agent offers no interactive tool, an ordinary conversation does", async () => {
		const { opened } = await bootAskWait();
		// The boot-threaded union: the fixture's declaration reached the
		// opened harness.
		expect(opened.interactiveTools.has("wait_for_human")).toBe(true);

		// An ordinary conversation offers the tool (the control arm).
		const ordinary = await opened.harness.createConversation(
			{ ownership: { kind: "ownerless" }, agent: { model: opened.defaultModel } },
			BACKGROUND_CONTEXT,
		);
		const ordinaryAgent = await ordinary.agent(BACKGROUND_CONTEXT);
		expect(
			ordinaryAgent.tools.some((tool) => tool.name === "wait_for_human"),
		).toBe(true);
		expect(
			ordinaryAgent.callable.some((tool) => tool.name === "wait_for_human"),
		).toBe(true);

		// A conversation:"new" job fire: the run conversation's agent has
		// wait_for_human in NEITHER tools nor callable (nested executeTool
		// resolution reads the same enabled filter).
		const now = Date.parse("2026-11-05T12:00:00.000Z");
		const fireKey = "nightly:2026-11-05T12:00:00.000Z";
		const spec: JobSpec = {
			name: "nightly",
			schedule: { every: "60s" },
			action: { kind: "prompt", prompt: "run the job", conversation: "new" },
		};
		await opened.harness.commit(async (tx) => {
			await writeJobChange(
				tx,
				"nightly",
				{
					source: "api",
					spec,
					owner: "alice",
					enabled: true,
					createdAt: new Date(now).toISOString(),
					hash: specHash("nightly", spec),
					state: "waiting",
				},
				"alice",
				new Date(now).toISOString(),
			);
		}, BACKGROUND_CONTEXT);
		const deps: JobRuntimeDeps = {
			effectiveOwner: (owner) => owner,
			harness: opened.harness,
			storage: opened.storage,
			registry: opened.registry,
			models: opened.models,
			defaultModel: opened.defaultModel,
			now: () => now,
			defaultTz: "UTC",
			gatewayLoaded: false,
			interactiveTools: opened.interactiveTools,
		};
		const fired = await fireJob(
			deps,
			"nightly",
			fireKey,
			now,
			BACKGROUND_CONTEXT,
		);
		expect(fired.outcome).toBe("running");
		const runId = fired.conversationId as number;
		const runConversation = await opened.harness.conversation(
			runConversationId(runId),
			BACKGROUND_CONTEXT,
		);
		const runAgent = await runConversation!.agent(BACKGROUND_CONTEXT);
		expect(
			runAgent.tools.some((tool) => tool.name === "wait_for_human"),
		).toBe(false);
		expect(
			runAgent.callable.some((tool) => tool.name === "wait_for_human"),
		).toBe(false);
		// The stored filter carries the removal (the no-resurrection pin).
		const stored = await opened.harness.snapshot(
			AgentDoc,
			runConversationId(runId),
			BACKGROUND_CONTEXT,
		);
		expect(stored?.tools).toEqual({ remove: ["wait_for_human"] });
		await opened.harness.waitForIdle(BACKGROUND_CONTEXT);
	});

	test("a job firing into an EXISTING conversation keeps the tool listed (the uncovered shape)", async () => {
		const { opened } = await bootAskWait();
		const conversation = await opened.harness.createConversation(
			{ ownership: { kind: "ownerless" }, agent: { model: opened.defaultModel } },
			BACKGROUND_CONTEXT,
		);
		const now = Date.parse("2026-11-05T12:00:00.000Z");
		const fireKey = "nightly:2026-11-05T12:00:00.000Z";
		const spec: JobSpec = {
			name: "nightly",
			schedule: { every: "60s" },
			action: {
				kind: "prompt",
				prompt: "run the job",
				conversation: conversation.id as unknown as number,
			},
		};
		await opened.harness.commit(async (tx) => {
			await writeJobChange(
				tx,
				"nightly",
				{
					source: "api",
					spec,
					owner: "alice",
					enabled: true,
					createdAt: new Date(now).toISOString(),
					hash: specHash("nightly", spec),
					state: "waiting",
				},
				"alice",
				new Date(now).toISOString(),
			);
		}, BACKGROUND_CONTEXT);
		const deps: JobRuntimeDeps = {
			effectiveOwner: (owner) => owner,
			harness: opened.harness,
			storage: opened.storage,
			registry: opened.registry,
			models: opened.models,
			defaultModel: opened.defaultModel,
			now: () => now,
			defaultTz: "UTC",
			gatewayLoaded: false,
			interactiveTools: opened.interactiveTools,
		};
		const fired = await fireJob(
			deps,
			"nightly",
			fireKey,
			now,
			BACKGROUND_CONTEXT,
		);
		expect(fired.outcome).toBe("running");
		// The fixed-conversation branch is NOT covered by the creation-time
		// filter: the tool stays listed (the execute-time isJobRun guard is
		// the tool's own answer for this shape, per spec §6's option A).
		const agent = await conversation.agent(BACKGROUND_CONTEXT);
		expect(
			agent.tools.some((tool) => tool.name === "wait_for_human"),
		).toBe(true);
		await opened.harness.waitForIdle(BACKGROUND_CONTEXT);
	});
});

/** The run conversation id as the harness's ConversationId. */
function runConversationId(id: number): ConversationId {
	return id as unknown as ConversationId;
}

// ─── (d) host.conversations.create({job, agent}) filters the selection ─────

describe("host.conversations.create({job, agent}) filters interactive tools", () => {
	test("wait_for_human is absent from the explicit selection", async () => {
		const { opened, config } = await bootAskWait();
		const app = await createServer(opened, config);
		cleanups.push(async () => {
			await app.close().catch(() => {});
		});
		const host = askWaitHost(opened);
		const job = await opened.jobs.createApi(
			{
				name: "nightly-check",
				schedule: { at: "2099-01-01T00:00:00.000Z" },
				action: {
					kind: "prompt",
					prompt: "check the state",
					conversation: "new",
				},
			},
			"alice",
		);
		const id = await host.conversations.create({
			owner: "alice",
			job: job.id,
			agent: { tools: ["wait_for_human", "read"] },
		});
		const conversation = await opened.harness.conversation(id, BACKGROUND_CONTEXT);
		const agent = await conversation!.agent(BACKGROUND_CONTEXT);
		expect(
			agent.tools.some((tool) => tool.name === "wait_for_human"),
		).toBe(false);
		expect(agent.tools.some((tool) => tool.name === "read")).toBe(true);
		expect(
			agent.callable.some((tool) => tool.name === "wait_for_human"),
		).toBe(false);
	});
});
