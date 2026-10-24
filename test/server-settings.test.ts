/**
 * Task 8b: GET/PATCH /v1/settings.
 *
 * The endpoint serves the file-backed settings store `openHarness` boots
 * with (Task 8a): GET the effective settings, PATCH merges (unknown key →
 * 400 invalid_field; wrong types → 400 per the file conventions; null
 * clears a key) and persists to the file, and the harness picks changes
 * up on the NEXT resolution — steeringMode on the next submission's
 * admission (pi-durable re-reads HarnessSettings per boundary).
 *
 * The steering testable (the spec's binding test): PATCH steeringMode to
 * "all", then drive two submissions through the REAL harness and observe
 * the inbox modes — with steeringMode "all" every queued steer item is
 * admitted at the boundary, versus pi-durable's default one-at-a-time.
 * Mirrors the queue-mode observation pattern of
 * test/server-submissions.test.ts.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type FauxProviderHandle,
} from "@earendil-works/pi-ai/providers/faux";
import { Type } from "@earendil-works/pi-ai";
import {
	defineTool,
	InboxDoc,
	type ConversationId,
	type HarnessSettings,
} from "@earendil-works/pi-durable";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import { settingsPath } from "../src/harness/settings.js";
import type { SettingsFile } from "@sigrun/shared/settings";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { createServer } from "../src/server/index.js";
import { seededIdentity } from "./helpers/identity.js";
import type { FastifyInstance } from "fastify";

/** One hermetic server: harness + faux provider + Fastify app + settings dir. */
interface TestServer {
	app: FastifyInstance;
	opened: OpenedHarness;
	/** The tmp settings dir (the store's file lives at `settings.json`). */
	settingsDir: string;
	/** The faux provider (append responses per test). */
	faux: FauxProviderHandle;
}

/**
 * Boot a hermetic server with its settings store over a fresh tmp dir
 * (the `settingsDir` seam — no `~/.config/sigrun` write). `opts.file`
 * writes the settings file BEFORE boot (the deployment default the
 * harness must read); `opts.settings` is the openHarness caller seam
 * (the test override, which must WIN over the file per field — the
 * round-1 pinning seam).
 */
async function bootServer(
	env: Record<string, string> = {},
	opts: { file?: string; settings?: HarnessSettings } = {},
): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-sett-"));
	if (opts.file !== undefined) {
		await writeFile(settingsPath(dir), opts.file, "utf8");
	}
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
		// A slow stream keeps the first turn busy for the steer observation.
		tokensPerSecond: 4,
	});
	faux.setResponses([fauxAssistantMessage("ok")]);
	const contributor: ProviderContributor = {
		name: "ext-faux",
		providers: [{ provider: faux.provider }],
	};
	const bootEnv = {
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_AUTH: "none",
		SIGRUN_WORKSPACE_PATH: dir,
		...env,
	};
	// The serve path's final resolution shape: env over the (pre-written)
	// file — so a file-sourced server key's RESOLVED value (what the
	// `effective` block reports) reflects the file, not the code default.
	const file: SettingsFile | undefined =
		opts.file === undefined ? undefined : (JSON.parse(opts.file) as SettingsFile);
	const config = loadConfig(bootEnv, file);
	const opened = await openHarness(config, {
		identity: await seededIdentity(dir),
		extensions: [contributor],
		env: {},
		settingsDir: dir,
		settings: opts.settings,
	});
	// The boot env threads into the server (the /v1/settings `effective`
	// block classifies env-sourced keys against it — the deploy entry
	// passes the real `process.env` here).
	const app = await createServer(opened, config, [], { env: bootEnv });
	const teardown = async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	};
	cleanups.push(teardown);
	return { app, opened, settingsDir: dir, faux };
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

/**
 * A `deferred: true` tool (the tool_search load target) plus a loader tool
 * whose result carries `control.addTools` — the exact pi-durable mechanism
 * `tool_search` uses (dist tool-search.js writes `control.addTools` for its
 * matches). Registered per-test via `opened.registry.install`, so the
 * hazard pin can drive a REAL load through a real tool round.
 */
const deferredProbeTool = defineTool({
	name: "probe_deferred",
	description: "A deferred tool the loader loads.",
	parameters: Type.Object({}),
	deferred: true,
	async execute() {
		return { output: [{ type: "text", text: "deferred ran" }] };
	},
});
const loaderProbeTool = defineTool({
	name: "probe_loader",
	description: "Loads the deferred probe via control.addTools.",
	parameters: Type.Object({}),
	async execute() {
		return {
			output: [{ type: "text", text: "loaded probe_deferred" }],
			control: { addTools: ["probe_deferred"] },
		};
	},
});

