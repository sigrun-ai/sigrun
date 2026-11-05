/**
 * Ask-user Task 2: an admitted human message declines pending declinable
 * questions — including ones not yet shown (spec §5.3). The anti-goal
 * under test: a typed message must never get stuck behind a waiting
 * question.
 *
 * The seam boot mirrors test/interaction-decline.test.ts (openHarness +
 * createServer + seededIdentity + the faux provider). The fixture
 * `fixture-ask-wait` declares the `askwait.q` kind and one tool
 * `wait_for_human` whose execute seeds a declinable record and waits on
 * its settle; `fixture-gate` provides the non-declinable contrast kind
 * (`gate.ask`).
 *
 * Cases (the brief's Step-2 list):
 *  1. A `whenBusy: "steer"` HTTP message while the tool waits → the
 *     record reads {status: "skipped", declinedVia: "message"}; the tool
 *     result `declined:message` lands BEFORE the pi.user "use b" entry.
 *  2. Two parallel waits → both records skipped; both results decline.
 *  3. A host submit WITHOUT user declines nothing; WITH user "alice" →
 *     skipped, answeredByUser "alice".
 *  4. A UI-blocks answer (the blocks actions route) while the tool waits
 *     → the record stays pending (entry-carrying submissions never
 *     decline).
 *  5. A non-declinable record (gate.ask) stays pending when a message
 *     is submitted.
 *  6. `whenBusy: "reject"` while busy → the submit errors (400) and the
 *     record stays pending.
 *  7. Review Focus 2: the message admitted BEFORE the card exists (the
 *     tool held on `__askWaitGate`) → the record seeds already
 *     {skipped, message}; the result reads declined:message; "never
 *     mind" follows it in the transcript.
 *  8. A message admitted while IDLE (placed at once) is not recorded in
 *     QueuedHumanInputsDoc, so a question seeded later that run is not
 *     pre-declined.
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
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import {
	InteractionDoc,
	QueuedHumanInputsDoc,
} from "../src/harness/interactions.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import type { SeamHost } from "../src/harness/seam-host.js";
import { createServer } from "../src/server/index.js";
import { seededIdentity } from "./helpers/identity.js";

const ASKWAIT_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-ask-wait", "index.js"),
).href;
const GATE_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-gate", "index.js"),
).href;

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

interface TestServer {
	app: FastifyInstance;
	opened: OpenedHarness;
	faux: ReturnType<typeof fauxProvider>;
}

/** Boot one hermetic server with the ask-wait + gate fixtures loaded. */
async function bootServer(): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-decline-msg-"));
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	faux.setResponses([fauxAssistantMessage("ok")]);
	const contributor: ProviderContributor = {
		name: "ext-faux",
		providers: [{ provider: faux.provider }],
	};
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_AUTH: "none",
		SIGRUN_WORKSPACE_PATH: dir,
		SIGRUN_CONFIG_DIR: join(dir, "config"),
		SIGRUN_CACHE_DIR: join(dir, "cache"),
		SIGRUN_STATE_DIR: join(dir, "state"),
	});
	// Same disable as the other server suites: no auto-naming calls.
	await writeFile(join(dir, "settings.json"), '{"namingModel": false}');
	const identity = await seededIdentity(dir, "alice");
	const opened = await openHarness(config, {
		identity,
		extensions: [contributor],
		env: {},
		extensionSpecifiers: [ASKWAIT_SPECIFIER, GATE_SPECIFIER],
		settingsDir: dir,
	});
	const app = await createServer(opened, {
		...config,
		webui: { ...config.webui, enabled: false },
	});
	cleanups.push(async () => {
		delete (globalThis as Record<string, unknown>).__askWaitGate;
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	});
	return { app, opened, faux };
}

/** The ask-wait fixture's captured seam host (tests seed through it). */
function askWaitHost(): SeamHost {
	const host = (globalThis as Record<string, unknown>).__askWaitHost as
		| SeamHost
		| undefined;
	if (host === undefined) throw new Error("ask-wait host not captured");
	return host;
}

