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
 *    record the server lists — a root-form block tree); `POST
 *    …/interactions/:callId/answer` with `{values: {decision: "allow",
 *    reason: "ok"}}` runs the tool (the marker
 *    `guarded-write-executed` appears in the tool result) and the
 *    submission settles. A second run answered `deny` returns the
 *    refusal and the marker is ABSENT.
 *
 * 2. **The codemode-nesting case (a CODEMODE guarantee).** A gated
 *    tool called from inside a codemode script still prompts — the
 *    nested `executeTool` runs the ToolTask `beforeTool` hooks, which
 *    is the whole point of the pi-durable 1.2.0 upgrade. Since Task 2
 *    the codemode extension is a core `node_modules` dependency (the
 *    built-in), so this case ALWAYS runs — no sibling-checkout gating.
 *
 * Case 2 is a PARITY LOCK on shipped behavior (the pieces exist:
 * pi-durable 1.3.0 + the fixture gate + the codemode extension), not
 * new behavior — its value is that it fails if any layer stops routing
 * nested calls through the hooks.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test, vi } from "vitest";
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

/** The seam fixture (Task 2's answer-route cases seed through its host). */
const SEAM_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-seam", "index.js"),
).href;

// ─── Case 2's codemode (a core node_modules dependency — Task 2) ────────
// The built-in codemode extension resolves from core's own tree, so the
// import is a plain static one and the case always runs.
import { createCodemodeWiring } from "@sigrun/ext-codemode";

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
		// Both fixtures: the gate (the decide flow) and the seam host
		// (the Task 2 answer-route cases seed through it).
		extensionSpecifiers: [GATE_SPECIFIER, SEAM_SPECIFIER],
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

	// The gate holds the call: exactly ONE pending interaction, a root
	// form with a choice named `decision` (tones good/bad — the renames),
	// keyed by the tool call id.
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
			v: 1,
			root: {
				type: "form",
				children: [
					{
					type: "choice",
					name: "decision",
					options: [
						{ id: "allow", tone: "good" },
						{ id: "deny", tone: "bad" },
					],
				},
				{ type: "longtext", name: "reason" },
				],
			},
		},
	});

	// Answer allow through the ONE generic route: {values} (ruling 20).
	const answer = await app.inject({
		method: "POST",
		url: `/v1/conversations/${root.id}/interactions/${pending!.callId}/answer`,
		payload: { values: { decision: "allow", reason: "ok" } },
		headers: { "content-type": "application/json" },
	});
	expect(answer.statusCode).toBe(200);
	expect(answer.json()).toMatchObject({
		callId: pending!.callId,
		status: "answered",
		answer: { values: { decision: "allow", reason: "ok" } },
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
		payload: { values: { decision: "deny", reason: "not this one" } },
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

// ─── U6 Task 2: the {values} answer route's focus cases ─────────────────

describe("the answer route (ruling 20: {values} only)", () => {
	/** Seed one pending fixture.ask record through the seam host. */
	async function seedAsk(
		opened: OpenedHarness,
		conversationId: number,
		callId: string,
		body?: import("@sigrun/shared/blocks").Tree,
	): Promise<void> {
		const host = opened.seamHosts.get("sigrun-fixture-seam");
		if (host === undefined) throw new Error("fixture-seam host missing");
		await host.seedInteraction(
			conversationId as never,
			{
				kind: "fixture.ask",
				callId,
				status: "pending",
				createdAt: 1,
				...(body === undefined ? {} : { body }),
			},
			BACKGROUND_CONTEXT,
		);
	}

	test("two concurrent POSTs: one 200, one 404 not_pending; a GET returns the winning answer (Review Focus 1)", { timeout: 30_000 }, async () => {
		const { app, opened } = await bootGateServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT);
		await seedAsk(opened, root.id, "rf1");
		// Two answers race: the route's commit serializes them (the
		// mutation line), so exactly one wins — first-answer-wins.
		const [a, b] = await Promise.all([
			app.inject({
				method: "POST",
				url: `/v1/conversations/${root.id}/interactions/rf1/answer`,
				payload: { values: { decision: "allow" } },
				headers: { "content-type": "application/json" },
			}),
			app.inject({
				method: "POST",
				url: `/v1/conversations/${root.id}/interactions/rf1/answer`,
				payload: { values: { decision: "deny" } },
				headers: { "content-type": "application/json" },
			}),
		]);
		const statuses = [a.statusCode, b.statusCode].sort();
		expect(statuses).toEqual([200, 404]);
		const loser = a.statusCode === 404 ? a : b;
		expect(loser.json()).toEqual({ error: "not_pending" });
		// A GET of the record afterwards returns the WINNING answer —
		// the single-record read (any status), not the pending-only list.
		const read = await app.inject({
			method: "GET",
			url: `/v1/conversations/${root.id}/interactions/rf1`,
		});
		expect(read.statusCode).toBe(200);
		expect(read.json()).toMatchObject({
			callId: "rf1",
			status: "answered",
			answer: { values: { decision: "allow" } },
		});
	});

	test("an unknown callId 404s on the single-record GET too (indistinguishable)", { timeout: 30_000 }, async () => {
		const { app, opened } = await bootGateServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT);
		const read = await app.inject({
			method: "GET",
			url: `/v1/conversations/${root.id}/interactions/nope`,
		});
		expect(read.statusCode).toBe(404);
		expect(read.json()).toEqual({ error: "no_such_interaction" });
	});

	test("a settled record's GET shows the expired status (the refetch path)", { timeout: 30_000 }, async () => {
		const { app, opened } = await bootGateServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT);
		await seedAsk(opened, root.id, "rf1-exp");
		const host = opened.seamHosts.get("sigrun-fixture-seam");
		if (host === undefined) throw new Error("fixture-seam host missing");
		const settled = await host.settleInteraction(
			root.id as never,
			"rf1-exp",
			"expired",
			BACKGROUND_CONTEXT,
		);
		expect(settled).toBe(true);
		const read = await app.inject({
			method: "GET",
			url: `/v1/conversations/${root.id}/interactions/rf1-exp`,
		});
		expect(read.statusCode).toBe(200);
		expect(read.json()).toMatchObject({
			callId: "rf1-exp",
			status: "expired",
		});
	});
});