const patch = (app: FastifyInstance, body: unknown) =>
	app.inject({
		method: "PATCH",
		url: "/v1/settings",
		payload: body as Record<string, unknown>,
		headers: { "content-type": "application/json" },
	});

/**
 * The `pi.user` entries whose content starts with `prefix` — content may
 * be a plain string (a bare-string submission) or a parts array, so both
 * shapes are checked (the §5 view serializes the stored entry verbatim).
 */
function userEntriesWithText(
	view: { readonly entries: readonly unknown[] },
	prefix: string,
): readonly unknown[] {
	return (
		view.entries as Array<{
			kind: string;
			model?: { content?: unknown }[];
		}>
	).filter((entry) => {
		if (entry.kind !== "pi.user") return false;
		const content = entry.model?.[0]?.content;
		const parts = Array.isArray(content) ? content : [{ text: content }];
		return parts.some((part) =>
			String((part as { text?: string }).text ?? "").startsWith(prefix),
		);
	});
}

describe("GET /v1/settings", () => {
	test("serves {} when the settings file is absent (all defaults)", async () => {
		const { app } = await bootServer();
		const response = await app.inject({ method: "GET", url: "/v1/settings" });
		expect(response.statusCode).toBe(200);
		// Every store key defaults — the only content is the server-computed
		// roster and the `effective` block (both computed per request, never
		// persisted).
		expect(response.json()).toEqual({
			toolRoster: expect.any(Array),
			effective: expect.any(Object),
			// U4 §13.2: the pending-restart diff rides every GET; nothing
			// is pending on a fresh boot.
			pendingRestart: [],
		});
	});

	test("serves the file's contents when present", async () => {
		const { app, settingsDir } = await bootServer();
		await writeFile(
			settingsPath(settingsDir),
			'{"steeringMode": "all"}',
			"utf8",
		);
		const response = await app.inject({ method: "GET", url: "/v1/settings" });
		expect(response.json()).toEqual(
			expect.objectContaining({ steeringMode: "all" }),
		);
	});

	test("the effective block classifies env / file / default per flattened server key", async () => {
		const port = 4080;
		const { app } = await bootServer({ SIGRUN_PORT: String(port) });
		const response = await app.inject({ method: "GET", url: "/v1/settings" });
		expect(response.statusCode).toBe(200);
		const { effective } = response.json() as {
			effective: Record<string, { value: unknown; source: string }>;
		};
		// SIGRUN_PORT was set at boot → env; nothing set compaction → the
		// code default; storagePath/workspacePath were env-set too (the
		// harness's hermetic tmp roots).
		expect(effective["server.port"]).toEqual({ value: port, source: "env" });
		expect(effective["server.compaction.reserveTokens"]).toEqual({
			value: 16384,
			source: "default",
		});
		expect(effective["server.storagePath"]).toEqual({
			value: expect.stringContaining("sigrun.db"),
			source: "env",
		});
	});

	test("the effective block reads file-sourced keys from the settings file", async () => {
		const { app } = await bootServer(
			{},
			{
				file: JSON.stringify({
					server: { compaction: { reserveTokens: 4096 } },
				}),
			},
		);
		const response = await app.inject({ method: "GET", url: "/v1/settings" });
		const { effective } = response.json() as {
			effective: Record<string, { value: unknown; source: string }>;
		};
		expect(effective["server.compaction.reserveTokens"]).toEqual({
			value: 4096,
			source: "file",
		});
		// A file PATCH lands as a file source on the NEXT GET (the block is
		// computed per request over the fresh file read) — while the VALUE
		// stays the boot-resolved one: `server.*` is restart-required (the
		// running boot never re-resolves it), so the block honestly reports
		// what boot used + where the NEXT boot takes the key from.
		await patch(app, { server: { port: 5050 } });
		const after = (await app.inject({ method: "GET", url: "/v1/settings" }))
			.json() as { effective: Record<string, { value: unknown; source: string }> };
		expect(after.effective["server.port"]).toEqual({
			value: 3000,
			source: "file",
		});
	});
});