/** The stored interaction record for one callId. */
async function recordOf(
	opened: OpenedHarness,
	conversationId: number,
	callId: string,
) {
	return await opened.harness.snapshot(
		InteractionDoc,
		conversationId as ConversationId,
		callId,
		BACKGROUND_CONTEXT,
	);
}

/** The QueuedHumanInputsDoc snapshot for one conversation. */
async function queuedOf(opened: OpenedHarness, conversationId: number) {
	return await opened.harness.snapshot(
		QueuedHumanInputsDoc,
		conversationId as ConversationId,
		BACKGROUND_CONTEXT,
	);
}

/** The §5 view's entries (kind order = transcript order). */
async function viewEntries(
	app: FastifyInstance,
	conversationId: number,
): Promise<{ kind: string; text?: string }[]> {
	const view = (
		await app.inject({
			method: "GET",
			url: `/v1/conversations/${conversationId}`,
		})
	).json() as {
		entries: {
			kind: string;
			model?: {
				role: string;
				content?: string | readonly { type: string; text?: string }[];
			}[];
		}[];
	};
	return view.entries.map((entry) => {
		const content = entry.model?.[0]?.content;
		const text =
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content.map((block) => block.text ?? "").join("")
					: undefined;
		return { kind: entry.kind, text };
	});
}

