/**
 * Task 4 (provider plugins): boot refresh + refresh-on-miss.
 *
 * Boot starts ONE network-allowed `Models.refresh()` fire-and-tracked —
 * concurrent with `Harness.open` and listen, never awaited on the boot
 * path — bounded by a deadline (default 30 000ms) so a wedged upstream
 * cannot stall deploy readiness; timeout/failure only warns (`console.warn`)
 * and the tracked promise rides on `OpenedHarness` (tests await it).
 *
 * At the submit call site, model resolution wraps `requireServedModel`
 * with ONE refresh+retry on `UnservedModelError`: a model added upstream
 * after the last interval tick is immediately usable instead of a 4xx.
 * Still absent after the retry → the ORIGINAL error (the available-ids
 * snapshot from the first check) still 4xxs. The auto-namer's model
 * resolution deliberately does NOT refresh (background lane — the last
 * test pins that).
 *
 * Hermetic pattern: a dynamic provider over the faux streaming core
 * (`createFauxCore`) whose `fetchModels` scripts the catalog per call —
 * generation works through the faux streams, catalog gain works through
 * `fetchModels`, and every network-adjacent seam stays local. The tmp
 * data dir (SIGRUN_DATA_DIR) keeps catalog persistence hermetic.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, Model, Models } from "@earendil-works/pi-ai";
import { createProvider } from "@earendil-works/pi-ai/models";
import {
	createFauxCore,
	fauxAssistantMessage,
} from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId, EntryId, Harness, SubmissionId } from "@earendil-works/pi-durable";
import { loadConfig } from "../src/config.js";
import type { RunSettledEvent } from "../src/harness/event-bus.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import { createAutoNamer } from "../src/harness/naming.js";
import {
	collectProviders,
	createProviderMergeSink,
	type ProviderContributor,
} from "../src/harness/providers/index.js";
import {
	bootRefresh,
	resolveServedModelRefreshing,
} from "../src/harness/providers/refresh.js";
import {
	DEFAULT_SESSION_META,
	type SessionMeta,
} from "../src/server/session-meta.js";
import { createServer } from "../src/server/index.js";
import { seededIdentity } from "./helpers/identity.js";
import type { FastifyInstance } from "fastify";

// ---------------------------------------------------------------------------
// The dynamic faux-core fixture
// ---------------------------------------------------------------------------

/** What a `dynamicFaux` fixture hands back to a test. */
interface DynamicFaux {
	/** The contributor to boot/collect with (default model `acme/<default>`). */
	contributor: ProviderContributor;
	/** How many times `fetchModels` has run (boot refresh + every retry). */
	calls: () => number;
	/** Script the faux streaming responses (generation). */
	setResponses: (responses: readonly AssistantMessage[]) => void;
}

/**
 * A dynamic provider over the faux streaming core: `fetchModels` counts
 * calls and answers with the scripted ids (call numbers start at 1 — the
 * boot refresh consumes call 1), optionally never settling at all (the
 * wedged-upstream shape). Baseline models serve before any refresh; the
 * clones share the baseline model's shape so gained ids stream through
 * the same faux api.
 */
function dynamicFaux(options: {
	/** Ids each fetch returns for the given 1-based call number. */
	fetch: (call: number) => readonly string[];
	/** Never settle the fetch — the wedged-upstream shape. */
	hang?: boolean;
	/** Baseline ids served before any refresh (default none). */
	baseline?: readonly string[];
	/** The contributor's default model id (default `m1`). */
	defaultModelId?: string;
}): DynamicFaux {
	const id = "acme";
	const core = createFauxCore({
		provider: id,
		api: "faux",
		models: (options.baseline ?? []).map((modelId) => ({
			id: modelId,
			contextWindow: 128_000,
		})),
	});
	let calls = 0;
	const clone = (modelId: string): Model<string> => ({
		...core.models[0]!,
		id: modelId,
		name: modelId,
	});
	const provider = createProvider({
		id,
		auth: {
			apiKey: {
				name: "Faux",
				resolve: async () => ({ auth: {} }),
			},
		},
		models: core.models,
		api: {
			stream: core.stream,
			streamSimple: core.streamSimple,
			fetchDeferred: core.fetchDeferred,
			cancelDeferred: core.cancelDeferred,
		},
		fetchModels: options.hang
			? async () => {
					calls++;
					return await new Promise<readonly Model<string>[]>(() => {});
				}
			: async () => {
					calls++;
					return options.fetch(calls).map(clone);
				},
	});
	return {
		contributor: {
			name: "ext-acme",
			providers: [
				{
					provider,
					defaultModel: {
						provider: id,
						modelId: options.defaultModelId ?? "m1",
					},
				},
			],
		},
		calls: () => calls,
		setResponses: (responses) => core.setResponses([...responses]),
	};
}

