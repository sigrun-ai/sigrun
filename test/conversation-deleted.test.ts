/**
 * Deleted conversations Task 3: the server-side read-only guard.
 *
 * A deleted conversation (`SessionMeta.deleted === true`, the owner-gated
 * PATCH flag from Task 1) stays OPENABLE — reads, SSE, fork, meta PATCH,
 * abort, and interaction answers all still work — but every op that would
 * start NEW work in it refuses with 409 `{error: "conversation_deleted"}`:
 * submissions (HTTP AND the extension host bridge), compact, configure,
 * uploads, and the extension-command invoke route. The guard is the FIRST
 * statement of submitOp, so no pending-change note lands either.
 *
 * A live run admitted BEFORE the deletion still finishes, and a question
 * it asked can still be answered afterwards. Restoring (`deleted: false`)
 * re-opens the conversation. Pre-existing submit errors keep their own
 * statuses (the submit route now honours each error's status).
 *
 * Jobs: a fixed-conversation fire aimed at a deleted conversation writes
 * an immediately-settled failed run (`error: "conversation_deleted"`,
 * `conversationId` kept) and returns the overlap-skip shape — no
 * submission, no note; restoring lets the next fire run normally.
 *
 * Notifications: consecutive `conversation_deleted` failures notify once;
 * any other failure re-arms the per-job flag. Curator: a deleted
 * conversation is not fork-review eligible.
 *
 * Hermetic pattern: faux provider + tmp workspace + `app.inject()` (see
 * server-submissions.test.ts); the extension fixtures provide the command
 * route and the interaction kind.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	fauxAssistantMessage,
	fauxProvider,
	type FauxProviderHandle,
} from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { FastifyInstance } from "fastify";
import type { JobSpec } from "@sigrun/shared/jobs";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import type { SeamHost } from "../src/harness/seam-host.js";
import { createServer } from "../src/server/index.js";
import { seededIdentity } from "./helpers/identity.js";

const COMMANDS_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-commands", "index.js"),
).href;
const DECLINABLE_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-declinable", "index.js"),
).href;

/** One hermetic server: harness + faux provider + Fastify app + workspace. */
interface TestServer {
	app: FastifyInstance;
	opened: OpenedHarness;
	faux: FauxProviderHandle;
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

/**
 * Boot a hermetic server with the command + declinable fixtures loaded.
 * `responses` scripts the faux provider (per test); `gate` holds the first
 * generation open (the live-run cases).
 */
async function bootServer(options?: {
	responses?: readonly unknown[];
	gate?: { readonly promise: Promise<void> };
}): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-deleted-"));
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	faux.setResponses(
		(options?.responses ?? [fauxAssistantMessage("ok")]) as never,
	);
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
		SIGRUN_TIMEZONE: "UTC",
	});
	// Auto-naming off: the namer consumes scripted responses.
	await writeFile(join(dir, "settings.json"), '{"namingModel": false}');
	const opened = await openHarness(config, {
		identity: await seededIdentity(dir),
		extensions: [contributor],
		env: {},
		extensionSpecifiers: [COMMANDS_SPECIFIER, DECLINABLE_SPECIFIER],
		settingsDir: dir,
	});
	const app = await createServer(opened, config);
	cleanups.push(async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	});
	return { app, opened, faux };
}

/** Create one conversation via the route; returns its id. */
async function createViaRoute(app: FastifyInstance): Promise<number> {
	const response = await app.inject({ method: "POST", url: "/v1/conversations" });
	expect(response.statusCode).toBe(201);
	return response.json().id as number;
}

/** Submit one input; returns the raw response (status varies by case). */
async function submit(app: FastifyInstance, id: number, input: unknown) {
	return app.inject({
		method: "POST",
		url: `/v1/conversations/${id}/submissions`,
		payload: { input },
		headers: { "content-type": "application/json" },
	});
}

/** `PATCH .../meta` with a JSON body. */
async function patchMeta(
	app: FastifyInstance,
	id: number,
	body: Record<string, unknown>,
) {
	return app.inject({
		method: "PATCH",
		url: `/v1/conversations/${id}/meta`,
		payload: body,
		headers: { "content-type": "application/json" },
	});
}

/** Delete (or restore) one conversation through the owner-gated meta route. */
async function setDeleted(
	app: FastifyInstance,
	id: number,
	deleted: boolean,
): Promise<void> {
	const response = await patchMeta(app, id, { deleted });
	expect(response.statusCode).toBe(200);
}