describe("PATCH /v1/settings", () => {
	test("merges, persists to the file, and reads back", async () => {
		const { app, settingsDir } = await bootServer();
		const response = await patch(app, { steeringMode: "all" });
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual(
			expect.objectContaining({ steeringMode: "all" }),
		);
		// The file on disk carries it (the next boot reads the same value).
		const file = JSON.parse(
			await (await import("node:fs/promises")).readFile(
				settingsPath(settingsDir),
				"utf8",
			),
		);
		expect(file).toEqual({ steeringMode: "all" });
		const readBack = await app.inject({
			method: "GET",
			url: "/v1/settings",
		});
		expect(readBack.json()).toEqual(
			expect.objectContaining({ steeringMode: "all" }),
		);
	});

	test("a second PATCH preserves the first key (merge, not replace)", async () => {
		const { app } = await bootServer();
		await patch(app, { steeringMode: "all" });
		const response = await patch(app, { followUpMode: "all" });
		expect(response.json()).toEqual(
			expect.objectContaining({
				steeringMode: "all",
				followUpMode: "all",
			}),
		);
	});

	test("null clears a key", async () => {
		const { app } = await bootServer();
		await patch(app, { steeringMode: "all" });
		const response = await patch(app, { steeringMode: null });
		expect(response.json()).toEqual({
			toolRoster: expect.any(Array),
			effective: expect.any(Object),
			// The PATCH response carries the write's classification (U4
			// §13.1/§13.2): steeringMode is a live key — applied, no pending.
			applied: ["steeringMode"],
			pending: [],
			pendingRestart: [],
		});
	});

	test("unknown key → 400 invalid_field naming it", async () => {
		const { app } = await bootServer();
		const response = await patch(app, { compaction: {} });
		expect(response.statusCode).toBe(400);
		expect(response.json()).toEqual({
			error: "invalid_field",
			field: "compaction",
		});
	});

	test("wrong types → 400 invalid_field naming the key", async () => {
		const { app } = await bootServer();
		for (const [body, field] of [
			[{ steeringMode: "sometimes" }, "steeringMode"],
			[{ defaultTools: "read" }, "defaultTools"],
			[{ defaultTools: ["read", 42] }, "defaultTools"],
			[{ perModelThinking: { "faux/m": "sideways" } }, "perModelThinking.faux/m"],
			[{ retry: { maxRetries: -1 } }, "retry.maxRetries"],
		] as const) {
			const response = await patch(app, body);
			expect(response.statusCode).toBe(400);
			expect(response.json()).toEqual({
				error: "invalid_field",
				field,
			});
		}
	});

	test("a non-object body → 400 invalid_body", async () => {
		const { app } = await bootServer();
		const response = await app.inject({
			method: "PATCH",
			url: "/v1/settings",
			payload: [1, 2],
			headers: { "content-type": "application/json" },
		});
		expect(response.statusCode).toBe(400);
		expect(response.json()).toEqual({ error: "invalid_body" });
	});

	test("a rejected PATCH persists nothing", async () => {
		const { app, settingsDir } = await bootServer();
		await patch(app, { steeringMode: "all" });
		await patch(app, { bogus: 1 });
		const read = (
			await app.inject({ method: "GET", url: "/v1/settings" })
		).json();
		expect(read).toEqual(
			expect.objectContaining({ steeringMode: "all" }),
		);
		expect(JSON.parse(
			await (await import("node:fs/promises")).readFile(
				settingsPath(settingsDir),
				"utf8",
			),
		)).toEqual({ steeringMode: "all" });
	});

	test("server.* PATCHes validate, persist, and read back (restart-required)", async () => {
		const { app, settingsDir } = await bootServer();
		const response = await patch(app, { server: { port: 4080 } });
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({
			server: { port: 4080 },
			toolRoster: expect.any(Array),
			effective: expect.any(Object),
			// §13.1: server.port is a restart key — stored, pending.
			applied: [],
			pending: ["server.port"],
			pendingRestart: ["server.port"],
		});
		// Persisted to the file…
		const file = JSON.parse(
			await (await import("node:fs/promises")).readFile(
				settingsPath(settingsDir),
				"utf8",
			),
		);
		expect(file).toEqual({ server: { port: 4080 } });
		// …and GET serves it.
		const readBack = await app.inject({
			method: "GET",
			url: "/v1/settings",
		});
		expect(readBack.json()).toEqual({
			server: { port: 4080 },
			toolRoster: expect.any(Array),
			effective: expect.any(Object),
			pendingRestart: ["server.port"],
		});
		// Invalid server fields → 400 invalid_field naming the key.
		for (const [body, field] of [
			[{ server: { port: "abc" } }, "server.port"],
			[{ server: { backup: { path: "/x", s3: { bucket: "b" } } } }, "server.backup"],
			[{ server: { model: "openai/gpt-4o" } }, "server.model"],
			[{ server: { webuiBundle: 42 } }, "server.webuiBundle"],
		] as const) {
			const rejected = await patch(app, body);
			expect(rejected.statusCode).toBe(400);
			expect(rejected.json()).toEqual({
				error: "invalid_field",
				field,
			});
		}
	});

	test("the config-surface sections PATCH, persist, and read back (restart-required)", async () => {
		const { app, settingsDir } = await bootServer();
		// Top-level extensions list + defaultModel + defaultProvider, and
		// server.webuiBundle — all accepted by the same PATCH machinery.
		const response = await patch(app, {
			extensions: ["@acme/ext-a"],
			defaultModel: "faux/m2",
			defaultProvider: { baseUrl: "https://gw.example/v1" },
			server: { webuiBundle: "ui/dist" },
		});
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({
			extensions: ["@acme/ext-a"],
			defaultModel: "faux/m2",
			defaultProvider: { baseUrl: "https://gw.example/v1" },
			server: { webuiBundle: "ui/dist" },
			toolRoster: expect.any(Array),
			effective: expect.any(Object),
			// Every one of these is a restart key (§13.1) — all pending.
			applied: [],
			pending: [
				"extensions",
				"defaultModel",
				"defaultProvider.baseUrl",
				"server.webuiBundle",
			],
			pendingRestart: [
				"extensions",
				"defaultModel",
				"defaultProvider.baseUrl",
				"server.webuiBundle",
			],
		});
		// Persisted to the file (restart-required: the running boot keeps
		// its resolved values; these land on the NEXT boot).
		const file = JSON.parse(
			await (await import("node:fs/promises")).readFile(
				settingsPath(settingsDir),
				"utf8",
			),
		);
		expect(file.defaultModel).toBe("faux/m2");
		expect(file.extensions).toEqual(["@acme/ext-a"]);
		expect(file.server.webuiBundle).toBe("ui/dist");
		// Invalid shapes → 400 invalid_field naming the key.
		for (const [body, field] of [
			[{ extensions: ["a", ""] }, "extensions"],
			[{ defaultModel: "acme/" }, "defaultModel"],
			[{ defaultProvider: { apiKey: "k" } }, "defaultProvider.apiKey"],
		] as const) {
			const rejected = await patch(app, body);
			expect(rejected.statusCode).toBe(400);
			expect(rejected.json()).toEqual({
				error: "invalid_field",
				field,
			});
		}
	});
});

