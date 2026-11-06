/**
 * Warden Task 16: the end-to-end check of the SHIPPED warden over the
 * real boot — the published hooks and decision providers landed in core
 * (Tasks 5–7), the warden repo's built `dist/` loads as an extension,
 * and the fixture package (`fixture-warden-e2e`) supplies:
 *
 *   - the published hook `mcp.tool-annotations`
 *     (`acme-media/torrents_remove` → destructiveHint; everything else
 *     unknown),
 *   - the `acme-media/torrents_remove` tool itself (its execute records
 *     module-side `toolRuns`),
 *   - the `acme-judge` decision provider (`judge-1`): `evaluate` records
 *     module-side `calls` and answers from the module-side `responses`
 *     queue (the last entry repeats).
 *
 * The warden loads from the SIBLING checkout's built `dist/index.js`
 * (the published-package shape) via the `siblingRepo` helper — the
 * root vitest can't import `webui/e2e/harness.ts`'s siblingRepo, so
 * `test/helpers/sibling-repo.ts` resolves `../<name>` here.
 *
 * The warden's own host stores land in REAL per-test temp roots: the
 * boot's `SIGRUN_CONFIG_DIR` (the settings file the warden's factory
 * reads through `host.stores.settings` — the scoped `settings/warden.json`)
 * plus the data/state dirs the `HoldLog`/`StateStore`/`CardStore` write
 * through (`SIGRUN_DATA_DIR`/`SIGRUN_STATE_DIR`). The warden never gets
 * a synthetic host — the real seam host serves it.
 *
 * Three cases:
 *
 *   1. LIVE: a conversation submits; the faux model calls
 *      `acme-media/torrents_remove` with `{ids:[7,9]}`; the judge's
 *      queue answers a LOW clear-ask (`clear_ask: 0.2`) → the warden
 *      steers, then holds (seeds a `warden.confirm` interaction); the
 *      test answers it `allow` through the answer route → the call
 *      RUNS (the tool-result entry carries the fixture's text and the
 *      `toolRuns` record lands).
 *   2. CLEARED JOB: a job (`ext:acme:cleanup`, prompt carrying the
 *      `<skill name="acme-cleanup">` block whose body names
 *      `torrents_remove`) fires runNow; the warden settings carry the
 *      clearance; the judge's queue answers HIGH meets (0.9) / LOW
 *      escalate (0.1) → the card check passes → the call RUNS.
 *   3. UNCLEARED JOB: the same shape with NO clearance → the call is
 *      BLOCKED (the warden's block message rides the tool result) and
 *      the no-escalation-provider path posts a notice to the job's
 *      owner (`host.notices.post`; the e2e asserts the notice through
 *      the `/v1/notices` route).
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxToolCall,
	fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import type { FastifyInstance } from "fastify";
import { loadConfig, type SigrunConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import { createServer } from "../src/server/index.js";
import { seededIdentity } from "./helpers/identity.js";
import { siblingRepo } from "./helpers/sibling-repo.js";
import {
	calls as judgeCalls,
	responses as judgeResponses,
	resetWardenE2e,
	toolRuns,
} from "./fixtures/fixture-warden-e2e/index.js";

const FIXTURE = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-warden-e2e", "index.js"),
).href;

/** The warden's built package entry (committed dist), when a sibling
 * checkout exists. Core CI does NOT check the warden out (it is not a
 * built-in sibling in family-checkout), so the suite skips there and
 * runs wherever the sibling layout exists (dev machines, the warden's
 * own release pipeline via needs-core). */
const WARDEN_PATH = join(siblingRepo("sigrun-warden"), "dist", "index.js");
const WARDEN = pathToFileURL(WARDEN_PATH).href;

