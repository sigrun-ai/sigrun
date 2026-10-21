/**
 * The interaction-seam decide round-trip e2e (spec slice 3): a gated
 * tool call PROMPTS, the human
 * answers through the ONE generic answer route, and the held call
 * resolves from the answer — allow runs the tool, deny refuses it.
 *
 * TWO cases, split by ownership (core hardening task 3):
 *
 * 1. **The decide flow (CORE's guarantee, always runs).** The gate
 *    lives in an IN-REPO fixture (`test/fixtures/fixture-gate/`) loaded
 *    through the real loader with the host context — no sibling-repo
 *    dependency. The proof: a faux model calls `guarded_write`
 *    directly; the run pauses with ONE pending interaction (the seam
 *    record the server lists); `POST …/interactions/:callId/answer`
 *    with `{ids:["allow"]}` runs the tool (the marker
 *    `guarded-write-executed` appears in the tool result) and the
 *    submission settles. A second run answered `deny` returns the
 *    refusal and the marker is ABSENT.
 *
 * 2. **The codemode-nesting case (a CODEMODE guarantee).** A gated
 *    tool called from inside a codemode script still prompts — the
 *    nested `executeTool` runs the ToolTask `beforeTool` hooks, which
 *    is the whole point of the pi-durable 1.2.0 upgrade. This depends
 *    on the sibling sigrun-ext-codemode checkout, so it runs only when
 *    that dist EXISTS (`describe.runIf`); it moves to
 *    sigrun-ext-codemode's own suite once sigrun is published. The
 *    skip path is exercisable with `SIGRUN_TEST_HIDE_SIBLINGS=1`.
 *
 * Case 2 is a PARITY LOCK on shipped behavior (the pieces exist:
 * pi-durable 1.3.0 + the fixture gate + the codemode extension), not
 * new behavior — its value is that it fails if any layer stops routing
 * nested calls through the hooks.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxToolCall,
	fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import {
	createRegistry,
	defineExtension,
	defineTool,
	Harness,
	type ModelRef,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createModels } from "@earendil-works/pi-ai/models";
import { Type } from "@earendil-works/pi-ai";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import { createServer } from "../src/server/index.js";
import { seededIdentity } from "./helpers/identity.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import type { FastifyInstance } from "fastify";

// ─── Case 1's fixture (in-repo, loaded by file URL) ──────────────────────
const GATE_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-gate", "index.js"),
).href;

// ─── Case 2's sibling (the codemode dist; skip when absent) ──────────────
// The worktree sits two levels deeper than the sibling checkouts, hence
// two `..` segments from the test dir. Static TS imports can't resolve
// outside the package root, so the dist loads at runtime via dynamic
// import with a computed specifier.
const CODEMODE_PATH = join(
	import.meta.dirname,
	"../../sigrun-ext-codemode/dist/index.js",
);
const CODEMODE_PRESENT =
	existsSync(CODEMODE_PATH) &&
	process.env.SIGRUN_TEST_HIDE_SIBLINGS !== "1";
if (!CODEMODE_PRESENT) {
	console.info(
		`interaction-decide: skipping the codemode-nesting case — ` +
			`sigrun-ext-codemode dist not found at ${CODEMODE_PATH} ` +
			`(or SIGRUN_TEST_HIDE_SIBLINGS=1)`,
	);
}

/** The codemode wiring (the loader-shaped factory, called directly). */
type CodemodeWiring = {
	extension: import("@earendil-works/pi-durable").Extension<
		import("@earendil-works/pi-durable").ToolRegistration
	>;
	close?: () => Promise<void>;
};
let createCodemodeWiring: () => CodemodeWiring;

beforeAll(async () => {
	if (!CODEMODE_PRESENT) return;
	const codemodeMod = (await import(CODEMODE_PATH)) as unknown as {
		createCodemodeWiring: () => CodemodeWiring;
	};
	({ createCodemodeWiring } = codemodeMod);
});

// ─── Case 1: the decide flow (always runs) ───────────────────────────────