describe("secret answers (Review Focus 4)", () => {
	/** The literal that replaces a secret value in the stored record. */
	const MASK = "[secret]";
	/** A synthetic token value — the test owns its literals. */
	const TOKEN = "tok-acme-not-a-real-credential";

	/** A form tree with a secret field named `token`. */
	function secretTree(): import("@sigrun/shared/blocks").Tree {
		return {
			v: 1,
			root: {
				type: "form",
				id: "creds",
				bind: "/values",
				mode: "submit",
				children: [
					{ type: "secret", name: "token", label: "API token" },
					{ type: "text", name: "account", label: "Account" },
				],
			},
		};
	}

	test("the extension sees the value; GET shows [secret]; the log never contains it", { timeout: 30_000 }, async () => {
		const { app, opened } = await bootGateServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT);
		const host = opened.seamHosts.get("sigrun-fixture-seam");
		if (host === undefined) throw new Error("fixture-seam host missing");
		await host.seedInteraction(
			root.id as never,
			{
				kind: "fixture.ask",
				callId: "rf4",
				status: "pending",
				createdAt: 1,
				body: secretTree(),
			},
			BACKGROUND_CONTEXT,
		);
		// Capture every console output while the answer lands — the value
		// must survive NOWHERE but the extension's in-process read.
		const warned: string[] = [];
		const errored: string[] = [];
		const logged: string[] = [];
		const warnSpy = vi.spyOn(console, "warn").mockImplementation((...a) => {
			warned.push(a.map(String).join(" "));
		});
		const errorSpy = vi.spyOn(console, "error").mockImplementation((...a) => {
			errored.push(a.map(String).join(" "));
		});
		const logSpy = vi.spyOn(console, "log").mockImplementation((...a) => {
			logged.push(a.map(String).join(" "));
		});
		try {
			const answer = await app.inject({
				method: "POST",
				url: `/v1/conversations/${root.id}/interactions/rf4/answer`,
				payload: { values: { token: TOKEN, account: "acme" } },
				headers: { "content-type": "application/json" },
			});
			expect(answer.statusCode).toBe(200);
			// The HTTP answer response shows the MASK, not the value.
			expect(answer.json()).toMatchObject({
				callId: "rf4",
				status: "answered",
				answer: { values: { token: MASK, account: "acme" } },
			});
			// GET (single record + list): the stored record shows the MASK.
			const read = await app.inject({
				method: "GET",
				url: `/v1/conversations/${root.id}/interactions/rf4`,
			});
			expect(read.statusCode).toBe(200);
			expect(read.json()).toMatchObject({
				callId: "rf4",
				status: "answered",
				answer: { values: { token: MASK, account: "acme" } },
			});
			// The extension-side read (host.snapshotInteraction): the TRUE
			// value — delivered once, transiently, never stored.
			const seen = await host.snapshotInteraction(
				root.id as never,
			"rf4",
				BACKGROUND_CONTEXT,
			);
			expect(seen?.answer?.values).toEqual({ token: TOKEN, account: "acme" });
			// A second extension read shows the MASK (the delivery table's
			// entry is gone — one-shot).
			const again = await host.snapshotInteraction(
				root.id as never,
				"rf4",
				BACKGROUND_CONTEXT,
			);
			expect(again?.answer?.values).toEqual({ token: MASK, account: "acme" });
			// The log stream never saw the value.
			const allOutput = [...warned, ...errored, ...logged].join("\n");
			expect(allOutput).not.toContain(TOKEN);
		} finally {
			warnSpy.mockRestore();
			errorSpy.mockRestore();
			logSpy.mockRestore();
		}
	});

	test("a secret NESTED under content blocks is stripped too (walker descends every child slot)", { timeout: 30_000 }, async () => {
		const { app, opened } = await bootGateServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT);
		const host = opened.seamHosts.get("sigrun-fixture-seam");
		if (host === undefined) throw new Error("fixture-seam host missing");
		// Critical 1 regression: a secret field one level down in a SECTION
		// whose children include a deeper nesting. The wire FormBlock type
		// admits only Field | SectionBlock at the root, so the gap shape is
		// section-inside-section (the walker must recurse the `children`
		// slot of EVERY container, not just the root form's and one section
		// level). The runtime validator treats section children as AnyObject
		// (schema.ts:254), so the nested shape validates; the wire cast goes
		// through the test's own literal.
		const nested = {
			v: 1,
			root: {
				type: "form",
				id: "nested-creds",
				bind: "/values",
				mode: "submit",
				children: [
					{
						type: "section",
						title: "Primary",
						children: [
							{ type: "secret", name: "token", label: "API token" },
							{
								type: "section",
								title: "Alternate",
								children: [
									{ type: "secret", name: "altToken", label: "Alt token" },
								],
							},
						],
					},
				],
			},
		} as import("@sigrun/shared/blocks").Tree;
		await host.seedInteraction(
			root.id as never,
			{
				kind: "fixture.ask",
				callId: "rf4-nested",
				status: "pending",
				createdAt: 1,
				body: nested,
			},
			BACKGROUND_CONTEXT,
		);
		const answer = await app.inject({
			method: "POST",
			url: `/v1/conversations/${root.id}/interactions/rf4-nested/answer`,
			payload: { values: { token: TOKEN, altToken: "tok-alt-not-real" } },
			headers: { "content-type": "application/json" },
		});
		expect(answer.statusCode).toBe(200);
		// GET: the stored record shows MASK for BOTH (the values never persisted).
		const read = await app.inject({
			method: "GET",
			url: `/v1/conversations/${root.id}/interactions/rf4-nested`,
		});
		expect(read.statusCode).toBe(200);
		expect(read.json()).toMatchObject({
			callId: "rf4-nested",
			status: "answered",
			answer: { values: { token: MASK, altToken: MASK } },
		});
		expect(JSON.stringify(read.json())).not.toContain(TOKEN);
		expect(JSON.stringify(read.json())).not.toContain("tok-alt-not-real");
		// The extension read delivers BOTH true values ONCE.
		const seen = await host.snapshotInteraction(
			root.id as never,
			"rf4-nested",
			BACKGROUND_CONTEXT,
		);
		expect(seen?.answer?.values).toEqual({
			token: TOKEN,
			altToken: "tok-alt-not-real",
		});
		const again = await host.snapshotInteraction(
			root.id as never,
			"rf4-nested",
			BACKGROUND_CONTEXT,
		);
		expect(again?.answer?.values).toEqual({ token: MASK, altToken: MASK });
	});

	test("a losing answer leaves the winner's secret delivery intact", { timeout: 30_000 }, async () => {
		const { app, opened } = await bootGateServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT);
		const host = opened.seamHosts.get("sigrun-fixture-seam");
		if (host === undefined) throw new Error("fixture-seam host missing");
		await host.seedInteraction(
			root.id as never,
			{
				kind: "fixture.ask",
				callId: "rf4-race",
				status: "pending",
				createdAt: 1,
				body: secretTree(),
			},
			BACKGROUND_CONTEXT,
		);
		// The winner answers first.
		const winner = await app.inject({
			method: "POST",
			url: `/v1/conversations/${root.id}/interactions/rf4-race/answer`,
			payload: { values: { token: TOKEN, account: "acme" } },
			headers: { "content-type": "application/json" },
		});
		expect(winner.statusCode).toBe(200);
		// The loser answers after the record is terminal: 404 not_pending —
		// and its branch must NOT sweep the winner's undelivered entry
		// (Critical 2: the delivery belongs to the winner).
		const loser = await app.inject({
			method: "POST",
			url: `/v1/conversations/${root.id}/interactions/rf4-race/answer`,
			payload: { values: { token: "tok-loser", account: "other" } },
			headers: { "content-type": "application/json" },
		});
		expect(loser.statusCode).toBe(404);
		expect(loser.json()).toEqual({ error: "not_pending" });
		// The winner's true answer is still deliverable.
		const seen = await host.snapshotInteraction(
			root.id as never,
			"rf4-race",
			BACKGROUND_CONTEXT,
		);
		expect(seen?.answer?.values).toEqual({ token: TOKEN, account: "acme" });
	});

	test("a double answer preserves the winner's delivery (the loser's sweep is gone)", { timeout: 30_000 }, async () => {
		const { app, opened } = await bootGateServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT);
		const host = opened.seamHosts.get("sigrun-fixture-seam");
		if (host === undefined) throw new Error("fixture-seam host missing");
		// Important 3 / minor 6 neighbour: a pending poll arriving BEFORE
		// the winning answer commits must not destroy the delivery (the
		// record check comes first, so a pending record never reaches take)
		// — and the second answer's loser branch must not sweep it either.
		await host.seedInteraction(
			root.id as never,
			{
				kind: "fixture.ask",
				callId: "rf4-window",
				status: "pending",
				createdAt: 1,
				body: secretTree(),
			},
			BACKGROUND_CONTEXT,
		);
		// The early poll: pending record, no delivery touch (with the old
		// take-first order a delivery in flight would have been deleted by
		// this very call).
		const early = await host.snapshotInteraction(
			root.id as never,
			"rf4-window",
			BACKGROUND_CONTEXT,
		);
		expect(early?.answer).toBeUndefined();
		// Winner + loser answers.
		const winner = await app.inject({
			method: "POST",
			url: `/v1/conversations/${root.id}/interactions/rf4-window/answer`,
			payload: { values: { token: TOKEN, account: "acme" } },
			headers: { "content-type": "application/json" },
		});
		expect(winner.statusCode).toBe(200);
		const loser = await app.inject({
			method: "POST",
			url: `/v1/conversations/${root.id}/interactions/rf4-window/answer`,
			payload: { values: { token: "tok-loser" } },
			headers: { "content-type": "application/json" },
		});
		expect(loser.statusCode).toBe(404);
		// The winner's delivery survived both the early poll and the loser.
		const seen = await host.snapshotInteraction(
			root.id as never,
			"rf4-window",
			BACKGROUND_CONTEXT,
		);
		expect(seen?.answer?.values).toEqual({ token: TOKEN, account: "acme" });
	});

	test("a settle sweep drops an unread secret delivery (no accumulation)", { timeout: 30_000 }, async () => {
		const { app, opened } = await bootGateServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT);
		const host = opened.seamHosts.get("sigrun-fixture-seam");
		if (host === undefined) throw new Error("fixture-seam host missing");
		// Seed + answer with a secret (the extension never reads it).
		await host.seedInteraction(
			root.id as never,
			{
				kind: "fixture.ask",
				callId: "rf4-sweep",
				status: "pending",
				createdAt: 1,
				body: secretTree(),
			},
			BACKGROUND_CONTEXT,
		);
		const answer = await app.inject({
			method: "POST",
				url: `/v1/conversations/${root.id}/interactions/rf4-sweep/answer`,
				payload: { values: { token: TOKEN, account: "acme" } },
				headers: { "content-type": "application/json" },
		});
		expect(answer.statusCode).toBe(200);
		// A no-op settle (the record is already terminal) must NOT sweep the
		// delivery (minor 2: the sweep belongs on the applied terminal
		// transition only) — the extension's unread true value survives.
		const noop = await host.settleInteraction(
			root.id as never,
			"rf4-sweep",
			"skipped",
			BACKGROUND_CONTEXT,
		);
		expect(noop).toBe(false);
		const stillThere = await host.snapshotInteraction(
			root.id as never,
			"rf4-sweep",
			BACKGROUND_CONTEXT,
		);
		expect(stillThere?.answer?.values).toEqual({
			token: TOKEN,
			account: "acme",
		});
		// Re-answer to re-record the delivery, then the REAL settle path:
		// a pending record settled to a terminal status sweeps the unread
		// delivery (no accumulation of a secret nobody ever read). The
		// sweepable shape is a delivery left by an answer committed directly
		// through applyAnswer on a pending draft — approximated here by a
		// second seeded record whose delivery the extension never reads,
		// settled via the expire route below.
		await host.seedInteraction(
			root.id as never,
			{
				kind: "fixture.ask",
				callId: "rf4-sweep2",
				status: "pending",
				createdAt: 1,
				body: secretTree(),
			},
			BACKGROUND_CONTEXT,
		);
		const answer2 = await app.inject({
			method: "POST",
			url: `/v1/conversations/${root.id}/interactions/rf4-sweep2/answer`,
			payload: { values: { token: TOKEN, account: "acme" } },
			headers: { "content-type": "application/json" },
		});
		expect(answer2.statusCode).toBe(200);
		// One-shot delivery: the first extension read consumes the entry —
		// a second read shows the stored MASK (the "no accumulation" belt:
		// the table never retains the value past its one delivery).
		const first = await host.snapshotInteraction(
			root.id as never,
			"rf4-sweep2",
			BACKGROUND_CONTEXT,
		);
		expect(first?.answer?.values).toEqual({ token: TOKEN, account: "acme" });
		const seen = await host.snapshotInteraction(
			root.id as never,
			"rf4-sweep2",
			BACKGROUND_CONTEXT,
		);
		expect(seen?.answer?.values).toEqual({ token: MASK, account: "acme" });
	});
});

