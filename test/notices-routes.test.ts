/**
 * Notices Task 4: the `/v1/notices` routes, the real `runAction` dispatch
 * order, and the user-only `notice.changed` delivery on `/v1/events`.
 *
 * Hermetic pattern (notices-service.test.ts): a real harness + real
 * Fastify app (`createServer`) over a faux provider, tmp dirs, and
 * `app.inject()`; fixtures are `file://`-imported by the same URL the
 * loader used, so the test and the extension see ONE module instance.
 * The event assertions open a REAL loopback socket (a hijacked SSE reply
 * never settles under light-my-request — the events-stream.test.ts
 * pattern).
 *
 * Dispatch order under test (the brief's, differing from Task 3's
 * scaffold): rate-limit → dedup → notice lookup → action find → binding
 * find → handler call. The dedup key carries the principal's user
 * (`notice<user><id><actionId>`), so one user's requestId never
 * replays another user's result.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import http from "node:http";
import { afterAll, describe, expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { createServer } from "../src/server/index.js";
import { NoticeStore } from "../src/notices/store.js";
import { seededIdentity } from "./helpers/identity.js";

/** The valid noticeActions fixture (`acme-notes`, handlers ping/hold). */
const NOTES_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-notice-actions", "index.js"),
).href;

/** The fixture module's exports (the invocation record + its reset). */
type FixtureModule = {
	readonly calls: readonly {
		user: string | undefined;
		payload: unknown;
		noticeId: string;
	}[];
	readonly resetCalls: () => void;
};

/** Import the fixture module by the SAME URL the loader imported. */
async function fixtureModule(): Promise<FixtureModule> {
	return (await import(NOTES_SPECIFIER)) as unknown as FixtureModule;
}

/** One hermetic server with alice (admin) and bob in the directory. */
interface TestRig {
	readonly app: FastifyInstance;
	readonly opened: OpenedHarness;
	readonly dir: string;
	readonly tokens: { readonly alice: string; readonly bob: string };
	readonly close: () => Promise<void>;
}

async function bootRig(options?: {
	readonly extensionSpecifiers?: readonly string[];
	readonly noticeActionTimeoutMs?: number;
	readonly auth?: "token" | "none";
	/** Seed alice only (the naive-auth rig: multi-user refuses boot). */
	readonly skipBob?: boolean;
}): Promise<TestRig> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-notices-routes-"));
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
		SIGRUN_DATA_DIR: join(dir, "data"),
		SIGRUN_CACHE_DIR: join(dir, "cache"),
		SIGRUN_STATE_DIR: join(dir, "state"),
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_AUTH: options?.auth ?? "token",
		SIGRUN_API_TOKEN: "service-token-for-notices-route-tests",
		SIGRUN_WORKSPACE_PATH: dir,
		SIGRUN_CONFIG_DIR: join(dir, "config"),
	});
	const identity = await seededIdentity(dir, "alice");
	if (options?.skipBob !== true && identity.users.get("bob") === undefined) {
		await identity.users.add({ user: "bob", admin: false, source: "cli" });
	}
	const opened = await openHarness(config, {
		identity,
		extensions: [contributor],
		env: { SIGRUN_CONFIG_DIR: join(dir, "config") },
		settingsDir: dir,
		builtins: false,
		...(options?.extensionSpecifiers === undefined
			? {}
			: { extensionSpecifiers: options.extensionSpecifiers }),
		expectHostBridge: true,
	});
	const app = await createServer(opened, config, [], {
		listenHost: "127.0.0.1",
		...(options?.noticeActionTimeoutMs === undefined
			? {}
			: { noticeActionTimeoutMs: options.noticeActionTimeoutMs }),
	});
	const tokens = {
		alice: (await opened.identity.tokens.create("alice-test", "alice")).token,
		bob: (await opened.identity.tokens.create("bob-test", "bob")).token,
	};
	return {
		app,
		opened,
		dir,
		tokens,
		close: async () => {
			await app.close();
			await opened.harness.close(BACKGROUND_CONTEXT);
			await rm(dir, { recursive: true, force: true });
		},
	};
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