interface TestServer {
	app: FastifyInstance;
	opened: OpenedHarness;
	/** The faux provider (tests script both runs' responses). */
	faux: ReturnType<typeof fauxProvider>;
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

/** Boot the real server with the fixture gate loaded via the loader. */
async function bootGateServer(): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-gate-"));
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
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
	// Same disable as the other server suites: exact-response scripts,
	// no auto-naming calls.
	await writeFile(join(dir, "settings.json"), '{"namingModel": false}');
	const opened = await openHarness(config, {
		identity: await seededIdentity(dir),
		extensions: [contributor],
		env: {},
		extensionSpecifiers: [GATE_SPECIFIER],
		settingsDir: dir,
	});
	const app = await createServer(opened, {
		...config,
		webui: { ...config.webui, enabled: false },
	});
	const teardown = async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	};
	cleanups.push(teardown);
	return { app, opened, faux };
};

/** One pending interaction on the list route, or none yet. */
async function pendingInteraction(
	app: FastifyInstance,
	id: number,
): Promise<{ callId: string; kind: string } | undefined> {
	const list = await app.inject({
		method: "GET",
		url: `/v1/conversations/${id}/interactions`,
	});
	expect(list.statusCode).toBe(200);
	const listed = list.json().interactions as {
		callId: string;
		kind: string;
	}[];
	return listed[0];
}

/** The guarded_write tool-result entry, as the §5 view serializes it. */
async function guardedResult(
	app: FastifyInstance,
	id: number,
): Promise<{ content: { type: string; text?: string }[]; isError?: boolean } | undefined> {
	const view = (
		await app.inject({ method: "GET", url: `/v1/conversations/${id}` })
	).json();
	const entries = view.entries as {
		kind: string;
		model?: {
			role: string;
			toolName?: string;
			isError?: boolean;
			content: { type: string; text?: string }[];
		}[];
	}[];
	for (const entry of entries) {
		if (entry.kind !== "pi.tool-result") continue;
		const message = entry.model?.find(
			(candidate) =>
				candidate.role === "toolResult" &&
				candidate.toolName === "guarded_write",
		);
		if (message !== undefined) return message;
	}
	return undefined;
}