/** The conversation's durable submissions (ascending). */
async function submissionsOf(opened: OpenedHarness, id: number) {
	const page = await opened.storage.scanSubmissions(
		{ conversationId: id as ConversationId, order: "ascending" },
		100,
		undefined,
		BACKGROUND_CONTEXT,
	);
	return [...page.items];
}

/** The conversation's entry kinds, oldest first. */
async function entryKinds(
	opened: OpenedHarness,
	id: number,
): Promise<string[]> {
	const conversation = await opened.harness.conversation(
		id as ConversationId,
		BACKGROUND_CONTEXT,
	);
	const page = await conversation!.entries({}, 200, undefined, BACKGROUND_CONTEXT);
	return [...page.items].reverse().map((entry) => entry.kind);
}

/** A manual gate the faux provider holds one generation open on. */
function makeGate(): {
	readonly promise: Promise<void>;
	release(message?: string): void;
} {
	let resolve!: (message: AssistantMessage) => void;
	const promise = new Promise<AssistantMessage>((res) => {
		resolve = res;
	});
	return {
		promise: promise.then(() => undefined),
		release: () => resolve(fauxAssistantMessage("released")),
	};
}

/** Wait for the run of `submissionId` to settle (the live-run cases). */
async function waitSettled(opened: OpenedHarness): Promise<void> {
	await opened.harness.waitForIdle(BACKGROUND_CONTEXT);
}

/** Poll `check` until it holds (10ms interval, 5s cap). */
async function waitFor(check: () => boolean): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	expect(check(), "timed out waiting for the gated model call").toBe(true);
}

/** The declinable fixture's captured host (interaction seeding). */
function declinableHost(): SeamHost {
	const host = (globalThis as Record<string, unknown>).__declinableHost as
		| SeamHost
		| undefined;
	if (host === undefined) throw new Error("declinable host not captured");
	return host;
}

// ---------------------------------------------------------------------------
// The guard: every work-starting op refuses a deleted conversation
// ---------------------------------------------------------------------------

describe("a deleted conversation refuses new work", () => {
	test("a deleted conversation refuses messages, compact, configure, uploads and extension commands", { timeout: 30_000 }, async () => {
		const { app, opened } = await bootServer();
		const id = await createViaRoute(app);
		// One ordinary turn first, so the transcript has history to fork.
		const first = await submit(app, id, "hello");
		expect(first.statusCode).toBe(202);
		await waitSettled(opened);
		const before = await submissionsOf(opened, id);

		await setDeleted(app, id, true);

		// Submissions: 409 with the pinned body, and nothing admitted.
		const refused = await submit(app, id, "after delete");
		expect(refused.statusCode).toBe(409);
		expect(refused.json()).toEqual({ error: "conversation_deleted" });
		expect(await submissionsOf(opened, id)).toHaveLength(before.length);

		// Compact: 409 the same.
		const compact = await app.inject({
			method: "POST",
			url: `/v1/conversations/${id}/compact`,
			payload: {},
			headers: { "content-type": "application/json" },
		});
		expect(compact.statusCode).toBe(409);
		expect(compact.json()).toEqual({ error: "conversation_deleted" });

		// Configure: 409 the same.
		const configure = await app.inject({
			method: "POST",
			url: `/v1/conversations/${id}/configure`,
			payload: { thinking: "low" },
			headers: { "content-type": "application/json" },
		});
		expect(configure.statusCode).toBe(409);
		expect(configure.json()).toEqual({ error: "conversation_deleted" });

		// Uploads (the base64 POST route): 409 the same, no file written.
		const upload = await app.inject({
			method: "POST",
			url: `/v1/conversations/${id}/uploads`,
			payload: { name: "note.txt", contentBase64: "aGVsbG8=" },
			headers: { "content-type": "application/json" },
		});
		expect(upload.statusCode).toBe(409);
		expect(upload.json()).toEqual({ error: "conversation_deleted" });

		// The extension-command invoke route: 409 BEFORE the command runs.
		const command = await app.inject({
			method: "POST",
			url: `/v1/conversations/${id}/commands/hello`,
			payload: { args: "world" },
			headers: { "content-type": "application/json" },
		});
		expect(command.statusCode).toBe(409);
		expect(command.json()).toEqual({ error: "conversation_deleted" });
		// The command never ran (the fixture stashes its principal on invoke).
		expect(
			(globalThis as Record<string, unknown>).__fixtureCommandsPrincipal,
		).toBeUndefined();

		// The conversation itself stays openable (reads and SSE are not
		// guarded): the view still serves.
		const view = await app.inject({ method: "GET", url: `/v1/conversations/${id}` });
		expect(view.statusCode).toBe(200);
	});

	test("host.conversations.submit rejects with a ConversationOpError", { timeout: 30_000 }, async () => {
		const { app } = await bootServer();
		const id = await createViaRoute(app);
		await setDeleted(app, id, true);
		const host = app.hostBridge;
		await expect(
			host.conversations.submit(id as ConversationId, [
				{ type: "text", text: "after delete" },
			]),
		).rejects.toMatchObject({
			name: "ConversationOpError",
			body: { error: "conversation_deleted" },
			status: 409,
		});
	});

	test("existing submit errors keep 400", { timeout: 30_000 }, async () => {
		const { app, opened } = await bootServer();
		const id = await createViaRoute(app);
		// invalid_input (the parse path): a live conversation, 400 as before.
		const invalid = await submit(app, id, 42);
		expect(invalid.statusCode).toBe(400);
		expect(invalid.json()).toEqual({ error: "invalid_input" });
		// unserved_model (thrown OUTSIDE the ConversationOpError path): 400.
		const configured = await app.inject({
			method: "POST",
			url: `/v1/conversations/${id}/configure`,
			payload: { model: "faux/nonexistent" },
			headers: { "content-type": "application/json" },
		});
		expect(configured.statusCode).toBe(200);
		const unserved = await submit(app, id, "hello");
		expect(unserved.statusCode).toBe(400);
		expect(unserved.json().error).toBe("unserved_model");
		void opened;
	});
});

