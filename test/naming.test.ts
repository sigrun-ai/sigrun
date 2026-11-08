/**
 * Task A2 (UI refresh): automatic conversation naming.
 *
 * `createAutoNamer` names a conversation with one background one-shot
 * pi-ai completion after its first settled ANSWERED run — never over a
 * user name, never for task-owned conversations, `namingModel: false`
 * opts out — bounded by 3 attempts and a timeout, and never rethrowing
 * into the event bus. Plus `cleanTitle`, the model-response scrubber.
 *
 * Hermetic pattern: faux provider + tmp workspace + `app.inject()` (see
 * session-management.test.ts). The naming call goes through the same faux
 * provider as the chat run, so each integration test scripts the chat
 * answer AND the naming answer explicitly; `eventBus.drain()` delivers
 * the settle event, `autoNamer.idle()` waits out the background naming.
 *
 * The settings dir IS the tmp dir: the `namingModel` tests PATCH
 * /v1/settings and must never touch the developer's config dir.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, Model, Models } from "@earendil-works/pi-ai";
import {
	fauxAssistantMessage,
	fauxProvider,
	type FauxProviderHandle,
} from "@earendil-works/pi-ai/providers/faux";
import type {
	ConversationId,
	EntryId,
	Harness,
	SubmissionId,
} from "@earendil-works/pi-durable";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type {
	MemoryEventApi,
	RunSettledEvent,
} from "../src/harness/event-bus.js";
import { cleanTitle, createAutoNamer } from "../src/harness/naming.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import {
	DEFAULT_SESSION_META,
	SessionMetaDoc,
	type SessionMeta,
} from "../src/server/session-meta.js";
import { createServer } from "../src/server/index.js";
import { seededIdentity } from "./helpers/identity.js";
import type { FastifyInstance } from "fastify";

// ---------------------------------------------------------------------------
// cleanTitle
// ---------------------------------------------------------------------------

describe("cleanTitle", () => {
	test("drops surrounding quotes and trailing punctuation", () => {
		expect(cleanTitle('"Paris weather lookup."')).toBe("Paris weather lookup");
	});

	test("drops a leading Title: label and keeps the first 6 words", () => {
		expect(
			cleanTitle("Title: Static site generators with i18n support today"),
		).toBe("Static site generators with i18n support");
	});

	test("whitespace-only input is undefined", () => {
		expect(cleanTitle("  \n ")).toBeUndefined();
	});

	test("a 30-word response keeps only the first 6 words", () => {
		const words = Array.from({ length: 30 }, (_, i) => `w${i}`);
		const title = cleanTitle(words.join(" "));
		expect(title).toBe(words.slice(0, 6).join(" "));
		expect(title!.split(" ")).toHaveLength(6);
	});

	test("a single 80-char word is capped at 60 chars", () => {
		const title = cleanTitle("x".repeat(80));
		expect(title).toBeDefined();
		expect(title!.length).toBeLessThanOrEqual(60);
	});
});

// ---------------------------------------------------------------------------
// createAutoNamer — unit (stub deps)
// ---------------------------------------------------------------------------

/** A settled-run event whose run answered (the only shape that names). */
function answeredEvent(): RunSettledEvent {
	return {
		conversationId: 1 as ConversationId,
		inputs: [1 as SubmissionId],
		inputTexts: ["describe the root filesystem"],
		outcome: {
			status: "answered",
			answerEntryId: 2 as EntryId,
			answer: fauxAssistantMessage("the root filesystem layout is standard"),
		},
	};
}

/** The read surface a runSettled handler receives (unused by the namer). */
const stubApi = {
	entry: async () => undefined,
	entries: async () => ({ items: [] }),
	document: async () => undefined,
} as unknown as MemoryEventApi;

/**
 * A stub Harness covering the namer's entire harness surface —
 * `snapshot` (the meta read), `conversation().agent` (the conversation's
 * own model), and `conversation().commit` (the meta write). The committed
 * draft is the live stored object, the way the doc tracker's draft
 * mutates in place inside the callback.
 */
function stubHarness(
	initial?: Partial<SessionMeta>,
	agentModel?: { provider: string; modelId: string },
) {
	let meta: SessionMeta | undefined =
		initial === undefined
			? undefined
			: {
					...DEFAULT_SESSION_META,
					tagged: [],
					draft: { text: "", attachments: [] },
					...initial,
				};
	const commits: unknown[] = [];
	const harness = {
		snapshot: async () => (meta === undefined ? undefined : { ...meta }),
		conversation: async () => ({
			agent: async () => ({
				...(agentModel === undefined ? {} : { model: agentModel }),
			}),
			commit: async (callback: (tx: { doc(): Promise<SessionMeta> }) => unknown) => {
				if (meta === undefined) {
					meta = {
						...DEFAULT_SESSION_META,
						tagged: [],
						draft: { text: "", attachments: [] },
					};
				}
				const committed = meta;
				commits.push((await callback({ doc: async () => committed })) ?? null);
			},
		}),
	} as unknown as Harness;
	return { harness, commits, read: () => meta };
}