describe("the steering testable: a PATCHed steeringMode changes the next submission's admission", () => {
	/**
	 * Drive one busy turn plus `count` steered submissions through the REAL
	 * harness + server routes, polling the inbox and the transcript while
	 * the runs proceed. Each sample records (steered answers placed, inbox
	 * steer items queued) — the direct observable of the boundary's queue
	 * mode: "all" drains EVERY steer at the single boundary, one-at-a-time
	 * leaves the rest queued while the first steered answer runs.
	 */
	async function steerSamples(
		server: TestServer,
		count: number,
	): Promise<readonly { answers: number; queued: number }[]> {
		const { app, opened, faux } = server;
		// Turn 1: a long answer streamed slowly (the busy lever). The steered
		// rounds' answers stream slowly TOO: under one-at-a-time the second
		// steer sits queued WHILE the first steered answer runs, and a fast
		// answer closes that window before the 25ms poll can observe it (the
		// racy prior version; the slow stream holds the window open).
		faux.setResponses([
			fauxAssistantMessage("slow streaming first answer ".repeat(12)),
			...Array.from({ length: count }, (_, i) =>
				fauxAssistantMessage(`steered answer ${i} `.repeat(12)),
			),
		]);
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const first = await root.submit(
			{ type: "input", content: "first turn (busy lever)" },
			BACKGROUND_CONTEXT,
		);
		// Submit the steers through the server route; the routes return at
		// admission (§7.1), so they are started (not awaited) while the
		// observation loop watches the inbox.
		const pending = Array.from({ length: count }, (_, i) =>
			app.inject({
				method: "POST",
				url: `/v1/conversations/${root.id}/submissions`,
				payload: { input: `steer ${i}`, whenBusy: "steer" },
				headers: { "content-type": "application/json" },
			}),
		);
		const samples: { answers: number; queued: number }[] = [];
		const deadline = Date.now() + 60_000;
		for (;;) {
			const inbox = await opened.harness.snapshot(
				InboxDoc,
				root.id,
				BACKGROUND_CONTEXT,
			);
			const queued =
				(inbox?.items ?? []).filter((item) => item.mode === "steer").length;
			const view = (
				await app.inject({ method: "GET", url: `/v1/conversations/${root.id}` })
			).json();
			const answers = userAnswersWithText(view, "steered answer").length;
			samples.push({ answers, queued });
			// Done when every submission settled and the inbox drained.
			if (answers >= count && queued === 0) break;
			if (Date.now() > deadline) break;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		const results = await Promise.all(pending);
		for (const result of results) {
			expect(result.statusCode).toBe(202);
			// The §7.1 admission record: queued behind the busy turn (or placed
			// by the boundary) — the settled state is the loop's observable.
			expect(["queued", "placed"]).toContain(
				result.json().submission.status,
			);
		}
		expect((await first.wait(BACKGROUND_CONTEXT)).status).toBe("done");
		return samples;
	}

	/**
	 * The `pi.assistant` entries whose content starts with `prefix` (the
	 * steered rounds' answers) — same string-or-parts handling as the user
	 * matcher.
	 */
	function userAnswersWithText(
		view: { readonly entries: readonly unknown[] },
		prefix: string,
	): readonly unknown[] {
		return (
			view.entries as Array<{
				kind: string;
				model?: { content?: unknown }[];
			}>
		).filter((entry) => {
			if (entry.kind !== "pi.assistant") return false;
			const content = entry.model?.[0]?.content;
			const parts = Array.isArray(content) ? content : [{ text: content }];
			return parts.some((part) =>
				String((part as { text?: string }).text ?? "").startsWith(prefix),
			);
		});
	}

	test(
		'steeringMode "all" (PATCHed through the endpoint): every steer is admitted at the single boundary',
		{ timeout: 90_000 },
		async () => {
			// Auto-naming off (the settings file): the namer would consume a
			// scripted steer answer after the first settle — these tests
			// script exact responses for the steering observable.
			const server = await bootServer({}, { file: '{"namingModel": false}' });
			const patched = await patch(server.app, { steeringMode: "all" });
			expect(patched.statusCode).toBe(200);
			const samples = await steerSamples(server, 2);
			// The binding observable: at NO sample does a steer sit queued
			// while a steered answer exists — the one boundary admitted
			// BOTH steers at once, so the inbox is empty the moment the
			// first steered answer appears.
			const leftover = samples.filter(
				(sample) => sample.answers > 0 && sample.queued > 0,
			);
			expect(leftover).toEqual([]);
			// The DISCRIMINATING shape (round 1): under one-at-a-time the
			// first boundary admits only steer 0 and holds steer 1 queued —
			// a `queued=1, answers=0` sample spanning the whole slow first
			// steered round (probe-observed 2026-10-12); under "all" the
			// queue drops 2→0 at the single boundary, so no such sample can
			// form. (The leftover check alone is vacuous: the view serializer
			// lags the inbox by hundreds of poll cycles — see the
			// default-mode test's comment — so answers-while-queued is never
			// observed even when one-at-a-time held the second steer back;
			// the pre-fix composition passed it with the PATCH inert.)
			const heldBack = samples.filter(
				(sample) => sample.queued === 1 && sample.answers === 0,
			);
			expect(heldBack).toEqual([]);
			// Under true "all" the single boundary merges BOTH steers into ONE
			// assistant round — exactly one steered answer is placed (the
			// second queued faux response is never consumed) and the inbox
			// drains. (The pre-fix `answers === 2` encoding passed only
			// because the PATCH was inert and the harness ran one-at-a-time,
			// one answer per steer.)
			expect(samples[samples.length - 1].answers).toBe(1);
			expect(samples[samples.length - 1].queued).toBe(0);
		},
	);

	test(
		"the default (no PATCH): one-at-a-time — the second steer is STILL QUEUED when the first steered answer lands",
		{ timeout: 90_000 },
		async () => {
			const server = await bootServer({}, { file: '{"namingModel": false}' });
			const samples = await steerSamples(server, 2);
			// The binding observable (the mirror of the "all" test):
			// pi-durable's default one-at-a-time admission holds the second
			// steer for the NEXT boundary, so its durable state transition
			// (queued → consumed) is ordered AFTER the first steered answer's
			// commit: the inbox keeps a steer queued past the first answer's
			// arrival. The sample stream may not catch the overlap — the view
			// serializer lags the entry commit by many poll cycles while the
			// inbox snapshot reads fresh (observed: the inbox drained at the
			// second boundary ~500 samples before the view served the first
			// answer, so answers-then-queued is never SEEN even though the
			// ordering held). The durable artifacts the stream DOES carry
			// discriminate the modes honestly:
			// (1) the second steer sat queued for many samples — the first
			//     boundary consumed only steer 0 and held steer 1 back (under
			//     "all" the queue is empty the moment the first round commits,
			//     so a post-"1a" queued tail cannot form);
			// (2) both rounds ran and the inbox drained (the routes settled).
			const firstAnswerAt = samples.findIndex((sample) => sample.answers > 0);
			expect(firstAnswerAt).toBeGreaterThan(0);
			const holdback = samples
				.slice(0, firstAnswerAt)
				.filter((sample) => sample.queued > 0).length;
			expect(holdback).toBeGreaterThan(0);
			// Both ran eventually (the routes settled done).
			expect(samples[samples.length - 1].answers).toBe(2);
			expect(samples[samples.length - 1].queued).toBe(0);
		},
	);

	test(
		'the openHarness caller seam wins over the settings file: file "one-at-a-time" + options.settings "all" admits "all"',
		{ timeout: 90_000 },
		async () => {
			const server = await bootServer(
				{},
				{
					file: '{"steeringMode": "one-at-a-time", "namingModel": false}',
					settings: { steeringMode: "all" },
				},
			);
			// The file really says one-at-a-time (the store serves it back) —
			// the harness must NOT obey it where the seam overrides the field.
			const fileView = await server.app.inject({
				method: "GET",
				url: "/v1/settings",
			});
			expect(fileView.json()).toEqual(
				expect.objectContaining({ steeringMode: "one-at-a-time" }),
			);
			const samples = await steerSamples(server, 2);
			// "all" admission: both steers admitted at the single boundary —
			// no held-back sample (queued=1 while answers=0, the
			// one-at-a-time signature this file would otherwise impose).
			const heldBack = samples.filter(
				(sample) => sample.queued === 1 && sample.answers === 0,
			);
			expect(heldBack).toEqual([]);
			// True "all" end-state: both steers merged into ONE assistant round
			// (one steered answer), inbox drained — versus this file's
			// one-at-a-time, which would hold a steer back AND run two rounds.
			expect(samples[samples.length - 1].answers).toBe(1);
			expect(samples[samples.length - 1].queued).toBe(0);
		},
	);
});

describe("defaultTools and perModelThinking (the sigrun-resolved fields)", () => {
	test("defaultTools filters the created conversation's tools (server create)", async () => {
		const { app, opened } = await bootServer();
		const patched = await patch(app, {
			defaultTools: ["read", "bash"],
		});
		expect(patched.statusCode).toBe(200);
		// The server route applies the store's tool filter at create
		// (storeAgentChange) — resolve the agent and check the selection.
		const response = await app.inject({
			method: "POST",
			url: "/v1/conversations",
			payload: {},
			headers: { "content-type": "application/json" },
		});
		expect(response.statusCode).toBe(201);
		const { id } = response.json() as { id: number };
		const conversation = await opened.harness.conversation(
			id as ConversationId,
			BACKGROUND_CONTEXT,
		);
		expect(conversation).toBeDefined();
		const agent = await conversation!.agent(BACKGROUND_CONTEXT);
		// Exactly the filter's names, in filter order (pi-durable resolves
		// the stored name array against the composed selection).
		expect(agent.tools.map((tool) => tool.name)).toEqual(["read", "bash"]);
		// And unPATCHed settings (an absent file) leave every tool on:
		// a second server booted with no file sees all core and built-in tools.
		const bare = await bootServer();
		const created = await bare.app.inject({
			method: "POST",
			url: "/v1/conversations",
			payload: {},
			headers: { "content-type": "application/json" },
		});
		const conv = await bare.opened.harness.conversation(
			(created.json() as { id: number }).id as ConversationId,
			BACKGROUND_CONTEXT,
		);
		const fullAgent = await conv!.agent(BACKGROUND_CONTEXT);
		// Core tools, load_skill, and the gateway's two agent tools — the
		// no-filter default for a built-in install.
		expect(fullAgent.tools.map((tool) => tool.name).sort()).toEqual([
			"bash",
			"edit",
			"find",
			"grep",
			"list_chats",
			"load_skill",
			"ls",
			"read",
			"send_message",
			"write",
		]);
	});

	test("perModelThinking applies at create and at configure", async () => {
		const { app, opened } = await bootServer();
		const patched = await patch(app, {
			perModelThinking: { "faux/m": "high" },
		});
		expect(patched.statusCode).toBe(200);
		const response = await app.inject({
			method: "POST",
			url: "/v1/conversations",
			payload: {},
			headers: { "content-type": "application/json" },
		});
		const { id } = response.json() as { id: number };
		const conversation = await opened.harness.conversation(
			id as ConversationId,
			BACKGROUND_CONTEXT,
		);
		expect((await conversation!.agent(BACKGROUND_CONTEXT)).thinkingLevel).toBe(
			"high",
		);
		// configure: a model change WITHOUT an explicit thinking re-applies
		// the map's override for the NEW model; an explicit thinking wins.
		const configured = await app.inject({
			method: "POST",
			url: `/v1/conversations/${id}/configure`,
			payload: { model: "faux/m", thinking: "low" },
			headers: { "content-type": "application/json" },
		});
		expect(configured.json().thinkingLevel).toBe("low");
	});

	test("defaultTools maps to the MODEL-OFFERED filter (modelTools, not tools)", async () => {
		const { app, opened } = await bootServer();
		const patched = await patch(app, { defaultTools: ["read"] });
		expect(patched.statusCode).toBe(200);
		const response = await app.inject({
			method: "POST",
			url: "/v1/conversations",
			payload: {},
			headers: { "content-type": "application/json" },
		});
		expect(response.statusCode).toBe(201);
		const { id } = response.json() as { id: number };
		const conversation = await opened.harness.conversation(
			id as ConversationId,
			BACKGROUND_CONTEXT,
		);
		const agent = await conversation!.agent(BACKGROUND_CONTEXT);
		// The offered set is exactly the filter (1.3.0's modelTools array
		// form: "exactly these, in order")...
		expect(agent.tools.map((tool) => tool.name)).toEqual(["read"]);
		// ...and the filter is the MODEL-offered one, not the ENABLED one:
		// bash stays enabled for nested calls (`agent.callable`) — a
		// `tools` emit would have DISABLED it (callable = [read] only).
		// This is the two-layer-filter ruling's observable.
		expect(agent.callable.map((tool) => tool.name)).toContain("bash");
	});

	test("hazard pin: a control.addTools-loaded deferred tool survives a settings re-write and a configure (no re-apply path)", async () => {
		const { app, opened, faux } = await bootServer();
		// The probe pair rides the live registry (the tool_search mechanism).
		opened.registry.install({
			name: "test.probe-tools",
			tools: [deferredProbeTool, loaderProbeTool],
		});
		// modelTools set at create; the loader is offered so the faux model
		// can call it.
		const patched = await patch(app, {
			defaultTools: ["read", "probe_loader"],
		});
		expect(patched.statusCode).toBe(200);
		const response = await app.inject({
			method: "POST",
			url: "/v1/conversations",
			payload: {},
			headers: { "content-type": "application/json" },
		});
		expect(response.statusCode).toBe(201);
		const { id } = response.json() as { id: number };
		const conversation = (await opened.harness.conversation(
			id as ConversationId,
			BACKGROUND_CONTEXT,
		))!;
		// Before the load: the deferred tool is enabled but not offered.
		const before = await conversation.agent(BACKGROUND_CONTEXT);
		expect(before.tools.map((tool) => tool.name)).not.toContain(
			"probe_deferred",
		);
		expect(before.deferred.map((tool) => tool.name)).toContain(
			"probe_deferred",
		);
		// Drive the load through a REAL tool round: the faux model calls the
		// loader, whose result control.addTools-loads the deferred probe
		// (pi-durable appends the name to the stored modelTools array).
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("probe_loader", {}, { id: "call-load" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("loaded"),
		]);
		const submission = await conversation.submit(
			{ type: "input", content: [{ type: "text", text: "load the probe" }] },
			BACKGROUND_CONTEXT,
		);
		expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe("done");
		const loaded = await conversation.agent(BACKGROUND_CONTEXT);
		expect(loaded.tools.map((tool) => tool.name)).toContain(
			"probe_deferred",
		);
		expect(loaded.deferred.map((tool) => tool.name)).not.toContain(
			"probe_deferred",
		);
		// The hazard levers, BOTH fired: a settings re-write (the panel's
		// save — the write that re-resolves the store's defaultTools) and a
		// configure (a model change, the path that re-applies
		// perModelThinking). Neither may re-apply the store's filter to the
		// LIVE conversation — a fresh array emit would drop the loaded name.
		// SETTLED by reading the code: storeAgentChange runs at CREATES only;
		// configure passes only model/thinkingLevel; this test is the pin.
		const rewritten = await patch(app, {
			defaultTools: ["read", "probe_loader"],
		});
		expect(rewritten.statusCode).toBe(200);
		const configured = await app.inject({
			method: "POST",
			url: `/v1/conversations/${id}/configure`,
			payload: { model: "faux/m" },
			headers: { "content-type": "application/json" },
		});
		expect(configured.statusCode).toBe(200);
		const after = await conversation.agent(BACKGROUND_CONTEXT);
		expect(after.tools.map((tool) => tool.name)).toContain(
			"probe_deferred",
		);
		expect(after.deferred.map((tool) => tool.name)).not.toContain(
			"probe_deferred",
		);
	});
});

describe("GET /v1/settings toolRoster", () => {
	test("serves the live registry's tool names (the panel roster)", async () => {
		const { app, opened } = await bootServer();
		// A registry install AFTER boot must be reflected — the roster is
		// computed per request from the live snapshot, never snapshotted at
		// boot (Tasks 5-7 extension tools appear without panel changes).
		opened.registry.install({
			name: "test.probe-tools",
			tools: [deferredProbeTool, loaderProbeTool],
		});
		const response = await app.inject({ method: "GET", url: "/v1/settings" });
		expect(response.statusCode).toBe(200);
		const body = response.json() as { toolRoster?: string[] };
		expect(body.toolRoster).toBeDefined();
		// The composed tool set: core names (incl. the skills convention's
		// load_skill) plus the just-installed probes.
		expect(body.toolRoster).toEqual(
			expect.arrayContaining([
				"read",
				"bash",
				"load_skill",
				"probe_deferred",
				"probe_loader",
			]),
		);
	});
});
describe("PATCH /v1/settings admin gate (core hardening W1 final review)", () => {
	/**
	 * A token-method boot with TWO directory users: `tester` (admin, the
	 * seed) and `pleb` (non-admin, added here). PATCH /v1/settings is
	 * admin-only (spec §5.6 — it edits `extensions[]`, which is code
	 * execution at next boot); GET stays open to any authenticated user.
	 */
	async function bootTokenServer(): Promise<{
		app: FastifyInstance;
		plebToken: string;
		adminToken: string;
	}> {
		const { app, opened } = await bootServer({ SIGRUN_AUTH: "token" });
		await opened.identity.users.add({
			user: "pleb",
			admin: false,
			source: "cli",
		});
		const { token: plebToken } = await opened.identity.tokens.create(
			"pleb-cli",
			"pleb",
		);
		const { token: adminToken } = await opened.identity.tokens.create(
			"tester-cli",
			"tester",
		);
		return { app, plebToken, adminToken };
	}

	test("a non-admin token PATCH → 403 {error: forbidden}, nothing applied", async () => {
		const { app, plebToken } = await bootTokenServer();
		const response = await app.inject({
			method: "PATCH",
			url: "/v1/settings",
			headers: { authorization: `Bearer ${plebToken}` },
			payload: { steeringMode: "all" },
		});
		expect(response.statusCode).toBe(403);
		expect(response.json()).toEqual({ error: "forbidden" });
		// The rejection precedes the store: nothing was applied.
		const after = await app.inject({
			method: "GET",
			url: "/v1/settings",
			headers: { authorization: `Bearer ${plebToken}` },
		});
		expect((after.json() as { steeringMode?: unknown }).steeringMode).toBe(
			undefined,
		);
	});

	test("an admin token PATCH → 200 (the operator path unchanged)", async () => {
		const { app, adminToken } = await bootTokenServer();
		const response = await app.inject({
			method: "PATCH",
			url: "/v1/settings",
			headers: { authorization: `Bearer ${adminToken}` },
			payload: { steeringMode: "all" },
		});
		expect(response.statusCode).toBe(200);
		expect((response.json() as { steeringMode?: unknown }).steeringMode).toBe(
			"all",
		);
	});

	test("GET stays open to the non-admin (spec gates PATCH only)", async () => {
		const { app, plebToken } = await bootTokenServer();
		const response = await app.inject({
			method: "GET",
			url: "/v1/settings",
			headers: { authorization: `Bearer ${plebToken}` },
		});
		expect(response.statusCode).toBe(200);
	});

	test("GET /v1/settings/sections stays open to a non-admin (the panel's client prefs die with a 403); the admin-only surfaces still gate", async () => {
		const { app, plebToken } = await bootTokenServer();
		const list = await app.inject({
			method: "GET",
			url: "/v1/settings/sections",
			headers: { authorization: `Bearer ${plebToken}` },
		});
		expect(list.statusCode).toBe(200);
		const body = list.json() as {
			sections: { slug: string; id: string }[];
		};
		// The whole list serves (the Interface section the prefs ride
		// included) — per-section surfaces keep their own gates.
		expect(body.sections.length).toBeGreaterThan(0);
		// A non-admin's read of an admin section's surface 404s (the
		// access gate maps access:none to surface_not_found).
		const surface = await app.inject({
			method: "GET",
			url: "/v1/ext/core/surfaces/general",
			headers: { authorization: `Bearer ${plebToken}` },
		});
		expect(surface.statusCode).toBe(404);
	});
});