// ---------------------------------------------------------------------------
// What a deleted conversation still allows
// ---------------------------------------------------------------------------

describe("what a deleted conversation still allows", () => {
	test("rename, fork and interaction answers", { timeout: 30_000 }, async () => {
		const { app, opened } = await bootServer();
		const id = await createViaRoute(app);
		// One settled turn (history for the fork), then a pending question.
		const first = await submit(app, id, "hello");
		expect(first.statusCode).toBe(202);
		await waitSettled(opened);
		await declinableHost().seedInteraction(
			id as ConversationId,
			{
				kind: "decl.ask",
				callId: "del-1",
				status: "pending",
				createdAt: 1,
			} as never,
			BACKGROUND_CONTEXT,
		);

		await setDeleted(app, id, true);

		// A rename still works (patchMetaOp is not guarded).
		const renamed = await patchMeta(app, id, { name: "Renamed" });
		expect(renamed.statusCode).toBe(200);

		// An interaction answer for the pre-deletion question is accepted.
		const answered = await app.inject({
			method: "POST",
			url: `/v1/conversations/${id}/interactions/del-1/answer`,
			payload: { values: { decision: "allow" } },
			headers: { "content-type": "application/json" },
		});
		expect(answered.statusCode).toBe(200);
		expect(answered.json().status).toBe("answered");

		// Fork still works (forkOp is not guarded).
		const forked = await app.inject({
			method: "POST",
			url: `/v1/conversations/${id}/fork`,
			payload: {},
			headers: { "content-type": "application/json" },
		});
		expect(forked.statusCode).toBe(201);
	});

	test("abort on a live run succeeds after delete", { timeout: 30_000 }, async () => {
		const gate = makeGate();
		const { app, opened, faux } = await bootServer({
			responses: [async () => {
				await gate.promise;
				return fauxAssistantMessage("gated answer");
			}],
		});
		const id = await createViaRoute(app);
		const live = await submit(app, id, "hold this run");
		expect(live.statusCode).toBe(202);
		// Let the run reach the gated model call before the deletion.
		await waitFor(() => faux.state.callCount > 0);
		await setDeleted(app, id, true);
		// Abort on the live run succeeds (abortOp is not guarded). Release
		// the gate first so the held model call resolves and the abort's
		// idle wait cannot deadlock on the gated stream.
		gate.release();
		const aborted = await app.inject({
			method: "POST",
			url: `/v1/conversations/${id}/abort`,
		});
		expect(aborted.statusCode).toBe(200);
		await waitSettled(opened);
	});

	test("a live run finishes after delete; a later submit refuses", { timeout: 30_000 }, async () => {
		const gate = makeGate();
		const { app, opened, faux } = await bootServer({
			responses: [async () => {
				await gate.promise;
				return fauxAssistantMessage("gated answer");
			}],
		});
		const id = await createViaRoute(app);
		const live = await app.inject({
			method: "POST",
			url: `/v1/conversations/${id}/submissions?waitMs=10000`,
			payload: { input: "hold this run" },
			headers: { "content-type": "application/json" },
		});
		// The POST waits server-side for settlement; delete while held.
		// (Wait for the gated model call to actually start, then delete.)
		await waitFor(() => faux.state.callCount > 0);
		await setDeleted(app, id, true);
		gate.release();
		const settled = await live;
		expect(settled.statusCode).toBe(202);
		await waitSettled(opened);
		// The run answered after the deletion.
		expect((await entryKinds(opened, id))).toContain("pi.assistant");
		// A later submit refuses.
		expect((await submit(app, id, "after")).statusCode).toBe(409);
	});

	test("restoring re-opens it", { timeout: 30_000 }, async () => {
		const { app, opened } = await bootServer();
		const id = await createViaRoute(app);
		await setDeleted(app, id, true);
		expect((await submit(app, id, "while deleted")).statusCode).toBe(409);
		await setDeleted(app, id, false);
		const restored = await submit(app, id, "while restored");
		expect(restored.statusCode).toBe(202);
		await waitSettled(opened);
		expect((await entryKinds(opened, id))).toContain("pi.assistant");
	});
});

