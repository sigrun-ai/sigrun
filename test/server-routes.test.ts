/**
 * The server-restructure regression net (W0): the route table and the
 * unknown-conversation statuses are pinned BEFORE any route moves out of
 * `src/server/index.ts`, so the split can be verified as behavior-neutral
 * per module.
 *
 * Two pins:
 *
 * - `route table is unchanged` — every path the server exposes today
 *   (the 22 `/v1` paths + the two probes), each with its method, checked
 *   through `app.hasRoute` and the printed route tree. Registration ORDER
 *   is pinned structurally by `createServer` (identity hook → webui
 *   bundle → probe/meta modules → the rest), matching today's shape.
 *
 * - `every /v1/conversations/:id route … an unknown id` — the per-route
 *   status for an id no storage ever recorded. Every `:id` route 404s
 *   `{error: "conversation_not_found"}` (bodies are sent where a route
 *   requires one, so validation order cannot mask the lookup), EXCEPT
 *   `GET …/interactions` and `GET …/ambient`: the polling convention —
 *   a channel polling a torn-down conversation must not error — those
 *   two routes never resolve the conversation at all and answer 200 with
 *   an empty list. They are the only `:id` routes that never resolve it,
 *   and they must NOT grow the conversation pre-handler in later tasks.
 *
 * Hermetic pattern: faux provider + tmp workspace + `app.inject()` (see
 * `server-submissions.test.ts`).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { createServer } from "../src/server/index.js";
import type { FastifyInstance } from "fastify";

/**
 * Every method → path pair the server registers today. Copied verbatim
 * from the inline routes; a module split that drops, renames, or
 * re-methods any route fails here.
 */
const ROUTES: ReadonlyArray<readonly [string, string]> = [
	["GET", "/healthz"],
	["GET", "/readyz"],
	["GET", "/v1/meta"],
	["GET", "/v1/commands"],
	["GET", "/v1/auth/check"],
	["GET", "/v1/models"],
	["GET", "/v1/settings"],
	["PATCH", "/v1/settings"],
	["POST", "/v1/conversations"],
	["GET", "/v1/conversations"],
	["POST", "/v1/conversations/import"],
	["GET", "/v1/conversations/:id"],
	["GET", "/v1/conversations/:id/stream"],
	["POST", "/v1/conversations/:id/submissions"],
	["POST", "/v1/conversations/:id/configure"],
	["POST", "/v1/conversations/:id/abort"],
	["GET", "/v1/conversations/:id/interactions"],
	["POST", "/v1/conversations/:id/interactions/:callId/answer"],
	["GET", "/v1/conversations/:id/ambient"],
	["POST", "/v1/conversations/:id/compact"],
	["POST", "/v1/conversations/:id/fork"],
	["GET", "/v1/conversations/:id/export"],
	["GET", "/v1/conversations/:id/meta"],
	["PATCH", "/v1/conversations/:id/meta"],
	["POST", "/v1/conversations/:id/uploads"],
	["GET", "/v1/conversations/:id/files"],
	["GET", "/v1/conversations/:id/files/content"],
];

/** One unknown-id probe: where the route requires a body, a VALID one. */
interface UnknownIdCase {
	readonly method: "GET" | "POST" | "PATCH";
	readonly url: string;
	/** A body that passes the route's own validation (so only the lookup can answer). */
	readonly payload?: unknown;
	readonly status: number;
	readonly body: unknown;
}

/**
 * The unknown-conversation id every case probes. Storage assigns low
 * integer ids; 999999 was never recorded.
 */
const UNKNOWN_ID = 999999;