interface Rig {
	opened: OpenedHarness;
	app: FastifyInstance;
	config: SigrunConfig;
	dir: string;
	faux: ReturnType<typeof fauxProvider>;
	aliceToken: string;
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

beforeEach(() => {
	resetWardenE2e();
});

/**
 * Boot the real harness + server with the warden (built dist) and the
 * fixture loaded. The warden's stores land in the temp dir's real
 * roots; the decisions surface resolves `acme-judge/judge-1` from the
 * settings file's `decisionModel`.
 */
async function bootWardenServer(
	wardenSettings: Record<string, unknown> = {},
): Promise<Rig> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-warden-e2e-"));
	const configDir = join(dir, "config");
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_AUTH: "token",
		SIGRUN_TIMEZONE: "UTC",
		SIGRUN_WORKSPACE_PATH: dir,
		SIGRUN_CONFIG_DIR: configDir,
		SIGRUN_DATA_DIR: join(dir, "data"),
		SIGRUN_STATE_DIR: join(dir, "state"),
		SIGRUN_CACHE_DIR: join(dir, "cache"),
	}, { server: {} } as Parameters<typeof loadConfig>[1]);
	// The auto-namer and the decisions surface share the faux provider;
	// namingModel off keeps the script deterministic. `decisionModel`
	// pins the warden's judge to the fixture's acme-judge/judge-1.
	await writeFile(
		join(dir, "settings.json"),
		JSON.stringify({ namingModel: false, decisionModel: "acme-judge/judge-1" }),
	);
	// The warden's scoped settings file (`settings/warden.json`).
	await mkdir(join(configDir, "settings"), { recursive: true });
	// The scoped slug is the DECLARED name sanitized: "sigrun.warden" →
	// "sigrun-warden" (the loader's slugifyName), so the warden's
	// settings file is settings/sigrun-warden.json and its stores land
	// under <dataDir>/sigrun-warden, <stateDir>/sigrun-warden.
	await writeFile(
		join(configDir, "settings", "sigrun-warden.json"),
		JSON.stringify(wardenSettings),
	);
	const identity = await seededIdentity(dir, "root-admin");
	await identity.users.add({ user: "alice", admin: false, source: "cli" });
	const opened = await openHarness(config, {
		identity,
		extensions: [{ name: "ext-faux", providers: [{ provider: faux.provider }] }],
		extensionSpecifiers: [WARDEN, FIXTURE],
		env: {
			SIGRUN_CONFIG_DIR: configDir,
			SIGRUN_DATA_DIR: join(dir, "data"),
			SIGRUN_STATE_DIR: join(dir, "state"),
			SIGRUN_CACHE_DIR: join(dir, "cache"),
			ACME_JUDGE_API_KEY: "acme-judge-key",
		},
		settingsDir: dir,
		expectHostBridge: true,
	});
	const app = await createServer(opened, {
		...config,
		webui: { ...config.webui, enabled: false },
	});
	const { token: aliceToken } = await opened.identity.tokens.create(
		"alice-cli",
		"alice",
	);
	cleanups.push(async () => {
		await app.close().catch(() => {});
		await opened.harness.close(BACKGROUND_CONTEXT).catch(() => {});
		await rm(dir, { recursive: true, force: true });
	});
	return { opened, app, config, dir, faux, aliceToken };
}

/** The visible text of every `pi.tool-result` entry for `toolName`. */
async function toolResultTexts(
	opened: OpenedHarness,
	conversationId: number,
	toolName: string,
): Promise<string[]> {
	const conversation = await opened.harness.conversation(
		conversationId as never,
		BACKGROUND_CONTEXT,
	);
	if (conversation === undefined) throw new Error("conversation vanished");
	const entries = await conversation.entries({}, 500, undefined, BACKGROUND_CONTEXT);
	const texts: string[] = [];
	for (const entry of entries.items) {
		if (entry.kind !== "pi.tool-result") continue;
		for (const message of entry.model ?? []) {
			const m = message as {
				role?: unknown;
				toolName?: unknown;
				content?: unknown;
			};
			if (m.role !== "toolResult" || m.toolName !== toolName) continue;
			const content = m.content;
			if (typeof content === "string") {
				texts.push(content);
			} else if (Array.isArray(content)) {
				for (const block of content) {
					if (
						typeof block === "object" &&
						block !== null &&
						(block as { type?: unknown }).type === "text" &&
						typeof (block as { text?: unknown }).text === "string"
					) {
						texts.push((block as { text: string }).text);
					}
				}
			}
		}
	}
	return texts;
}

/** The one pending interaction on a conversation, or undefined. */
async function pendingInteraction(
	app: FastifyInstance,
	id: number,
	token: string,
): Promise<{ callId: string; kind: string } | undefined> {
	const list = await app.inject({
		method: "GET",
		url: `/v1/conversations/${id}/interactions`,
		headers: { authorization: `Bearer ${token}` },
	});
	expect(list.statusCode).toBe(200);
	const listed = list.json().interactions as {
		callId: string;
		kind: string;
	}[];
	return listed[0];
}