// ---------------------------------------------------------------------------
// Jobs: a fixed fire into a deleted conversation fails quietly
// ---------------------------------------------------------------------------

describe("a fixed job aimed at a deleted conversation fails quietly", () => {
	test("run-now writes a settled failed run with no submission; restore re-opens", { timeout: 30_000 }, async () => {
		const { app, opened } = await bootServer();
		const id = await createViaRoute(app);
		const spec: JobSpec = {
			name: "acme-check",
			schedule: { at: "2099-01-01T00:00:00.000Z" },
			action: {
				kind: "prompt",
				prompt: "check the acme state",
				conversation: id,
			},
		};
		const job = await opened.jobs.createApi(spec, "alice");
		await setDeleted(app, id, true);
		const before = await submissionsOf(opened, id);

		const fired = await opened.jobs.runNow(job.id);
		expect(fired).toMatchObject({ outcome: "skipped" });

		const row = await opened.jobs.get(job.id);
		expect(row?.lastRun).toMatchObject({
			outcome: "failed",
			error: "conversation_deleted",
			conversationId: id,
		});
		// No submission and no note landed in the deleted conversation.
		expect(await submissionsOf(opened, id)).toHaveLength(before.length);
		expect(await entryKinds(opened, id)).not.toContain("sigrun.blocks.note");

		// Restore and fire again: the run starts normally.
		await setDeleted(app, id, false);
		const second = await opened.jobs.runNow(job.id);
		expect(second).toMatchObject({ outcome: "running", conversationId: id });
		await waitSettled(opened);
		expect((await submissionsOf(opened, id)).length).toBeGreaterThan(
			before.length,
		);
	});
});

// (The notifications once-only case lives in test/notifications.test.ts —
// it needs that suite's real notifier fixture rig.)

// ---------------------------------------------------------------------------
// Curator: a deleted conversation is not fork-review eligible
// ---------------------------------------------------------------------------

describe("a deleted conversation is not eligible for fork review", () => {
	test("forkReviewRun refuses with the deleted reason", { timeout: 30_000 }, async () => {
		const { app, opened } = await bootServer();
		const id = await createViaRoute(app);
		const first = await submit(app, id, "hello");
		expect(first.statusCode).toBe(202);
		await waitSettled(opened);
		// The auth:none create stamps no owner; the review needs one.
		await patchMeta(app, id, { owner: "alice" });
		await setDeleted(app, id, true);
		const result = await opened.curationHost.forkReview(id as ConversationId, {
			instruction: "Review the conversation.",
			allow: ["skill_manage"],
			maxToolCalls: 4,
			maxOutputTokens: 4_000,
			deadlineMs: 5_000,
			reviewId: "deleted-review",
		});
		expect(result.status).toBe("failed");
		expect(result.error).toBe("not eligible: the conversation is deleted");
	});
});