/** Poll until the record settles (the tool's settle lands async). */
async function waitForStatus(
	opened: OpenedHarness,
	conversationId: number,
	callId: string,
	status: string,
	timeoutMs = 15_000,
) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const record = await recordOf(opened, conversationId, callId);
		if (record?.status === status) return record;
		if (Date.now() > deadline) {
			throw new Error(
				`record ${callId} never reached ${status} (got ${JSON.stringify(record)})`,
			);
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

describe("a human message declines pending declinable questions", () => {
	test(
		"case 1: a steer message while the tool waits skips the record; the tool result precedes the message in the transcript",
		{ timeout: 60_000 },
		async () => {
			const { app, opened, faux } = await bootServer();
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("wait_for_human", {})], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
			]);
			const root = await opened.harness.root(BACKGROUND_CONTEXT);
			const submission = await app.inject({
				method: "POST",
				url: `/v1/conversations/${root.id}/submissions`,
				payload: { input: "ask me" },
				headers: { "content-type": "application/json" },
			});
			expect(submission.statusCode).toBe(202);

			// Wait until the record is pending (the tool seeded it).
			const records = opened.harness.snapshot.bind(opened.harness);
			void records;
			const deadline = Date.now() + 15_000;
			let callId: string | undefined;
			for (;;) {
				// The tool's callId is unknown; read the pending index via the
				// list route.
				const list = await app.inject({
					method: "GET",
					url: `/v1/conversations/${root.id}/interactions`,
				});
				expect(list.statusCode).toBe(200);
				const items = list.json().interactions as { callId: string }[];
				if (items.length === 1) {
					callId = items[0]!.callId;
					break;
				}
				if (Date.now() > deadline) throw new Error("no pending record");
				await new Promise((resolve) => setTimeout(resolve, 25));
			}

			// The human answers in chat instead of pressing the card.
			const decline = await app.inject({
				method: "POST",
				url: `/v1/conversations/${root.id}/submissions`,
				payload: { input: "use b", whenBusy: "steer" },
				headers: { "content-type": "application/json" },
			});
			expect(decline.statusCode).toBe(202);

			// The record settles as skipped/message.
			const record = await waitForStatus(opened, root.id, callId, "skipped");
			expect(record).toMatchObject({
				status: "skipped",
				declinedVia: "message",
				answeredBy: "human",
			});

			// The tool result lands BEFORE the user's message in the
			// transcript (the steer is placed at the postTools boundary).
			await waitForStatus(opened, root.id, callId, "skipped");
			const idle = await opened.harness.conversation(
				root.id,
				BACKGROUND_CONTEXT,
			);
			await idle!.waitForIdle(BACKGROUND_CONTEXT);
			const entries = await viewEntries(app, root.id);
			const toolIdx = entries.findIndex(
				(entry) =>
					entry.kind === "pi.tool-result" &&
					entry.text?.includes("declined:message"),
			);
			const userIdx = entries.findIndex(
				(entry) => entry.kind === "pi.user" && entry.text === "use b",
			);
			expect(toolIdx).toBeGreaterThanOrEqual(0);
			expect(userIdx).toBeGreaterThan(toolIdx);
		},
	);

	test(
		"case 2: two parallel waits are both skipped by one message",
		{ timeout: 60_000 },
		async () => {
			const { app, opened, faux } = await bootServer();
			faux.setResponses([
				fauxAssistantMessage(
					[fauxToolCall("wait_for_human", {}), fauxToolCall("wait_for_human", {})],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done"),
			]);
			const root = await opened.harness.root(BACKGROUND_CONTEXT);
			const submission = await app.inject({
				method: "POST",
				url: `/v1/conversations/${root.id}/submissions`,
				payload: { input: "ask me twice" },
				headers: { "content-type": "application/json" },
			});
			expect(submission.statusCode).toBe(202);

			// Wait until BOTH records are pending.
			const deadline = Date.now() + 15_000;
			for (;;) {
				const list = await app.inject({
					method: "GET",
					url: `/v1/conversations/${root.id}/interactions`,
				});
				const items = list.json().interactions as { callId: string }[];
				if (items.length === 2) break;
				if (Date.now() > deadline) {
					throw new Error(`expected 2 pending, got ${items.length}`);
				}
				await new Promise((resolve) => setTimeout(resolve, 25));
			}

			const decline = await app.inject({
				method: "POST",
				url: `/v1/conversations/${root.id}/submissions`,
				payload: { input: "never mind both", whenBusy: "steer" },
				headers: { "content-type": "application/json" },
			});
			expect(decline.statusCode).toBe(202);

			const idle = await opened.harness.conversation(
				root.id,
				BACKGROUND_CONTEXT,
			);
			await idle!.waitForIdle(BACKGROUND_CONTEXT);

			const list = await app.inject({
				method: "GET",
				url: `/v1/conversations/${root.id}/interactions`,
			});
			expect(list.json().interactions).toEqual([]);

			const entries = await viewEntries(app, root.id);
			const declined = entries.filter(
				(entry) =>
					entry.kind === "pi.tool-result" &&
					entry.text?.includes("declined:message"),
			);
			expect(declined).toHaveLength(2);
		},
	);

	test(
		"case 3: a host submit without user declines nothing; with user it skips and attributes",
		{ timeout: 60_000 },
		async () => {
			const { app, opened, faux } = await bootServer();
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("wait_for_human", {})], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
			]);
			const root = await opened.harness.root(BACKGROUND_CONTEXT);
			const submission = await app.inject({
				method: "POST",
				url: `/v1/conversations/${root.id}/submissions`,
				payload: { input: "ask me" },
				headers: { "content-type": "application/json" },
			});
			expect(submission.statusCode).toBe(202);

			const deadline = Date.now() + 15_000;
			let callId: string | undefined;
			for (;;) {
				const list = await app.inject({
					method: "GET",
					url: `/v1/conversations/${root.id}/interactions`,
				});
				const items = list.json().interactions as { callId: string }[];
				if (items.length === 1) {
					callId = items[0]!.callId;
					break;
				}
				if (Date.now() > deadline) throw new Error("no pending record");
				await new Promise((resolve) => setTimeout(resolve, 25));
			}

			const host = askWaitHost();
			// A host submit with NO user must not decline.
			await host.conversations.submit(
				root.id,
				[{ type: "text", text: "extension chatter" }],
				{ whenBusy: "steer" },
			);
			await new Promise((resolve) => setTimeout(resolve, 200));
			const stillPending = await recordOf(opened, root.id, callId);
			expect(stillPending?.status).toBe("pending");

			// A host submit WITH a user declines as that human.
			await host.conversations.submit(
				root.id,
				[{ type: "text", text: "alice speaks" }],
				{ whenBusy: "steer", user: "alice" },
			);
			const record = await waitForStatus(opened, root.id, callId, "skipped");
			expect(record).toMatchObject({
				declinedVia: "message",
				answeredByUser: "alice",
			});
			const idle = await opened.harness.conversation(
				root.id,
				BACKGROUND_CONTEXT,
			);
			await idle!.waitForIdle(BACKGROUND_CONTEXT);
		},
	);

	test(
		"case 4: a UI-blocks answer while the tool waits declines nothing",
		{ timeout: 60_000 },
		async () => {
			const { app, opened, faux } = await bootServer();
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("wait_for_human", {})], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
			]);
			const root = await opened.harness.root(BACKGROUND_CONTEXT);
			const submission = await app.inject({
				method: "POST",
				url: `/v1/conversations/${root.id}/submissions`,
				payload: { input: "ask me" },
				headers: { "content-type": "application/json" },
			});
			expect(submission.statusCode).toBe(202);

			const deadline = Date.now() + 15_000;
			let callId: string | undefined;
			for (;;) {
				const list = await app.inject({
					method: "GET",
					url: `/v1/conversations/${root.id}/interactions`,
				});
				const items = list.json().interactions as { callId: string }[];
				if (items.length === 1) {
					callId = items[0]!.callId;
					break;
				}
				if (Date.now() > deadline) throw new Error("no pending record");
				await new Promise((resolve) => setTimeout(resolve, 25));
			}

			// Show a block surface (the answer path's vehicle): append the
			// entry + seed its state in one commit, exactly as show_blocks
			// does.
			const conversation = await opened.harness.conversation(
				root.id,
				BACKGROUND_CONTEXT,
			);
			const host = askWaitHost();
			const { BlocksEntry } = await import(
				"../src/harness/blocks/entries.js"
			);
			const { BlocksStateDoc } = await import(
				"../src/harness/blocks/state.js"
			);
			const entryId = await conversation!.commit(async (tx) => {
				const entry = await tx.appendEntry(BlocksEntry, root.id, {
					data: {
						title: "Panel",
						tree: {
							v: 1,
							root: {
								type: "section",
								title: "Panel",
								children: [
									{
										type: "form",
										id: "form",
										bind: "/order",
										mode: "submit",
										onSubmit: "applyOrder",
										submitLabel: "Apply",
										children: [],
									},
								],
							},
						} as never,
						data: { order: {} },
					},
				});
				const id = String(entry.id);
				const state = await tx.doc(
					BlocksStateDoc,
					root.id,
					id,
					id,
				);
				Object.assign(state, { rev: 0, data: { order: {} } });
				return id;
			}, BACKGROUND_CONTEXT);

			// The blocks actions route submits with entry: (no decline).
			const action = await app.inject({
				method: "POST",
				url: `/v1/conversations/${root.id}/blocks/${entryId}/actions`,
				payload: { action: "applyOrder", payload: {}, actionId: "act-1" },
				headers: { "content-type": "application/json" },
			});
			expect(action.statusCode).toBe(200);
			await new Promise((resolve) => setTimeout(resolve, 200));
			const record = await recordOf(opened, root.id, callId);
			expect(record?.status).toBe("pending");

			// Clean up: decline the record so the run can finish.
			await host.declineInteraction(root.id, callId, BACKGROUND_CONTEXT, {});
			await conversation!.waitForIdle(BACKGROUND_CONTEXT);
		},
	);

	test(
		"case 5: a non-declinable record (gate.ask) stays pending when a message is submitted",
		{ timeout: 60_000 },
		async () => {
			const { app, opened, faux } = await bootServer();
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("wait_for_human", {})], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
			]);
			const root = await opened.harness.root(BACKGROUND_CONTEXT);
			// Seed a NON-declinable record through the gate fixture's kind.
			const gateHost = askWaitHost();
			// The gate kind is not declared by the ask-wait fixture; seed
			// directly via the harness (the route's write gate is bypassed
			// only in tests through the fixture hosts). Use the ask-wait host
			// only for declinable kinds; for the gate kind use a direct
			// commit that mimics seedInteraction's shape.
			const conversation = await opened.harness.conversation(
				root.id,
				BACKGROUND_CONTEXT,
			);
			const { indexPending, InteractionsIndexDoc } = await import(
				"../src/harness/interactions.js"
			);
			await conversation!.commit(async (tx) => {
				const draft = await tx.doc(InteractionDoc, root.id, "gate-1", "gate-1");
				Object.assign(draft, {
					kind: "gate.ask",
					callId: "gate-1",
					status: "pending",
					createdAt: 1,
				});
				const index = await tx.doc(InteractionsIndexDoc);
				indexPending(index, root.id, "gate-1");
			}, BACKGROUND_CONTEXT);

			const submission = await app.inject({
				method: "POST",
				url: `/v1/conversations/${root.id}/submissions`,
				payload: { input: "start the wait" },
				headers: { "content-type": "application/json" },
			});
			expect(submission.statusCode).toBe(202);

			// Wait for the ask-wait record to exist, then submit the message.
			const deadline = Date.now() + 15_000;
			let callId: string | undefined;
			for (;;) {
				const list = await app.inject({
					method: "GET",
					url: `/v1/conversations/${root.id}/interactions`,
				});
				const items = list.json().interactions as { callId: string }[];
				if (items.some((one) => one.callId !== "gate-1")) {
					callId = items.find((one) => one.callId !== "gate-1")!.callId;
					break;
				}
				if (Date.now() > deadline) throw new Error("no ask-wait record");
				await new Promise((resolve) => setTimeout(resolve, 25));
			}

			const decline = await app.inject({
				method: "POST",
				url: `/v1/conversations/${root.id}/submissions`,
				payload: { input: "use b", whenBusy: "steer" },
				headers: { "content-type": "application/json" },
			});
			expect(decline.statusCode).toBe(202);

			// The declinable record settles; the non-declinable one stays.
			await waitForStatus(opened, root.id, callId, "skipped");
			const gateRecord = await recordOf(opened, root.id, "gate-1");
			expect(gateRecord?.status).toBe("pending");

			const idle = await opened.harness.conversation(
				root.id,
				BACKGROUND_CONTEXT,
			);
			await idle!.waitForIdle(BACKGROUND_CONTEXT);
			void gateHost;
		},
	);

	test(
		"case 6: whenBusy reject while busy declines nothing",
		{ timeout: 60_000 },
		async () => {
			const { app, opened, faux } = await bootServer();
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("wait_for_human", {})], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
			]);
			const root = await opened.harness.root(BACKGROUND_CONTEXT);
			const submission = await app.inject({
				method: "POST",
				url: `/v1/conversations/${root.id}/submissions`,
				payload: { input: "ask me" },
				headers: { "content-type": "application/json" },
			});
			expect(submission.statusCode).toBe(202);

			const deadline = Date.now() + 15_000;
			let callId: string | undefined;
			for (;;) {
				const list = await app.inject({
					method: "GET",
					url: `/v1/conversations/${root.id}/interactions`,
				});
				const items = list.json().interactions as { callId: string }[];
				if (items.length === 1) {
					callId = items[0]!.callId;
					break;
				}
				if (Date.now() > deadline) throw new Error("no pending record");
				await new Promise((resolve) => setTimeout(resolve, 25));
			}

			const reject = await app.inject({
				method: "POST",
				url: `/v1/conversations/${root.id}/submissions`,
				payload: { input: "no", whenBusy: "reject" },
				headers: { "content-type": "application/json" },
			});
			// ConversationBusy is a 4xx/5xx error either way; the point is
			// nothing is admitted and the record stays pending.
			expect(reject.statusCode).toBeGreaterThanOrEqual(400);
			await new Promise((resolve) => setTimeout(resolve, 200));
			const record = await recordOf(opened, root.id, callId);
			expect(record?.status).toBe("pending");

			// Clean up.
			const host = askWaitHost();
			await host.declineInteraction(root.id, callId, BACKGROUND_CONTEXT, {});
			const idle = await opened.harness.conversation(
				root.id,
				BACKGROUND_CONTEXT,
			);
			await idle!.waitForIdle(BACKGROUND_CONTEXT);
		},
	);

	test(
		"case 7 (Review Focus 2): a message admitted before the card exists pre-declines it",
		{ timeout: 60_000 },
		async () => {
			const { app, opened, faux } = await bootServer();
			// Hold the tool BEFORE it seeds, admit the message, then release.
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			(globalThis as Record<string, unknown>).__askWaitGate = gate;

			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("wait_for_human", {})], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
			]);
			const root = await opened.harness.root(BACKGROUND_CONTEXT);
			const submission = await app.inject({
				method: "POST",
				url: `/v1/conversations/${root.id}/submissions`,
				payload: { input: "ask me" },
				headers: { "content-type": "application/json" },
			});
			expect(submission.statusCode).toBe(202);

			// Give the tool a beat to reach the gate (the run is live).
			await new Promise((resolve) => setTimeout(resolve, 250));

			const decline = await app.inject({
				method: "POST",
				url: `/v1/conversations/${root.id}/submissions`,
				payload: { input: "never mind", whenBusy: "steer" },
				headers: { "content-type": "application/json" },
			});
			expect(decline.statusCode).toBe(202);

			// The message is queued (the tool round is live) — the ledger
			// recorded it.
			const queued = await queuedOf(opened, root.id);
			expect(Object.keys(queued?.byId ?? {}).length).toBe(1);

			// Release the gate: the tool seeds the record now.
			release();
			delete (globalThis as Record<string, unknown>).__askWaitGate;

			const idle = await opened.harness.conversation(
				root.id,
				BACKGROUND_CONTEXT,
			);
			await idle!.waitForIdle(BACKGROUND_CONTEXT);

			// The record was seeded already settled.
			const list = await app.inject({
				method: "GET",
				url: `/v1/conversations/${root.id}/interactions`,
			});
			expect(list.json().interactions).toEqual([]);

			const entries = await viewEntries(app, root.id);
			const toolIdx = entries.findIndex(
				(entry) =>
					entry.kind === "pi.tool-result" &&
					entry.text?.includes("declined:message"),
			);
			const userIdx = entries.findIndex(
				(entry) => entry.kind === "pi.user" && entry.text === "never mind",
			);
			expect(toolIdx).toBeGreaterThanOrEqual(0);
			expect(userIdx).toBeGreaterThan(toolIdx);
		},
	);

	test(
		"case 8: a message admitted while idle is not recorded in QueuedHumanInputsDoc",
		{ timeout: 60_000 },
		async () => {
			const { app, opened, faux } = await bootServer();
			faux.setResponses([fauxAssistantMessage("done")]);
			const root = await opened.harness.root(BACKGROUND_CONTEXT);
			const submission = await app.inject({
				method: "POST",
				url: `/v1/conversations/${root.id}/submissions`,
				payload: { input: "hello" },
				headers: { "content-type": "application/json" },
			});
			expect(submission.statusCode).toBe(202);
			const idle = await opened.harness.conversation(
				root.id,
				BACKGROUND_CONTEXT,
			);
			await idle!.waitForIdle(BACKGROUND_CONTEXT);

			// Idle admission placed the input at once — no ledger entry.
			const queued = await queuedOf(opened, root.id);
			expect(queued?.byId ?? {}).toEqual({});

			// A question seeded later in that run is NOT pre-declined.
			const host = askWaitHost();
			await host.seedInteraction(
				root.id,
				{
					kind: "askwait.q",
					callId: "late-1",
					status: "pending",
					createdAt: Date.now(),
					declinable: true,
				} as never,
				BACKGROUND_CONTEXT,
			);
			const record = await recordOf(opened, root.id, "late-1");
			expect(record?.status).toBe("pending");
		},
	);
});