// ---------------------------------------------------------------------------
// Hermetic server boot
// ---------------------------------------------------------------------------

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

/** Boot a harness + server over one dynamic fixture (naming disabled). */
async function bootServer(
	fixture: DynamicFaux,
): Promise<{ app: FastifyInstance; opened: OpenedHarness }> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-refresh-"));
	// Auto-naming off (the other tests script exact responses; naming is
	// this suite's LAST test's subject, driven directly).
	await writeFile(join(dir, "settings.json"), '{"namingModel": false}');
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "acme/m1",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_AUTH: "none",
		SIGRUN_WORKSPACE_PATH: dir,
		SIGRUN_DATA_DIR: join(dir, "data"),
	});
	const opened = await openHarness(config, {
		identity: await seededIdentity(dir),
		extensions: [fixture.contributor],
		env: {},
		settingsDir: dir,
	});
	const app = await createServer(opened, config);
	cleanups.push(async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	});
	return { app, opened };
}

// ---------------------------------------------------------------------------
// bootRefresh
// ---------------------------------------------------------------------------

describe("bootRefresh", () => {
	test("boot refresh populates dynamic providers", async () => {
		// Baseline serves m1 only; the first fetch (the boot refresh's)
		// gains m2 — a catalog containing m2 can only be the refresh's work.
		const fixture = dynamicFaux({
			fetch: () => ["m1", "m2"],
			baseline: ["m1"],
		});
		const { opened } = await bootServer(fixture);
		// The tracked promise: boot never awaits it, tests do.
		expect(opened.bootRefresh).toBeInstanceOf(Promise);
		await opened.bootRefresh;
		expect(fixture.calls()).toBe(1);
		expect(opened.models.getModel("acme", "m2")).toBeDefined();
		expect(
			opened.models.getModels("acme").map((model) => model.id),
		).toEqual(["m1", "m2"]);
	});

	test("boot refresh bounded: a hanging fetch does not block past the deadline", async () => {
		const fixture = dynamicFaux({
			fetch: () => ["m1"],
			hang: true,
			baseline: ["m1"],
		});
		const { models } = collectProviders(
			[fixture.contributor],
			{},
			createProviderMergeSink(),
		);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const start = Date.now();
			// A wedged upstream resolves at the deadline, never past it —
			// and never rejects (boot is not blocked, the abort only warns).
			await bootRefresh(models, { timeoutMs: 50 });
			expect(Date.now() - start).toBeGreaterThanOrEqual(45);
			expect(fixture.calls()).toBe(1);
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn.mock.calls[0]!.join(" ")).toContain("boot refresh");
		} finally {
			warn.mockRestore();
		}
	});
});

// ---------------------------------------------------------------------------
// resolveServedModelRefreshing — through the submit route
// ---------------------------------------------------------------------------