/** The authorization header for one rig user. */
function auth(rig: TestRig, user: "alice" | "bob"): Record<string, string> {
	return { authorization: `Bearer ${rig.tokens[user]}` };
}

/** Post one notice as the fixture extension (via the service). */
async function postNotice(
	rig: TestRig,
	input: Record<string, unknown>,
): Promise<string> {
	const posted = await rig.app.sigrunContext.notices.post("acme-notes", {
		user: "alice",
		title: "route notice",
		...input,
	});
	return posted.id;
}

// ─── the SSE collector (curation-e2e.test.ts's shape) ─────────────────────

/** One parsed SSE frame from a loopback /v1/events connection. */
interface HostFrame {
	readonly event: string;
	readonly data: Record<string, unknown>;
}

/** Collect every frame a loopback /v1/events connection sees. */
class EventsConnection {
	private readonly events: HostFrame[] = [];
	private buffer = "";
	#request: http.ClientRequest | undefined;

	constructor(
		private readonly port: number,
		private readonly headers: Record<string, string>,
	) {}

	/** Open the stream; resolves once headers arrived (subscription live). */
	open(): Promise<void> {
		return new Promise((resolve, reject) => {
			const request = http.get({
				host: "127.0.0.1",
				port: this.port,
				path: "/v1/events",
				headers: this.headers,
				agent: false,
			});
			this.#request = request;
			request.on("error", (error) => reject(error));
			request.on("response", (incoming) => {
				incoming.setEncoding("utf8");
				incoming.on("data", (chunk: string) => {
					this.buffer += chunk;
					this.drain();
				});
				incoming.on("error", () => {});
				resolve();
			});
		});
	}

	private drain(): void {
		for (;;) {
			const boundary = this.buffer.indexOf("\n\n");
			if (boundary === -1) return;
			const frame = this.buffer.slice(0, boundary);
			this.buffer = this.buffer.slice(boundary + 2);
			let event = "";
			let data = "";
			for (const line of frame.split("\n")) {
				if (line.startsWith(":")) continue;
				if (line.startsWith("event:")) event = line.slice(6).trim();
				else if (line.startsWith("data:")) data += line.slice(5).trim();
			}
			if (data === "") continue;
			this.events.push({
				event,
				data: JSON.parse(data) as HostFrame["data"],
			});
		}
	}

	/** Every `notice.changed` frame seen so far. */
	noticeFrames(): readonly HostFrame[] {
		return this.events.filter((frame) => frame.event === "notice.changed");
	}

	/** Every parsed frame so far (the waitFor predicate's source). */
	eventsSoFar(): readonly HostFrame[] {
		return [...this.events];
	}

	/** Destroy the socket — the SSE request otherwise never ends. */
	close(): void {
		this.#request?.destroy();
	}
}

/**
 * Resolves once `predicate` accepts one of the stream's frames (the
 * events-stream.test.ts waitFor pattern: wait on the condition, never
 * a fixed sleep). `timeoutMs` bounds the wait so a missing frame fails
 * the test rather than hanging it.
 */
async function waitFor(
	stream: EventsConnection,
	predicate: (frame: HostFrame) => boolean,
	timeoutMs = 15_000,
): Promise<HostFrame> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const found = stream.eventsSoFar().find(predicate);
		if (found !== undefined) return found;
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			throw new Error(
				`timed out after ${timeoutMs}ms; events so far: ${JSON.stringify(
					stream.eventsSoFar().map((frame) => frame.event),
				)}`,
			);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

// ---------------------------------------------------------------------------
// Review Focus 1: foreign visibility + the event
// ---------------------------------------------------------------------------