/** A served/unserved catalog fake; completions record their model. */
function stubModels(served: readonly string[]) {
	const calls: Array<{ provider: string; id: string }> = [];
	const models = {
		getModel: (provider: string, id: string) =>
			served.includes(`${provider}/${id}`)
				? ({ provider, id } as Model<string>)
				: undefined,
		getModels: () =>
			served.map((key) => {
				const [provider, id] = key.split("/");
				return { provider, id } as Model<string>;
			}),
			completeSimple: (model: Model<string>) => {
				calls.push({ provider: model.provider, id: model.id });
				return Promise.resolve(fauxAssistantMessage("A short title"));
			},
	} as unknown as Models;
	return { models, calls };
}

describe("createAutoNamer (stub deps)", () => {
	test("names with the conversation's own agent model when namingModel is unset", async () => {
		// The boot default (faux/unserved) is gone from the deps entirely;
		// only the conversation's own agent model can serve the naming call.
		const { models, calls } = stubModels(["acme/model-1"]);
		const stub = stubHarness(undefined, { provider: "acme", modelId: "model-1" });
		const namer = createAutoNamer({
			harness: stub.harness,
			models,
			readSettings: () => ({}),
			isTaskOwned: async () => false,
		});
		await namer.runSettled(answeredEvent(), stubApi, BACKGROUND_CONTEXT);
		await namer.idle();
		expect(calls).toEqual([{ provider: "acme", id: "model-1" }]);
		expect(stub.read()?.autoName).toBe("A short title");
		expect(stub.read()?.autoNameAttempts).toBeUndefined();
	});

	test("a namingModel change applies without a restart", async () => {
		const { models, calls } = stubModels(["acme/model-1", "acme/model-2"]);
		let settings: { namingModel?: string } = { namingModel: "acme/model-1" };
		const stub = stubHarness(undefined, { provider: "acme", modelId: "model-1" });
		const namer = createAutoNamer({
			harness: stub.harness,
			models,
			readSettings: () => settings,
			isTaskOwned: async () => false,
		});
		await namer.runSettled(answeredEvent(), stubApi, BACKGROUND_CONTEXT);
		await namer.idle();
		expect(calls).toEqual([{ provider: "acme", id: "model-1" }]);
		// Swap in a NEW settings object (a captured-object mutation would
		// not prove the per-attempt read).
		settings = { namingModel: "acme/model-2" };
		const second = stubHarness(undefined, { provider: "acme", modelId: "model-1" });
		const namer2 = createAutoNamer({
			harness: second.harness,
			models,
			readSettings: () => settings,
			isTaskOwned: async () => false,
		});
		await namer2.runSettled(answeredEvent(), stubApi, BACKGROUND_CONTEXT);
		await namer2.idle();
		expect(calls).toEqual([
			{ provider: "acme", id: "model-1" },
			{ provider: "acme", id: "model-2" },
		]);
	});

	test("an unserved namingModel does not burn attempts", async () => {
		const { models, calls } = stubModels(["acme/model-1"]);
		let settings: { namingModel?: string } = { namingModel: "acme/missing" };
		const logs: string[] = [];
		const stub = stubHarness(undefined, { provider: "acme", modelId: "model-1" });
		const namer = createAutoNamer({
			harness: stub.harness,
			models,
			readSettings: () => settings,
			isTaskOwned: async () => false,
			log: (message) => logs.push(message),
		});
		// Three answered runs against the unserved model: no attempts burn
		// and the skip log fires exactly once for acme/missing.
		for (let run = 0; run < 3; run++) {
			await namer.runSettled(answeredEvent(), stubApi, BACKGROUND_CONTEXT);
			await namer.idle();
		}
		expect(stub.read()?.autoNameAttempts).toBeUndefined();
		expect(calls).toHaveLength(0);
		expect(logs).toEqual([
			"auto-name: model acme/missing is not served — naming skipped (fix namingModel or the conversation's model)",
		]);
		// Once the setting is fixed, the next run names the conversation.
		settings = { namingModel: "acme/model-1" };
		await namer.runSettled(answeredEvent(), stubApi, BACKGROUND_CONTEXT);
		await namer.idle();
		expect(stub.read()?.autoName).toBe("A short title");
		expect(calls).toEqual([{ provider: "acme", id: "model-1" }]);
	});

	test("the unserved skip log dedupes per key: a second unserved model logs its own once", async () => {
		const { models, calls } = stubModels(["acme/model-1"]);
		let settings: { namingModel?: string } = { namingModel: "acme/missing" };
		const logs: string[] = [];
		const stub = stubHarness(undefined, { provider: "acme", modelId: "model-1" });
		const namer = createAutoNamer({
			harness: stub.harness,
			models,
			readSettings: () => settings,
			isTaskOwned: async () => false,
			log: (message) => logs.push(message),
		});
		// First key twice, second key twice, first key again: the Set is
		// keyed per provider/modelId, so each key logs exactly once and the
		// repeat of the first key stays silent.
		await namer.runSettled(answeredEvent(), stubApi, BACKGROUND_CONTEXT);
		await namer.idle();
		settings = { namingModel: "acme/missing" };
		await namer.runSettled(answeredEvent(), stubApi, BACKGROUND_CONTEXT);
		await namer.idle();
		settings = { namingModel: "acme/absent" };
		await namer.runSettled(answeredEvent(), stubApi, BACKGROUND_CONTEXT);
		await namer.idle();
		await namer.runSettled(answeredEvent(), stubApi, BACKGROUND_CONTEXT);
		await namer.idle();
		settings = { namingModel: "acme/missing" };
		await namer.runSettled(answeredEvent(), stubApi, BACKGROUND_CONTEXT);
		await namer.idle();
		expect(calls).toHaveLength(0);
		expect(stub.read()?.autoNameAttempts).toBeUndefined();
		expect(logs).toEqual([
			"auto-name: model acme/missing is not served — naming skipped (fix namingModel or the conversation's model)",
			"auto-name: model acme/absent is not served — naming skipped (fix namingModel or the conversation's model)",
		]);
	});

	test("no agent model and no namingModel: skip without an attempt", async () => {
		const { models, calls } = stubModels(["acme/model-1"]);
		const logs: string[] = [];
		const stub = stubHarness();
		const namer = createAutoNamer({
			harness: stub.harness,
			models,
			readSettings: () => ({}),
			isTaskOwned: async () => false,
			log: (message) => logs.push(message),
		});
		await namer.runSettled(answeredEvent(), stubApi, BACKGROUND_CONTEXT);
		await namer.idle();
		expect(calls).toHaveLength(0);
		expect(stub.read()?.autoNameAttempts).toBeUndefined();
		expect(stub.read()?.autoName).toBeUndefined();
		expect(logs).toHaveLength(0);
	});

	test("task-owned conversations are never named", async () => {
		const calls: unknown[][] = [];
		const models = {
			getModel: () => {
				throw new Error("a task-owned conversation must not resolve a model");
			},
			completeSimple: (...args: unknown[]) => {
				calls.push(args);
				return Promise.resolve(fauxAssistantMessage("Never"));
			},
		} as unknown as Models;
		const stub = stubHarness();
		const namer = createAutoNamer({
			harness: stub.harness,
			models,
			readSettings: () => ({}),
			isTaskOwned: async () => true,
		});
		await namer.runSettled(answeredEvent(), stubApi, BACKGROUND_CONTEXT);
		await namer.idle();
		expect(calls).toHaveLength(0);
		// The skip is not a failure: no attempt was committed either.
		expect(stub.read()?.autoNameAttempts).toBeUndefined();
	});

	test("a hanging naming call is abandoned (timeout, then one attempt)", async () => {
		const calls: unknown[][] = [];
		const models = {
			getModel: () => ({ provider: "faux", id: "m" }),
			completeSimple: (...args: unknown[]) => {
				calls.push(args);
				return new Promise<AssistantMessage>(() => {});
			},
		} as unknown as Models;
		const stub = stubHarness();
		const namer = createAutoNamer({
			harness: stub.harness,
			models,
			readSettings: () => ({ namingModel: "faux/m" }),
			isTaskOwned: async () => false,
			timeoutMs: 50,
			log: () => {},
		});
		await namer.runSettled(answeredEvent(), stubApi, BACKGROUND_CONTEXT);
		// Must resolve despite the never-settling provider call.
		await namer.idle();
		expect(calls).toHaveLength(1);
		expect(stub.read()?.autoNameAttempts).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// createAutoNamer — through the booted harness + server
// ---------------------------------------------------------------------------

/** One hermetic server: harness + faux provider + Fastify app. */
interface TestServer {
	app: FastifyInstance;
	opened: OpenedHarness;
	faux: FauxProviderHandle;
}

/** Boot a hermetic server with the scripted faux responses in place. */
async function bootServer(options?: {
	readonly responses?: readonly AssistantMessage[];
	/** Disable pi-durable's generation retry (deterministic error settles). */
	readonly retryOff?: boolean;
}): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-naming-"));
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	faux.setResponses([...(options?.responses ?? [])]);
	const contributor: ProviderContributor = {
		name: "ext-faux",
		providers: [{ provider: faux.provider }],
	};
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_AUTH: "none",
		SIGRUN_WORKSPACE_PATH: dir,
	});
	const opened = await openHarness(config, {
		identity: await seededIdentity(dir),
		extensions: [contributor],
		env: {},
		settingsDir: dir,
		...(options?.retryOff
			? { settings: { retry: { enabled: false } } }
			: {}),
	});
	const app = await createServer(opened, config);
	const teardown = async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	};
	cleanups.push(teardown);
	return { app, opened, faux };
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

/** The root conversation (the conversation every test here submits to). */
async function rootConversation(opened: OpenedHarness) {
	return opened.harness.root(BACKGROUND_CONTEXT, {
		agent: { model: opened.defaultModel },
	});
}

/**
 * Submit one input (the §7.1 bounded settlement wait — the faux provider
 * settles in ms), deliver the settle event, and wait out the background
 * naming call. Boot schedules its drain a macrotask after the commit;
 * pumping `drain` directly makes the delivery deterministic, and
 * `autoNamer.idle()` waits for the naming it dispatched.
 */
async function submitAndName(
	server: TestServer,
	conversationId: number,
	input: string,
): Promise<{ status: string }> {
	const response = await server.app.inject({
		method: "POST",
		url: `/v1/conversations/${conversationId}/submissions?waitMs=5000`,
		payload: { input },
		headers: { "content-type": "application/json" },
	});
	expect(response.statusCode).toBe(202);
	await server.opened.eventBus.drain(5_000, BACKGROUND_CONTEXT);
	await server.opened.autoNamer.idle();
	return (response.json() as { submission: { status: string } }).submission;
}

/** The listing row of one conversation (untyped: assertions ARE the shape). */
async function listRow(
	app: FastifyInstance,
	id: number,
): Promise<Record<string, unknown>> {
	const response = await app.inject({ method: "GET", url: "/v1/conversations" });
	expect(response.statusCode).toBe(200);
	const row = (response.json().conversations as Record<string, unknown>[]).find(
		(one) => one.id === id,
	);
	expect(row).toBeDefined();
	return row!;
}

/** The session-meta doc of one conversation via GET. */
async function readMeta(
	app: FastifyInstance,
	id: number,
): Promise<Record<string, unknown>> {
	const response = await app.inject({
		method: "GET",
		url: `/v1/conversations/${id}/meta`,
	});
	expect(response.statusCode).toBe(200);
	return response.json();
}

describe("auto-naming through the booted harness", () => {
	test("names the conversation after the first answered run", async () => {
		const server = await bootServer({
			responses: [
				fauxAssistantMessage("the root filesystem layout is standard"),
				fauxAssistantMessage("Root filesystem layout."),
			],
		});
		const root = await rootConversation(server.opened);
		const settled = await submitAndName(server, root.id, "hello");
		expect(settled.status).toBe("done");
		// The cleaned naming answer is the conversation's display name.
		expect((await listRow(server.app, root.id)).name).toBe(
			"Root filesystem layout",
		);
		// The naming consumed exactly the scripted naming answer.
		expect(server.faux.getPendingResponseCount()).toBe(0);
	});

	test("a user name is never overwritten", async () => {
		const server = await bootServer({
			responses: [
				fauxAssistantMessage("chat answer"),
				fauxAssistantMessage("Would-be auto name"),
			],
		});
		const root = await rootConversation(server.opened);
		const patched = await server.app.inject({
			method: "PATCH",
			url: `/v1/conversations/${root.id}/meta`,
			payload: { name: "Mine" },
			headers: { "content-type": "application/json" },
		});
		expect(patched.statusCode).toBe(200);
		const settled = await submitAndName(server, root.id, "hello");
		expect(settled.status).toBe("done");
		expect((await listRow(server.app, root.id)).name).toBe("Mine");
		// No naming call ran: the scripted naming answer is still pending.
		expect(server.faux.getPendingResponseCount()).toBe(1);
		expect((await readMeta(server.app, root.id)).autoName).toBeUndefined();
	});

	test("failure leaves it unnamed and stops after 3 attempts", async () => {
		const namingError = () =>
			fauxAssistantMessage("boom", {
				stopReason: "error",
				errorMessage: "faux naming failure",
			});
		// Four runs; naming fails (error responses) on the first three, and
		// the exhausted attempt count stops the fourth from even calling.
		const server = await bootServer({
			responses: [
				fauxAssistantMessage("first answer"),
				namingError(),
				fauxAssistantMessage("second answer"),
				namingError(),
				fauxAssistantMessage("third answer"),
				namingError(),
				fauxAssistantMessage("fourth answer"),
			],
		});
		const root = await rootConversation(server.opened);
		for (const input of ["one", "two", "three", "four"]) {
			const settled = await submitAndName(server, root.id, input);
			expect(settled.status).toBe("done");
		}
		const meta = await readMeta(server.app, root.id);
		expect(meta.autoNameAttempts).toBe(3);
		expect(meta.name).toBeUndefined();
		expect(meta.autoName).toBeUndefined();
		expect("name" in (await listRow(server.app, root.id))).toBe(false);
		// The fourth run never issued a naming call: nothing was consumed
		// after its chat answer.
		expect(server.faux.getPendingResponseCount()).toBe(0);
	});

	test("namingModel false disables naming", async () => {
		const server = await bootServer({
			responses: [
				fauxAssistantMessage("chat answer"),
				fauxAssistantMessage("Would-be auto name"),
			],
		});
		const root = await rootConversation(server.opened);
		const patched = await server.app.inject({
			method: "PATCH",
			url: "/v1/settings",
			payload: { namingModel: false },
			headers: { "content-type": "application/json" },
		});
		expect(patched.statusCode).toBe(200);
		expect(patched.json().namingModel).toBe(false);
		const settled = await submitAndName(server, root.id, "hello");
		expect(settled.status).toBe("done");
		expect("name" in (await listRow(server.app, root.id))).toBe(false);
		expect(server.faux.getPendingResponseCount()).toBe(1);
	});

	test("unanswered runs do not name", async () => {
		const server = await bootServer({
			retryOff: true,
			responses: [
				fauxAssistantMessage("boom", {
					stopReason: "error",
					errorMessage: "faux provider failure",
				}),
				fauxAssistantMessage("Would-be auto name"),
			],
		});
		const root = await rootConversation(server.opened);
		const settled = await submitAndName(server, root.id, "hello");
		expect(settled.status).toBe("unanswered");
		expect("name" in (await listRow(server.app, root.id))).toBe(false);
		expect(server.faux.getPendingResponseCount()).toBe(1);
	});

	test("a continue-only run is not named", async () => {
		const server = await bootServer({
			retryOff: true,
			responses: [
				fauxAssistantMessage("boom", {
					stopReason: "error",
					errorMessage: "faux provider failure",
				}),
				fauxAssistantMessage("resumed"),
				fauxAssistantMessage("Would-be auto name"),
			],
		});
		const root = await rootConversation(server.opened);
		const settled = await submitAndName(server, root.id, "hello");
		expect(settled.status).toBe("unanswered");
		const continued = await root.submit(
			{ type: "continue" },
			BACKGROUND_CONTEXT,
		);
		expect((await continued.wait(BACKGROUND_CONTEXT)).status).toBe("done");
		await server.opened.eventBus.drain(5_000, BACKGROUND_CONTEXT);
		await server.opened.autoNamer.idle();

		const meta = await readMeta(server.app, root.id);
		expect(meta.autoName).toBeUndefined();
		expect(meta.autoNameAttempts).toBeUndefined();
		expect(server.faux.getPendingResponseCount()).toBe(1);
	});

	test("cron conversations (SessionMeta.source === \"cron\") are never named", async () => {
		const server = await bootServer({
			responses: [
				fauxAssistantMessage("tick"),
				fauxAssistantMessage("Would-be auto name"),
			],
		});
		// Create a conversation stamped source:"cron" (the jobs path's meta).
		const conversation = await server.opened.harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: { model: server.opened.defaultModel },
				init: async (tx, id) => {
					const meta = await tx.doc(SessionMetaDoc, id);
					meta.source = "cron";
				},
			},
			BACKGROUND_CONTEXT,
		);
		const settled = await submitAndName(server, conversation.id as number, "say tick");
		expect(settled.status).toBe("done");
		// The namer must skip it entirely: no autoName, no attempts recorded,
		// and the naming response stays unconsumed.
		const meta = await readMeta(server.app, conversation.id as number);
		expect(meta.autoName).toBeUndefined();
		expect(meta.autoNameAttempts).toBeUndefined();
		expect(server.faux.getPendingResponseCount()).toBe(1);
	});
});