describe("refresh-on-miss at the submit call site", () => {
	test("refresh-on-miss turns an unserved-model 4xx into success when the provider gains the model", async () => {
		// Call 1 (the boot refresh) serves m1 only; call 2 — the
		// refresh-on-miss the submit triggers — gains m2.
		const fixture = dynamicFaux({
			fetch: (call) => (call >= 2 ? ["m1", "m2"] : ["m1"]),
			baseline: ["m1"],
		});
		fixture.setResponses([fauxAssistantMessage("gained ok")]);
		const { app, opened } = await bootServer(fixture);
		await opened.bootRefresh;
		expect(fixture.calls()).toBe(1);
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		// Pin the conversation to the not-yet-served model (configure accepts
		// it — catalog validation is submit's contract).
		const configured = await app.inject({
			method: "POST",
			url: `/v1/conversations/${root.id}/configure`,
			payload: { model: "acme/m2" },
			headers: { "content-type": "application/json" },
		});
		expect(configured.statusCode).toBe(200);
		const response = await app.inject({
			method: "POST",
			url: `/v1/conversations/${root.id}/submissions`,
			payload: { input: "hello" },
			headers: { "content-type": "application/json" },
		});
		// The miss refreshed the named provider once and re-resolved: no
		// 4xx, the submission ran and answered through the gained model.
		expect(response.statusCode).toBe(202);
		expect(response.json().status).toBe("done");
		expect(fixture.calls()).toBe(2);
		const view = (
			await app.inject({ method: "GET", url: `/v1/conversations/${root.id}` })
		).json();
		expect(
			view.entries.some((e: { kind: string }) => e.kind === "pi.assistant"),
		).toBe(true);
	});

	test("refresh-on-miss still 4xxs when the model is genuinely absent", async () => {
		const fixture = dynamicFaux({
			fetch: () => ["m1"],
			baseline: ["m1"],
		});
		const { app, opened } = await bootServer(fixture);
		await opened.bootRefresh;
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		await app.inject({
			method: "POST",
			url: `/v1/conversations/${root.id}/configure`,
			payload: { model: "acme/nonexistent" },
			headers: { "content-type": "application/json" },
		});
		const response = await app.inject({
			method: "POST",
			url: `/v1/conversations/${root.id}/submissions`,
			payload: { input: "hello" },
			headers: { "content-type": "application/json" },
		});
		expect(response.statusCode).toBe(400);
		const body = response.json();
		expect(body.error).toBe("unserved_model");
		expect(body.model).toBe("acme/nonexistent");
		// The available list the caller sees names what IS served.
		expect(body.available).toContain("acme/m1");
		// Exactly one retry happened — the miss refresh, not a loop.
		expect(fixture.calls()).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// resolveServedModelRefreshing — unit
// ---------------------------------------------------------------------------

describe("resolveServedModelRefreshing (unit)", () => {
	test("resolves after one provider-scoped refresh; original error rethrows when still absent", async () => {
		// No boot refresh here — the fixture's FIRST fetch already serves
		// m2 (call 1 = this test's miss refresh), and "never" never appears.
		const fixture = dynamicFaux({
			fetch: () => ["m1", "m2"],
			baseline: ["m1"],
		});
		const { models } = collectProviders(
			[fixture.contributor],
			{},
			createProviderMergeSink(),
		);
		// The gained id resolves on the miss path (call 1 = this refresh).
		const model = await resolveServedModelRefreshing(models, {
			provider: "acme",
			modelId: "m2",
		});
		expect(model.id).toBe("m2");
		expect(fixture.calls()).toBe(1);
		// A genuinely absent id rethrows UnservedModelError (the original
		// miss, available ids attached) after exactly one more refresh.
		const absent = resolveServedModelRefreshing(models, {
			provider: "acme",
			modelId: "never",
		});
		await expect(absent).rejects.toThrow(/acme\/never is not available/);
		expect(fixture.calls()).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// The auto-namer's model resolution does NOT refresh
// ---------------------------------------------------------------------------

describe("the auto-namer's model resolution does NOT refresh", () => {
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
	} as unknown as Parameters<
		ReturnType<typeof createAutoNamer>["runSettled"]
	>[1];

	/**
	 * A stub Harness covering the namer's harness surface — `snapshot`
	 * (the meta read) and `conversation().commit` (the meta write), the
	 * same shape test/naming.test.ts uses.
	 */
	function stubHarness() {
		let meta: SessionMeta | undefined;
		const harness = {
			snapshot: async () =>
				meta === undefined ? undefined : { ...meta },
			conversation: async () => ({
				commit: async (
					callback: (tx: { doc(): Promise<SessionMeta> }) => unknown,
				) => {
					meta ??= {
						...DEFAULT_SESSION_META,
						tagged: [],
						draft: { text: "", attachments: [] },
					};
					await callback({ doc: async () => meta! });
				},
			}),
		} as unknown as Harness;
		return { harness, read: () => meta };
	}

	test("a naming miss fails without any fetch (regression pin)", async () => {
		// The naming model points at an id the fixture never serves: the
		// namer's requireServedModel miss must record a failed attempt —
		// proving the miss happened — WITHOUT refreshing the provider.
		const fixture = dynamicFaux({
			fetch: () => ["m1"],
			baseline: ["m1"],
		});
		const { models } = collectProviders(
			[fixture.contributor],
			{},
			createProviderMergeSink(),
		);
		const stub = stubHarness();
		const logs: string[] = [];
		const namer = createAutoNamer({
			harness: stub.harness,
			models,
			readSettings: () => ({ namingModel: "acme/absent-model" }),
			defaultModel: { provider: "acme", modelId: "m1" },
			isTaskOwned: async () => false,
			log: (message) => logs.push(message),
		});
		await namer.runSettled(answeredEvent(), stubApi, BACKGROUND_CONTEXT);
		await namer.idle();
		// The miss happened: one failed attempt, the UnservedModelError's
		// message in the log…
		expect(stub.read()?.autoNameAttempts).toBe(1);
		expect(logs.join(" ")).toContain("not available");
		// …and the background lane never refreshed the provider.
		expect(fixture.calls()).toBe(0);
	});
});