const UNKNOWN_ID_CASES: readonly UnknownIdCase[] = [
	{
		method: "GET",
		url: `/v1/conversations/${UNKNOWN_ID}`,
		status: 404,
		body: { error: "conversation_not_found" },
	},
	{
		// Plain JSON 404 BEFORE the SSE upgrade: the reply must not be
		// hijacked for an unknown id.
		method: "GET",
		url: `/v1/conversations/${UNKNOWN_ID}/stream`,
		status: 404,
		body: { error: "conversation_not_found" },
	},
	{
		method: "POST",
		url: `/v1/conversations/${UNKNOWN_ID}/submissions`,
		payload: { input: [{ type: "text", text: "x" }] },
		status: 404,
		body: { error: "conversation_not_found" },
	},
	{
		method: "POST",
		url: `/v1/conversations/${UNKNOWN_ID}/configure`,
		payload: { thinking: "high" },
		status: 404,
		body: { error: "conversation_not_found" },
	},
	{
		method: "POST",
		url: `/v1/conversations/${UNKNOWN_ID}/abort`,
		status: 404,
		body: { error: "conversation_not_found" },
	},
	{
		// The polling convention: this route never resolves the
		// conversation — an absent one answers 200 + empty list.
		method: "GET",
		url: `/v1/conversations/${UNKNOWN_ID}/interactions`,
		status: 200,
		body: { interactions: [] },
	},
	{
		method: "POST",
		url: `/v1/conversations/${UNKNOWN_ID}/interactions/x/answer`,
		payload: { ids: ["a"] },
		status: 404,
		body: { error: "conversation_not_found" },
	},
	{
		// The polling convention, ambient side: 200 + empty list for an
		// absent conversation.
		method: "GET",
		url: `/v1/conversations/${UNKNOWN_ID}/ambient`,
		status: 200,
		body: { ambient: [] },
	},
	{
		method: "POST",
		url: `/v1/conversations/${UNKNOWN_ID}/compact`,
		payload: {},
		status: 404,
		body: { error: "conversation_not_found" },
	},
	{
		method: "POST",
		url: `/v1/conversations/${UNKNOWN_ID}/fork`,
		payload: {},
		status: 404,
		body: { error: "conversation_not_found" },
	},
	{
		method: "GET",
		url: `/v1/conversations/${UNKNOWN_ID}/export`,
		status: 404,
		body: { error: "conversation_not_found" },
	},
	{
		method: "GET",
		url: `/v1/conversations/${UNKNOWN_ID}/meta`,
		status: 404,
		body: { error: "conversation_not_found" },
	},
	{
		method: "PATCH",
		url: `/v1/conversations/${UNKNOWN_ID}/meta`,
		payload: { pinned: true },
		status: 404,
		body: { error: "conversation_not_found" },
	},
	{
		method: "POST",
		url: `/v1/conversations/${UNKNOWN_ID}/uploads`,
		payload: { name: "x.txt", contentBase64: "aGk=" },
		status: 404,
		body: { error: "conversation_not_found" },
	},
	{
		method: "GET",
		url: `/v1/conversations/${UNKNOWN_ID}/files`,
		status: 404,
		body: { error: "conversation_not_found" },
	},
	{
		method: "GET",
		url: `/v1/conversations/${UNKNOWN_ID}/files/content?path=a`,
		status: 404,
		body: { error: "conversation_not_found" },
	},
];

/** One hermetic server: harness + faux provider + Fastify app. */
interface TestServer {
	app: FastifyInstance;
	opened: OpenedHarness;
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

/** Boot a hermetic server (the `server-submissions.test.ts` shape). */
async function bootServer(): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-routes-"));
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
		SIGRUN_WORKSPACE_PATH: dir,
		// Hermetic: a dev checkout with a built `webui/dist` would otherwise
		// register the catch-all static route (`*`); the table under test is
		// the API surface (the webui mount has its own coverage).
		SIGRUN_WEBUI: "false",
	});
	const opened = await openHarness(config, {
		extensions: [contributor],
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

describe("server route table", () => {
	test("route table is unchanged", async () => {
		const { app } = await bootServer();
		// The printed tree collapses shared prefixes onto parent lines, so
		// full paths are reconstructed by accumulating segments per depth —
		// then compared as an exact SET: a split that drops, renames, adds,
		// or re-nests any route fails here.
		const printed = app.printRoutes({ commonPrefix: false });
		const markers = ["├── ", "└── ", "│   ", "    "];
		const segments: string[] = [];
		const paths = new Set<string>();
		for (const raw of printed.split("\n")) {
			let line = raw;
			let depth = 0;
			for (;;) {
				const marker = markers.find((m) => line.startsWith(m));
				if (marker === undefined) break;
				line = line.slice(marker.length);
				depth++;
			}
			if (line === "") continue;
			const paren = line.indexOf(" (");
			segments[depth - 1] = paren === -1 ? line : line.slice(0, paren);
			segments.length = depth;
			paths.add(segments.join(""));
		}
		expect([...paths].sort()).toEqual(
			[
				"/healthz",
				"/readyz",
				"/v1/meta",
				"/v1/commands",
				"/v1/auth/check",
				"/v1/models",
				"/v1/settings",
				"/v1/conversations",
				"/v1/conversations/import",
				"/v1/conversations/:id",
				"/v1/conversations/:id/stream",
				"/v1/conversations/:id/submissions",
				"/v1/conversations/:id/configure",
				"/v1/conversations/:id/abort",
				"/v1/conversations/:id/interactions",
				"/v1/conversations/:id/interactions/:callId/answer",
				"/v1/conversations/:id/ambient",
				"/v1/conversations/:id/compact",
				"/v1/conversations/:id/fork",
				"/v1/conversations/:id/export",
				"/v1/conversations/:id/meta",
				"/v1/conversations/:id/uploads",
				"/v1/conversations/:id/files",
				"/v1/conversations/:id/files/content",
			].sort(),
		);
		// And every method binds to its path.
		for (const [method, url] of ROUTES) {
			expect(
				app.hasRoute({ method, url }),
				`hasRoute must be true for ${method} ${url}`,
			).toBe(true);
		}
	});
});

describe("unknown conversation id", () => {
	test("every /v1/conversations/:id route 404s an unknown id except the polling surfaces", async () => {
		const { app } = await bootServer();
		for (const testCase of UNKNOWN_ID_CASES) {
			const response = await app.inject({
				method: testCase.method,
				url: testCase.url,
				...(testCase.payload === undefined
					? {}
					: {
							payload: testCase.payload as Record<string, unknown>,
							headers: { "content-type": "application/json" },
						}),
			});
			expect(
				response.statusCode,
				`status for ${testCase.method} ${testCase.url}`,
			).toBe(testCase.status);
			expect(response.json(), `body for ${testCase.method} ${testCase.url}`).toEqual(
				testCase.body,
			);
		}
	});
});