// ─── the four-question ask-user-question shape (one POST) ───────────────

test("a four-question ask-user tree (sections + choice, preview, allowOther) answers in one POST", { timeout: 30_000 }, async () => {
	const { app, opened } = await bootGateServer();
	const root = await opened.harness.root(BACKGROUND_CONTEXT);
	const host = opened.seamHosts.get("sigrun-fixture-seam");
	if (host === undefined) throw new Error("fixture-seam host missing");
	// ask-user-question shape (spec §9.1): 1-4 questions, each a `section`
	// holding one `choice`; `preview` and `allowOther` are the two choice
	// props added for it.
	const four: import("@sigrun/shared/blocks").Tree = {
		v: 1,
		root: {
			type: "form",
			id: "questions",
			bind: "/values",
			mode: "submit",
			children: [
				{
					type: "section",
				title: "Deploy target",
				children: [
					{
						type: "choice",
						name: "q1",
						label: "Which environment?",
						options: [
							{ id: "staging", label: "Staging", recommended: true, preview: "**Staging** — risk-free deploy" },
							{ id: "canary", label: "Canary", preview: "**Canary** — 5% traffic" },
							{ id: "prod", label: "Production", preview: "**Production** — all traffic" },
						],
					},
					],
			},
				{
					type: "section",
					title: "Regions",
					children: [
						{
							type: "choice",
							name: "q2",
							label: "Which regions?",
							multi: true,
							options: [
								{ id: "us", label: "US" },
								{ id: "eu", label: "EU" },
							],
						},
					],
				},
				{
					type: "section",
						title: "Notes",
					children: [
						{
							type: "choice",
							name: "q3",
							label: "Anything else?",
							allowOther: { label: "Other" },
							options: [{ id: "none", label: "No, proceed" }],
						},
					],
				},
				{
					type: "section",
						title: "Confirm",
						children: [
						{
								type: "choice",
								name: "q4",
								label: "Proceed?",
								options: [
									{ id: "go", label: "Go", tone: "good" },
									{ id: "stop", label: "Stop", tone: "bad" },
								],
						},
					],
				},
			],
		},
	};
	await host.seedInteraction(
		root.id as never,
		{
			kind: "fixture.ask",
			callId: "four-q",
			status: "pending",
			createdAt: 1,
			body: four,
		},
		BACKGROUND_CONTEXT,
	);
	const answer = await app.inject({
		method: "POST",
		url: `/v1/conversations/${root.id}/interactions/four-q/answer`,
		payload: {
			values: {
				q1: "staging",
				q2: ["us", "eu"],
				q3: { other: "skip the smoke tests" },
				q4: "go",
			},
		},
		headers: { "content-type": "application/json" },
	});
	expect(answer.statusCode).toBe(200);
	expect(answer.json()).toMatchObject({
		callId: "four-q",
		status: "answered",
		answer: {
			values: {
				q1: "staging",
				q2: ["us", "eu"],
				q3: { other: "skip the smoke tests" },
				q4: "go",
			},
		},
	});
});

// ─── Case 2: the codemode-nesting parity lock (always runs) ────────────

describe(
	"codemode nesting",
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
							| { status: string; answer?: { values?: Record<string, unknown> } }
						| undefined
				> {
					if (decision === undefined) return undefined;
					return {
						status: "answered",
						answer: { values: { decision } },
					};
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