test("a gated tool call prompts; answering allow through the route runs the tool", { timeout: 60_000 }, async () => {
	const { app, opened, faux } = await bootGateServer();
	// The model calls the gated tool directly; the post-tools message
	// closes the run.
	faux.setResponses([
		fauxAssistantMessage(
			[fauxToolCall("guarded_write", { path: "notes.txt" })],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("done after the tool"),
	]);
	const root = await opened.harness.root(BACKGROUND_CONTEXT, {
		agent: { model: opened.defaultModel },
	});
	const submission = await app.inject({
		method: "POST",
		url: `/v1/conversations/${root.id}/submissions`,
		payload: { input: "run the gated tool" },
		headers: { "content-type": "application/json" },
	});
	expect(submission.statusCode).toBe(202);

	// The gate holds the call: exactly ONE pending interaction, in
	// today's format (allow/deny options), keyed by the tool call id.
	const deadline = Date.now() + 30_000;
	let pending: { callId: string; kind: string } | undefined;
	while (pending === undefined && Date.now() < deadline) {
		pending = await pendingInteraction(app, root.id);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	expect(pending).toBeDefined();
	expect(pending?.kind).toBe("gate.ask");
	const listed = (
		await app.inject({
			method: "GET",
			url: `/v1/conversations/${root.id}/interactions`,
		})
	).json().interactions;
	expect(listed).toHaveLength(1);
	expect(listed[0]).toMatchObject({
		kind: "gate.ask",
		callId: pending!.callId,
		body: {
			text: expect.any(String) as unknown,
			options: [
				{ id: "allow", tone: "ok" },
				{ id: "deny", tone: "danger" },
			],
		},
	});

	// Answer allow through the ONE generic route.
	const answer = await app.inject({
		method: "POST",
		url: `/v1/conversations/${root.id}/interactions/${pending!.callId}/answer`,
		payload: { ids: ["allow"] },
		headers: { "content-type": "application/json" },
	});
	expect(answer.statusCode).toBe(200);
	expect(answer.json()).toMatchObject({
		callId: pending!.callId,
		status: "answered",
		answer: { ids: ["allow"] },
	});

	// The submission settles; the tool ran and its marker is in the
	// tool result; the pending record is gone.
	const handle = await opened.harness.submission(
		submission.json().submission.id as never,
		BACKGROUND_CONTEXT,
	);
	const settled = await handle?.wait(BACKGROUND_CONTEXT);
	expect(settled?.status).toBe("done");
	const result = await guardedResult(app, root.id);
	expect(result).toBeDefined();
	expect(result?.isError).not.toBe(true);
	expect(
		result?.content.some((block) =>
			block.text?.includes("guarded-write-executed:notes.txt"),
		),
	).toBe(true);
	expect(await pendingInteraction(app, root.id)).toBeUndefined();
});

test("a second run answered deny returns the refusal; the marker is absent", { timeout: 60_000 }, async () => {
	const { app, opened, faux } = await bootGateServer();
	faux.setResponses([
		fauxAssistantMessage(
			[fauxToolCall("guarded_write", { path: "secret.txt" })],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("done after the refusal"),
	]);
	const root = await opened.harness.root(BACKGROUND_CONTEXT, {
		agent: { model: opened.defaultModel },
	});
	const submission = await app.inject({
		method: "POST",
		url: `/v1/conversations/${root.id}/submissions`,
		payload: { input: "run the gated tool again" },
		headers: { "content-type": "application/json" },
	});
	expect(submission.statusCode).toBe(202);

	// Wait for the pending gate record.
	const deadline = Date.now() + 30_000;
	let pending: { callId: string } | undefined;
	while (pending === undefined && Date.now() < deadline) {
		pending = await pendingInteraction(app, root.id);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	expect(pending).toBeDefined();

	// Answer DENY: the hook returns the refusal; the tool never runs.
	const answer = await app.inject({
		method: "POST",
		url: `/v1/conversations/${root.id}/interactions/${pending!.callId}/answer`,
		payload: { ids: ["deny"] },
		headers: { "content-type": "application/json" },
	});
	expect(answer.statusCode).toBe(200);

	const handle = await opened.harness.submission(
		submission.json().submission.id as never,
		BACKGROUND_CONTEXT,
	);
	const settled = await handle?.wait(BACKGROUND_CONTEXT);
	expect(settled?.status).toBe("done");

	// The refusal rides the tool result: an error result whose text
	// carries the deny reason, and the marker is ABSENT.
	const result = await guardedResult(app, root.id);
	expect(result).toBeDefined();
	expect(result?.isError).toBe(true);
	const text = (result?.content ?? [])
		.map((block) => block.text ?? "")
		.join("\n");
	expect(text).toContain("denied by the answering user");
	expect(text).not.toContain("guarded-write-executed");
	// And the pending record is gone.
	expect(await pendingInteraction(app, root.id)).toBeUndefined();
});

// ─── Case 2: the codemode-nesting parity lock (sibling-gated) ────────────

describe.runIf(CODEMODE_PRESENT)(
	"codemode nesting (sibling present)",
	() => {
		/** A marker the guarded tool's execute writes into the script's result. */
		const GUARDED_MARKER = "guarded-write-executed";

		test("a gated tool called from a codemode script PROMPTS, then runs after allow", { timeout: 60_000 }, async () => {
			const dir = await mkdtemp(
				join(tmpdir(), "sigrun-interaction-decide-"),
			);
			const workspace = join(dir, "workspace");
			const { mkdir } = await import("node:fs/promises");
			await mkdir(workspace, { recursive: true });

			// The fixture gate is loaded DIRECTLY (registry install) for this
			// case: the nesting mechanism needs a real Harness, not the server
			// surface, and the hook's seeding goes through a minimal host
			// stand-in that records what the gate surfaces.
			const surfaced: { callId: string; toolName: string }[] = [];
			// The allow-on-decide stand-in: decide() flips the snapshot answer.
			let decision: "allow" | "deny" | undefined;
			const host = {
				async seedInteraction(
					_conversationId: unknown,
					record: {
						callId: string;
						details?: { toolName?: string } | null;
					},
				) {
					if (!surfaced.some((item) => item.callId === record.callId)) {
						surfaced.push({
							callId: record.callId,
							toolName: record.details?.toolName ?? "",
						});
					}
				},
				async snapshotInteraction(
					_conversationId: unknown,
					_callId: string,
				): Promise<
						| { status: string; answer?: { ids?: string[] } }
					| undefined
				> {
					if (decision === undefined) return undefined;
					return { status: "answered", answer: { ids: [decision] } };
				},
			};
			const gateFixture = (await import(GATE_SPECIFIER)) as unknown as {
				default: (host: unknown) => {
					extension: import("@earendil-works/pi-durable").Extension<
						import("@earendil-works/pi-durable").ToolRegistration
					>;
				};
			};
			const gate = gateFixture.default(host);

			// Whether the gated tool's execute has run — the gate must hold it.
			let guardedRan = false;
			const guardedWrite = defineTool({
				name: "guarded_write",
				description:
					"Gated test tool: the gate must hold this until decided.",
				parameters: Type.Object({
					path: Type.String({
						description: "Path the tool pretends to write.",
					}),
				}),
				async execute(args: { path: string }) {
					guardedRan = true;
					return {
						output: [
							{
								type: "text" as const,
								text: `${GUARDED_MARKER}:${args.path}`,
							},
						],
					};
				},
			});
			const guardedExtension = defineExtension({
				name: "sigrun.test-guarded",
				tools: [guardedWrite],
			});

			const codemode = createCodemodeWiring();

			const fauxProviderModule = await import(
				"@earendil-works/pi-ai/providers/faux"
			);
			const faux = fauxProviderModule.fauxProvider({
				provider: "faux",
				models: [{ id: "m", contextWindow: 128_000 }],
			});
			faux.setResponses([
				fauxAssistantMessage(
					fauxToolCall(
						"codemode",
						{
							code: 'const r = await tools.guarded_write({ path: "notes.txt" });\nreturn `script got: ${r}`;',
						},
						{ id: "call-1" },
					),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done after script"),
			]);
			const models = createModels();
			models.setProvider(faux.provider);
			const defaultModel: ModelRef = { provider: "faux", modelId: "m" };

			const registry = createRegistry();
			registry.install(codemode.extension);
			registry.install(gate.extension);
			registry.install(guardedExtension);

			const harness = await Harness.open(
				await openNodeSqliteStorage(join(dir, "sigrun.db")),
				{
					models,
					registry,
					env: () => new NodeExecutionEnv({ cwd: workspace }),
				},
				BACKGROUND_CONTEXT,
			);
			try {
				harness.resume();
				const root = await harness.root(BACKGROUND_CONTEXT, {
					agent: { model: defaultModel },
				});
				const submission = await root.submit(
					{ type: "input", content: "run the script" },
					BACKGROUND_CONTEXT,
				);

				// The gate holds the nested call: wait for the surface to see
				// it (the hook polls every 25ms; the sink fires once).
				const waitDeadline = Date.now() + 30_000;
				while (surfaced.length === 0 && Date.now() < waitDeadline) {
					await new Promise((resolve) => setTimeout(resolve, 25));
				}
				expect(surfaced).toHaveLength(1);
				expect(surfaced[0]?.toolName).toBe("guarded_write");
				// Parent linkage: a nested call's id embeds its parent call's
				// id (`<parentCallId>/<key>`), so a "/" proves the call
				// arrived at the hook WITH its parent — the codemode call.
				expect(surfaced[0]?.callId).toContain("/");
				// The whole point: the gated tool has NOT executed while pending.
				expect(guardedRan).toBe(false);

				// Decide allow, and the held call proceeds; the submission
				// settles.
				decision = "allow";
				const settled = await submission.wait(BACKGROUND_CONTEXT);
				expect(settled.status).toBe("done");
				await root.waitForIdle(BACKGROUND_CONTEXT);

				// The tool ran, and the script received its result.
				expect(guardedRan).toBe(true);
				const page = await root.entries(
					{},
					50,
					undefined,
					BACKGROUND_CONTEXT,
				);
				const transcript = JSON.stringify(page.items);
				const codemodeResult = page.items.find((entry) =>
					entry.model?.some(
						(message) =>
							(message as { role?: string; toolName?: string })
								.role === "toolResult" &&
							(message as { role?: string; toolName?: string })
								.toolName === "codemode",
					),
				);
				expect(codemodeResult).toBeDefined();
				const message = codemodeResult!.model![0] as {
					isError: boolean;
					content: { type: string; text?: string }[];
				};
				expect(message.isError).toBe(false);
				expect(
					message.content.some((block) =>
						block.text?.includes(
							`script got: ${GUARDED_MARKER}:notes.txt`,
						),
					),
				).toBe(true);
				// Belt: the transcript carries the nested call too.
				expect(transcript).toContain("guarded_write");
			} finally {
				await harness.close(BACKGROUND_CONTEXT).catch(() => undefined);
				await codemode.close?.().catch(() => undefined);
				await rm(dir, { recursive: true, force: true });
			}
		});
	},
);