test("foreign notice is invisible on every route and event", { timeout: 30_000 }, async () => {
	const rig = await bootRig({
		extensionSpecifiers: [NOTES_SPECIFIER],
	});
	cleanups.push(rig.close);
	await rig.app.listen({ port: 0, host: "127.0.0.1" });
	const address = rig.app.server.address();
	if (address === null || typeof address === "string") {
		throw new Error("listen did not bind a port");
	}
	const port = address.port;
	const aliceStream = new EventsConnection(port, auth(rig, "alice"));
	const bobStream = new EventsConnection(port, auth(rig, "bob"));
	await aliceStream.open();
	await bobStream.open();
	try {
		const id = await postNotice(rig, {
			actions: [
				{ id: "go", label: "Go", kind: "extension", name: "ping" },
			],
		});
		// Bob's routes: the foreign id 404s everywhere.
		for (const [method, url] of [
			["POST", `/v1/notices/${id}/dismiss`],
			["POST", `/v1/notices/${id}/actions/go`],
		] as const) {
			const response = await rig.app.inject({
				method,
				url,
				headers: { ...auth(rig, "bob"), "content-type": "application/json" },
				payload: {},
			});
			expect(response.statusCode).toBe(404);
			expect(response.json()).toEqual({ error: "notice_not_found" });
		}
		const bobGet = await rig.app.inject({
			method: "GET",
			url: "/v1/notices",
			headers: auth(rig, "bob"),
		});
		expect(bobGet.statusCode).toBe(200);
		expect(bobGet.json()).toEqual({ notices: [] });
		// The event: alice's stream saw it; bob's never does. Wait on the
		// condition (the events-stream waitFor pattern), never a fixed
		// sleep.
		const aliceFrame = await waitFor(
			aliceStream,
			(frame) => frame.event === "notice.changed",
		);
		expect(aliceFrame.data).toEqual({
			type: "notice.changed",
			ids: [id],
			change: "posted",
		});
		expect(aliceFrame.data.user).toBeUndefined();
		expect(bobStream.noticeFrames()).toHaveLength(0);
	} finally {
		aliceStream.close();
		bobStream.close();
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
});

// ---------------------------------------------------------------------------
// The reads
// ---------------------------------------------------------------------------

test("user-less principal: GET → []", async () => {
	// The naive loopback posture (SIGRUN_AUTH "none") stamps
	// `principal.user === undefined` when no X-Sigrun-User header rides
	// (pipeline.ts stage 5/6): THE user-less shape. A service-token rig
	// never is — its principal carries `service.user`.
	const rig = await bootRig({
		extensionSpecifiers: [NOTES_SPECIFIER],
		auth: "none",
		// The naive loopback posture refuses a multi-user boot (the
		// multi-user gate): this rig seeds alice only.
		skipBob: true,
	});
	cleanups.push(rig.close);
	// A user-less principal never sees another user's pile (the post
	// lands in alice's store through the service, off the HTTP path).
	await postNotice(rig, {});
	const response = await rig.app.inject({
		method: "GET",
		url: "/v1/notices",
	});
	expect(response.statusCode).toBe(200);
	expect(response.json()).toEqual({ notices: [] });
	// Its dismiss is the same 404 a foreign id is.
	const dismiss = await rig.app.inject({
		method: "POST",
		url: "/v1/notices/some-id/dismiss",
	});
	expect(dismiss.statusCode).toBe(404);
	expect(dismiss.json()).toEqual({ error: "notice_not_found" });
	// And its action POST is the same 404.
	const action = await rig.app.inject({
		method: "POST",
		url: "/v1/notices/some-id/actions/go",
		headers: { "content-type": "application/json" },
		payload: {},
	});
	expect(action.statusCode).toBe(404);
	expect(action.json()).toEqual({ error: "notice_not_found" });
});

test("dismiss and dismiss-all", async () => {
	const rig = await bootRig({ extensionSpecifiers: [NOTES_SPECIFIER] });
	cleanups.push(rig.close);
	const first = await postNotice(rig, { title: "first" });
	const second = await postNotice(rig, { title: "second" });
	// One dismiss.
	const dismissed = await rig.app.inject({
		method: "POST",
		url: `/v1/notices/${first}/dismiss`,
		headers: auth(rig, "alice"),
	});
	expect(dismissed.statusCode).toBe(204);
	let listed = await rig.app.inject({
		method: "GET",
		url: "/v1/notices",
		headers: auth(rig, "alice"),
	});
	expect(listed.json().notices.map((notice: { id: string }) => notice.id)).toEqual([
		second,
	]);
	// A repeat dismiss of the same id is a 404 (it is gone).
	const again = await rig.app.inject({
		method: "POST",
		url: `/v1/notices/${first}/dismiss`,
		headers: auth(rig, "alice"),
	});
	expect(again.statusCode).toBe(404);
	expect(again.json()).toEqual({ error: "notice_not_found" });
	// dismiss-all clears the rest.
	const all = await rig.app.inject({
		method: "POST",
		url: "/v1/notices/dismiss-all",
		headers: auth(rig, "alice"),
	});
	expect(all.statusCode).toBe(204);
	listed = await rig.app.inject({
		method: "GET",
		url: "/v1/notices",
		headers: auth(rig, "alice"),
	});
	expect(listed.json()).toEqual({ notices: [] });
});

// ---------------------------------------------------------------------------
// The action dispatch
// ---------------------------------------------------------------------------

test("an extension action ok:true clears; keep:true keeps; ok:false keeps and returns the error", async () => {
	const rig = await bootRig({ extensionSpecifiers: [NOTES_SPECIFIER] });
	cleanups.push(rig.close);
	rig.app.sigrunContext.notices.setRateLimitDisabled(true);
	// ok:true clears.
	const cleared = await postNotice(rig, {
		actions: [
			{ id: "go", label: "Go", kind: "extension", name: "ping" },
		],
	});
	const okResponse = await rig.app.inject({
		method: "POST",
		url: `/v1/notices/${cleared}/actions/go`,
		headers: { ...auth(rig, "alice"), "content-type": "application/json" },
		payload: {},
	});
	expect(okResponse.statusCode).toBe(200);
	expect(okResponse.json()).toEqual({ ok: true, message: "pong" });
	let listed = await rig.app.inject({
		method: "GET",
		url: "/v1/notices",
		headers: auth(rig, "alice"),
	});
	expect(listed.json().notices.map((notice: { id: string }) => notice.id)).not.toContain(
		cleared,
	);
	// keep:true keeps.
	const kept = await postNotice(rig, {
		actions: [
			{ id: "stay", label: "Stay", kind: "extension", name: "hold" },
		],
	});
	const keepResponse = await rig.app.inject({
		method: "POST",
		url: `/v1/notices/${kept}/actions/stay`,
		headers: { ...auth(rig, "alice"), "content-type": "application/json" },
		payload: {},
	});
	expect(keepResponse.statusCode).toBe(200);
	listed = await rig.app.inject({
		method: "GET",
		url: "/v1/notices",
		headers: auth(rig, "alice"),
	});
	expect(listed.json().notices.map((notice: { id: string }) => notice.id)).toContain(kept);
	// ok:false keeps and returns the error.
	const failed = await postNotice(rig, {
		actions: [
			{ id: "fail", label: "Fail", kind: "extension", name: "fail" },
		],
	});
	const failResponse = await rig.app.inject({
		method: "POST",
		url: `/v1/notices/${failed}/actions/fail`,
		headers: { ...auth(rig, "alice"), "content-type": "application/json" },
		payload: {},
	});
	expect(failResponse.statusCode).toBe(200);
	expect(failResponse.json()).toEqual({
		ok: false,
		error: { message: "deliberate failure" },
	});
	listed = await rig.app.inject({
		method: "GET",
		url: "/v1/notices",
		headers: auth(rig, "alice"),
	});
	expect(listed.json().notices.map((notice: { id: string }) => notice.id)).toContain(
		failed,
	);
});

test("handler throws maps the message and keeps the notice", async () => {
	const rig = await bootRig({ extensionSpecifiers: [NOTES_SPECIFIER] });
	cleanups.push(rig.close);
	rig.app.sigrunContext.notices.setRateLimitDisabled(true);
	const id = await postNotice(rig, {
		actions: [
			{ id: "boom", label: "Boom", kind: "extension", name: "explode" },
		],
	});
	const response = await rig.app.inject({
		method: "POST",
		url: `/v1/notices/${id}/actions/boom`,
		headers: { ...auth(rig, "alice"), "content-type": "application/json" },
		payload: {},
	});
	expect(response.statusCode).toBe(200);
	expect(response.json()).toEqual({
		ok: false,
		error: { message: "kaboom" },
	});
	// The threw branch keeps the notice.
	const listed = await rig.app.inject({
		method: "GET",
		url: "/v1/notices",
		headers: auth(rig, "alice"),
	});
	expect(listed.json().notices.map((notice: { id: string }) => notice.id)).toContain(id);
});

test("handler timeout keeps the notice", async () => {
	const rig = await bootRig({
		extensionSpecifiers: [NOTES_SPECIFIER],
		noticeActionTimeoutMs: 50,
	});
	cleanups.push(rig.close);
	rig.app.sigrunContext.notices.setRateLimitDisabled(true);
	const id = await postNotice(rig, {
		actions: [
			{ id: "slow", label: "Slow", kind: "extension", name: "slow" },
		],
	});
	const response = await rig.app.inject({
		method: "POST",
		url: `/v1/notices/${id}/actions/slow`,
		headers: { ...auth(rig, "alice"), "content-type": "application/json" },
		payload: {},
	});
	expect(response.statusCode).toBe(200);
	expect(response.json()).toEqual({
		ok: false,
		error: { message: "timed out" },
	});
	// The notice stayed (the late settlement is dropped).
	const listed = await rig.app.inject({
		method: "GET",
		url: "/v1/notices",
		headers: auth(rig, "alice"),
	});
	expect(listed.json().notices.map((notice: { id: string }) => notice.id)).toContain(id);
	// Give the abandoned handler time to settle (the fixture settles at
	// 200 ms; the wait must pass it so a late dismiss WOULD show) — the
	// notice still stays.
	await new Promise((resolve) => setTimeout(resolve, 250));
	const after = await rig.app.inject({
		method: "GET",
		url: "/v1/notices",
		headers: auth(rig, "alice"),
	});
	expect(after.json().notices.map((notice: { id: string }) => notice.id)).toContain(id);
});

test("a replayed requestId returns the first response without re-running the handler, even after the ok:true dismissed the notice", async () => {
	const rig = await bootRig({ extensionSpecifiers: [NOTES_SPECIFIER] });
	cleanups.push(rig.close);
	rig.app.sigrunContext.notices.setRateLimitDisabled(true);
	const fixture = await fixtureModule();
	fixture.resetCalls();
	const id = await postNotice(rig, {
		actions: [
			{ id: "go", label: "Go", kind: "extension", name: "ping" },
		],
	});
	const run = () =>
		rig.app.inject({
			method: "POST",
			url: `/v1/notices/${id}/actions/go`,
			headers: { ...auth(rig, "alice"), "content-type": "application/json" },
			payload: { requestId: "req-1" },
		});
	const first = await run();
	expect(first.statusCode).toBe(200);
	expect(first.json()).toEqual({ ok: true, message: "pong" });
	expect(fixture.calls).toHaveLength(1);
	// The notice is gone (ok:true cleared it) — a replay must still
	// answer the FIRST response, never a fresh 404.
	const replay = await run();
	expect(replay.statusCode).toBe(200);
	expect(replay.json()).toEqual({ ok: true, message: "pong" });
	expect(fixture.calls).toHaveLength(1);
});

test("bob reusing alice's requestId gets no replay of alice's result", async () => {
	const rig = await bootRig({ extensionSpecifiers: [NOTES_SPECIFIER] });
	cleanups.push(rig.close);
	rig.app.sigrunContext.notices.setRateLimitDisabled(true);
	const fixture = await fixtureModule();
	fixture.resetCalls();
	const id = await postNotice(rig, {
		actions: [
			{ id: "go", label: "Go", kind: "extension", name: "ping" },
		],
	});
	const aliceResponse = await rig.app.inject({
		method: "POST",
		url: `/v1/notices/${id}/actions/go`,
		headers: { ...auth(rig, "alice"), "content-type": "application/json" },
		payload: { requestId: "req-shared" },
	});
	expect(aliceResponse.statusCode).toBe(200);
	expect(fixture.calls).toHaveLength(1);
	// Bob's same requestId against the same notice is NOT alice's replay —
	// the dedup key carries the user, so his request runs fresh (and 404s:
	// the notice is alice's, invisible to him).
	const bobResponse = await rig.app.inject({
		method: "POST",
		url: `/v1/notices/${id}/actions/go`,
		headers: { ...auth(rig, "bob"), "content-type": "application/json" },
		payload: { requestId: "req-shared" },
	});
	expect(bobResponse.statusCode).toBe(404);
	expect(bobResponse.json()).toEqual({ error: "notice_not_found" });
	// The handler never ran a second time.
	expect(fixture.calls).toHaveLength(1);
});

test("the 41st rapid call is 429", async () => {
	// Freeze only Date: the burst assertion must not gain refill tokens
	// when a loaded worker takes longer to issue the 41 calls.
	vi.useFakeTimers({ toFake: ["Date"] });
	const rig = await bootRig({ extensionSpecifiers: [NOTES_SPECIFIER] });
	cleanups.push(rig.close);
	const id = await postNotice(rig, {
		actions: [
			{ id: "stay", label: "Stay", kind: "extension", name: "hold" },
		],
	});
	let last: Awaited<ReturnType<typeof rig.app.inject>> | undefined;
	for (let index = 0; index < 41; index += 1) {
		last = await rig.app.inject({
			method: "POST",
			url: `/v1/notices/${id}/actions/stay`,
			headers: { ...auth(rig, "alice"), "content-type": "application/json" },
			payload: {},
		});
	}
	expect(last?.statusCode).toBe(429);
	expect(last?.json()).toEqual({ error: "rate_limited" });
});

test("unknown actionId → 400; a navigate action id → 400", async () => {
	const rig = await bootRig({ extensionSpecifiers: [NOTES_SPECIFIER] });
	cleanups.push(rig.close);
	rig.app.sigrunContext.notices.setRateLimitDisabled(true);
	const id = await postNotice(rig, {
		actions: [
			{
				id: "go",
				label: "Go",
				kind: "navigate",
				target: { conversation: 1 },
			},
		],
	});
	for (const actionId of ["nope", "go"]) {
		const response = await rig.app.inject({
			method: "POST",
			url: `/v1/notices/${id}/actions/${actionId}`,
			headers: { ...auth(rig, "alice"), "content-type": "application/json" },
			payload: {},
		});
		expect(response.statusCode).toBe(400);
		expect(response.json()).toEqual({ error: "unknown_action" });
	}
});

test("extension unloaded → 409, dismiss still works", async () => {
	const rig = await bootRig({ extensionSpecifiers: [NOTES_SPECIFIER] });
	cleanups.push(rig.close);
	rig.app.sigrunContext.notices.setRateLimitDisabled(true);
	// A raw store write bypasses the declared-handler gate — the shape a
	// since-disabled extension's notice takes (the §3 posture).
	const store = new NoticeStore({
		userArea: join(rig.dir, "data", "users", "alice"),
		user: "alice",
		userCreatedAt: () =>
			rig.opened.identity.users.get("alice")?.createdAt,
		now: () => new Date(),
		onChange: () => {},
		log: () => {},
	});
	const orphan = await store.post("acme-other", {
		user: "alice",
		title: "orphaned action",
		actions: [{ id: "go", label: "Go", kind: "extension", name: "ping" }],
	});
	const action = await rig.app.inject({
		method: "POST",
		url: `/v1/notices/${orphan.id}/actions/go`,
		headers: { ...auth(rig, "alice"), "content-type": "application/json" },
		payload: {},
	});
	expect(action.statusCode).toBe(409);
	expect(action.json()).toEqual({ error: "notice_action_unavailable" });
	// The notice stays dismissible: the user can always clear it.
	const dismissed = await rig.app.inject({
		method: "POST",
		url: `/v1/notices/${orphan.id}/dismiss`,
		headers: auth(rig, "alice"),
	});
	expect(dismissed.statusCode).toBe(204);
	const listed = await rig.app.inject({
		method: "GET",
		url: "/v1/notices",
		headers: auth(rig, "alice"),
	});
	expect(listed.json().notices.map((notice: { id: string }) => notice.id)).not.toContain(
		orphan.id,
	);
});