/** Answer one interaction through the route; asserts 200. */
async function answerInteraction(
	app: FastifyInstance,
	id: number,
	callId: string,
	values: Record<string, unknown>,
	token: string,
): Promise<void> {
	const answer = await app.inject({
		method: "POST",
		url: `/v1/conversations/${id}/interactions/${callId}/answer`,
		payload: { values },
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${token}`,
		},
	});
	expect(answer.statusCode).toBe(200);
}

/** Create one far-future api job owned by alice; returns its id. */
async function createAliceJob(
	opened: OpenedHarness,
	prompt: string,
	name = "acme-cleanup",
): Promise<string> {
	const job = await opened.jobs.createApi(
		{
			name,
			schedule: { at: "2099-01-01T00:00:00.000Z" },
			action: { kind: "prompt", prompt, conversation: "new" },
		},
		"alice",
	);
	return job.id;
}

/** The skill body (verbatim; the card hash keys on these exact bytes). */
const CLEANUP_SKILL_BODY = `Cleanup of finished torrents.
1. Run torrents_list first to find finished items.
2. torrents_remove may then run on those ids.`;

/** The skill block whose body's card check governs `torrents_remove`. */
const CLEANUP_SKILL = `<skill name="acme-cleanup" location="skills/acme-cleanup/SKILL.md">${CLEANUP_SKILL_BODY}</skill>`;

/** Wait until a job conversation exists (poll the job's lastRun). */
async function waitForJobConversation(
	opened: OpenedHarness,
	jobId: string,
	timeoutMs = 30_000,
): Promise<number> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const job = await opened.jobs.get(jobId);
		const conversationId = job?.lastRun?.conversationId;
		if (conversationId !== undefined) return conversationId;
		if (Date.now() > deadline) throw new Error("job conversation never appeared");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

/** Wait until a job's run settles (lastRun.outcome leaves "running"). */
async function waitForJobSettled(
	opened: OpenedHarness,
	jobId: string,
	timeoutMs = 30_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const job = await opened.jobs.get(jobId);
		if (job?.lastRun !== undefined && job.lastRun.outcome !== "running") return;
		if (Date.now() > deadline) throw new Error("job run never settled");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

/** Poll for one pending interaction (the warden's hold poll cadence). */
async function waitForPending(
	app: FastifyInstance,
	id: number,
	token: string,
	timeoutMs = 30_000,
): Promise<{ callId: string; kind: string }> {
	const deadline = Date.now() + timeoutMs;
	let pending: { callId: string; kind: string } | undefined;
	while (pending === undefined && Date.now() < deadline) {
		pending = await pendingInteraction(app, id, token);
		if (pending === undefined) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}
	if (pending === undefined) throw new Error("no pending interaction appeared");
	return pending;
}

// Core CI does not lay the warden sibling out, so the suite skips
// there (the warden's OWN needs-core release job exercises it against
// a real sibling checkout).
const wardenPresent = existsSync(WARDEN_PATH);

describe.skipIf(!wardenPresent)("warden end-to-end", () => {
	test(
		"a live conversation's torrents_remove waits on a warden.confirm interaction (judge returns low clear-ask) and runs after allow",
		{ timeout: 60_000 },
		async () => {
			const rig = await bootWardenServer();
			const { app, opened, faux, aliceToken } = rig;
			// The model calls the destructive tool, retries after the steer
			// (the low clear-ask steers once; the repeated call — same
			// fingerprint, no reply — falls to the interaction hold), then
			// closes the run after the allowed call's result.
			faux.setResponses([
				fauxAssistantMessage(
					[fauxToolCall("acme-media/torrents_remove", { ids: [7, 9] })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(
					[fauxToolCall("acme-media/torrents_remove", { ids: [7, 9] })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done after the tool"),
			]);
			// The judge answers a LOW clear-ask: the request didn't name the
			// targets, so the warden steers once, then (the steer ignored by
			// the scripted second response) holds on a warden.confirm card.
			judgeResponses.push({ answers: { clear_ask: { type: "noul", noul: 0.2 } } });
			const root = await opened.harness.root(BACKGROUND_CONTEXT, {
				agent: { model: opened.defaultModel },
			});
			const submission = await app.inject({
				method: "POST",
				url: `/v1/conversations/${root.id}/submissions`,
				payload: { input: "remove some torrents" },
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${aliceToken}`,
				},
			});
			expect(submission.statusCode).toBe(202);

			// The warden held: exactly one pending `warden.confirm` card.
			const pending = await waitForPending(app, root.id, aliceToken);
			expect(pending.kind).toBe("warden.confirm");

			// Allow → the call runs; the marker text lands in the tool result.
			await answerInteraction(app, root.id, pending.callId, {
				decision: "allow",
				reason: "ok",
			}, aliceToken);
			const handle = await opened.harness.submission(
				submission.json().submission.id as never,
				BACKGROUND_CONTEXT,
			);
			const settled = await handle?.wait(BACKGROUND_CONTEXT);
			expect(settled?.status).toBe("done");
			expect(toolRuns).toEqual([{ ids: [7, 9] }]);
			const texts = await toolResultTexts(opened, root.id, "acme-media/torrents_remove");
			expect(texts.some((text) => text.includes("removed 7,9"))).toBe(true);
			// The judge was consulted for the clear-ask question.
			expect(judgeCalls.length).toBeGreaterThanOrEqual(1);
		},
	);

	test(
		"a cleared job fire's call runs after a passing card check",
		{ timeout: 60_000 },
		async () => {
			const rig = await bootWardenServer();
			const { opened, faux } = rig;
			// The job prompt carries the skill block (skillsInRun's channel 1).
			const jobId = await createAliceJob(opened, CLEANUP_SKILL);
			// The warden's scoped settings, written AFTER the job id is known
			// (the settings read is live — every tool call re-reads the file).
			await writeFile(
				join(rig.dir, "config", "settings", "sigrun-warden.json"),
				JSON.stringify({
					clearances: [
						{ job: jobId, tools: ["acme-media/torrents_remove"] },
					],
				}),
			);
			// Pre-seed the governing card: the card for the skill body the
			// job prompt carries. The warden's CardStore is
			// `<dataDir>/sigrun-warden/cards/<sha256(body)>.json`; the body
			// is the `<skill>` block's content verbatim (no leading/trailing
			// newline in the block below). Seeding avoids the inline card
			// build's `host.models.complete` call consuming a scripted faux
			// response (the brief's "pre-seed the card" path).
			const cardHash = createHash("sha256")
				.update(CLEANUP_SKILL_BODY, "utf8")
				.digest("hex");
			const cardsDir = join(rig.dir, "data", "sigrun-warden", "cards");
			await mkdir(cardsDir, { recursive: true });
			await writeFile(
				join(cardsDir, `${cardHash}.json`),
				JSON.stringify({
					hash: cardHash,
					skill: "acme-cleanup",
					location: "skills/acme-cleanup/SKILL.md",
					builtAt: new Date().toISOString(),
					model: "acme/utility-1",
					text: "## torrents_remove\n**Allowed without asking when:** the ids are finished.\n**Evidence required first:** none.\n**Escalate instead when:** never.",
				}),
			);
			// The job's faux run: the destructive call, then the closing
			// message.
			faux.setResponses([
				fauxAssistantMessage(
					[fauxToolCall("acme-media/torrents_remove", { ids: [7] })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("cleanup done"),
			]);
			// The card check: HIGH meets / LOW escalate for the one target.
			judgeResponses.push({
				answers: {
					t0_meets: { type: "noul", noul: 0.9 },
					t0_escalate: { type: "noul", noul: 0.1 },
				},
			});
			await opened.jobs.runNow(jobId);
			await waitForJobSettled(opened, jobId);
			// The call RAN: the fixture's execute marker is module-side.
			expect(toolRuns).toEqual([{ ids: [7] }]);
			const conversationId = await waitForJobConversation(opened, jobId);
			const texts = await toolResultTexts(
				opened,
				conversationId,
				"acme-media/torrents_remove",
			);
			expect(texts.some((text) => text.includes("removed 7"))).toBe(true);
			// The judge answered the per-target card check questions.
			expect(
				judgeCalls.some((call) => {
					const request = call.request as { questions?: Record<string, unknown> };
					return (
						request.questions !== undefined &&
						"t0_meets" in request.questions
					);
				}),
			).toBe(true);
		},
	);

	test(
		"an uncleared job fire's call is blocked and the owner's notice is posted",
		{ timeout: 60_000 },
		async () => {
			const rig = await bootWardenServer();
			const { app, opened, faux, aliceToken } = rig;
			const jobId = await createAliceJob(opened, CLEANUP_SKILL);
			// NO clearance written: the warden's settings file is the boot's
			// empty object.
			faux.setResponses([
				fauxAssistantMessage(
					[fauxToolCall("acme-media/torrents_remove", { ids: [7] })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("blocked"),
			]);
			await opened.jobs.runNow(jobId);
			await waitForJobSettled(opened, jobId);
			// The call NEVER ran.
			expect(toolRuns).toEqual([]);
			const conversationId = await waitForJobConversation(opened, jobId);
			const texts = await toolResultTexts(
				opened,
				conversationId,
				"acme-media/torrents_remove",
			);
			// The block rides the tool result (the warden's no-escalation
			// wording names the missing inbox).
			expect(
				texts.some((text) =>
					text.includes("Not cleared for this job"),
				),
			).toBe(true);
			// The owner's notice (the `raise` absent path): the job's owner
			// gets one notice naming the held tool.
			const notices = await app.inject({
				method: "GET",
				url: "/v1/notices",
				headers: { authorization: `Bearer ${aliceToken}` },
			});
			expect(notices.statusCode).toBe(200);
			const listed = notices.json().notices as { title?: string; body?: string }[];
			expect(
				listed.some((notice) =>
					(notice.title ?? "").includes("acme-media/torrents_remove") ||
					(notice.body ?? "").includes("acme-media/torrents_remove"),
				),
			).toBe(true);
		},
	);
});
