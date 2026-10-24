/**
 * The server-restructure regression net (W0): the route table and the
 * unknown-conversation statuses are pinned BEFORE any route moves out of
 * `src/server/index.ts`, so the split can be verified as behavior-neutral
 * per module.
 *
 * Two pins:
 *
 * - `route table is unchanged` — every path the server exposes today
 *   (the 22 `/v1` paths + the two probes + `/metrics`), each with its
 *   method, checked
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
import { seededIdentity } from "./helpers/identity.js";
import type { FastifyInstance } from "fastify";

/**
 * Every method → path pair the server registers today. Copied verbatim
 * from the inline routes; a module split that drops, renames, or
 * re-methods any route fails here.
 */
const ROUTES: ReadonlyArray<readonly [string, string]> = [
	["GET", "/healthz"],
	["GET", "/readyz"],
	["GET", "/metrics"],
	["GET", "/v1/meta"],
	["GET", "/v1/commands"],
	["GET", "/v1/auth/check"],
	// The W1 Task 6 provider-readiness home + the deprecated alias.
	["GET", "/v1/providers"],
	// The W3 Task 6 provider mutations (refresh + admin credential
	// write/remove).
	["POST", "/v1/providers/:id/refresh"],
	["PUT", "/v1/providers/:id/credential"],
	["DELETE", "/v1/providers/:id/credential"],
	// The W1 Task 3 auth surface (routes/auth.ts).
	["POST", "/v1/auth/login"],
	["POST", "/v1/auth/logout"],
	["GET", "/v1/auth/whoami"],
	// The W1 Task 4 token management (routes/auth.ts).
	["GET", "/v1/auth/tokens"],
	["POST", "/v1/auth/tokens"],
	["DELETE", "/v1/auth/tokens/:id"],
	// The W1 Task 4 onboarding surface (routes/onboarding.ts).
	["GET", "/v1/onboarding"],
	["POST", "/v1/onboarding/claim"],
	// The W1 Task 4 users + invites surface (routes/users.ts).
	["GET", "/v1/users"],
	["PATCH", "/v1/users/:user"],
	["POST", "/v1/users/invites"],
	["DELETE", "/v1/users/:user"],
	["GET", "/v1/models"],
	["GET", "/v1/settings"],
	["PATCH", "/v1/settings"],
	// The U4 Task 4 sections route (the settings panel's nav + search).
	["GET", "/v1/settings/sections"],
	// The W3 Task 7 extension settings/secrets surface (spec §7.7).
	["GET", "/v1/extensions"],
	["GET", "/v1/extensions/:slug/settings"],
	["PUT", "/v1/extensions/:slug/settings"],
	["GET", "/v1/extensions/:slug/secrets"],
	["PUT", "/v1/extensions/:slug/secrets/:key"],
	["DELETE", "/v1/extensions/:slug/secrets/:key"],
	// The UI-blocks U3 Task 2 surface routes (spec §7.2).
	["GET", "/v1/ext/:slug/surfaces/:id"],
	["GET", "/v1/ext/:slug/surfaces/:id/data"],
	["POST", "/v1/ext/:slug/surfaces/:id/actions"],
	["PUT", "/v1/ext/:slug/surfaces/:id/uploads/:field/:name"],
	["GET", "/v1/ext/:slug/assets/*"],
	// The cross-conversation pending inbox (W3 Task 5, spec §7.5).
	["GET", "/v1/interactions"],
	["POST", "/v1/conversations"],
	["GET", "/v1/conversations"],
	["POST", "/v1/conversations/import"],
	["GET", "/v1/conversations/:id"],
	["GET", "/v1/conversations/:id/stream"],
	["POST", "/v1/conversations/:id/submissions"],
	["GET", "/v1/conversations/:id/submissions/:submissionId"],
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
	["PUT", "/v1/conversations/:id/uploads/:name"],
	["GET", "/v1/conversations/:id/files"],
	["GET", "/v1/conversations/:id/files/content"],
	// The W3 Task 7 bounded raw file read (spec §7.8).
	["GET", "/v1/conversations/:id/files/raw"],
];

/** One unknown-id probe: where the route requires a body, a VALID one. */
interface UnknownIdCase {
	readonly method: "GET" | "POST" | "PATCH" | "PUT";
	readonly url: string;
	/** A body that passes the route's own validation (so only the lookup can answer). */
	readonly payload?: unknown;
	/** The payload's content type (JSON by default; the raw PUT sends octet-stream). */
	readonly contentType?: string;
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
		method: "GET",
		url: `/v1/conversations/${UNKNOWN_ID}/submissions/1`,
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
		// The raw §6.2 upload route: an octet-stream body, so only the
		// conversation lookup can answer.
		method: "PUT",
		url: `/v1/conversations/${UNKNOWN_ID}/uploads/x.txt`,
		payload: Buffer.from("x"),
		contentType: "application/octet-stream",
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
async function bootServer(options?: {
	readonly auth?: string;
}): Promise<TestServer> {
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
		SIGRUN_AUTH: options?.auth ?? "none",
		SIGRUN_WORKSPACE_PATH: dir,
		// Hermetic: a dev checkout with a built `webui/dist` would otherwise
		// register the catch-all static route (`*`); the table under test is
		// the API surface (the webui mount has its own coverage).
		SIGRUN_WEBUI: "false",
	});
	const opened = await openHarness(config, {
		identity: await seededIdentity(dir),
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
				"/metrics",
				"/v1/admin/restart",
				"/v1/meta",
				"/v1/commands",
				"/v1/auth/accounts",
				"/v1/auth/callback/:provider",
				"/v1/auth/check",
				"/v1/auth/login",
				"/v1/auth/login/:provider",
				"/v1/auth/login/code",
				"/v1/auth/logout",
				"/v1/auth/providers",
				"/v1/auth/tokens",
				"/v1/auth/tokens/:id",
				"/v1/auth/whoami",
				"/v1/models",
				"/v1/onboarding",
				"/v1/onboarding/claim",
				"/v1/providers",
				"/v1/providers/:id/credential",
				"/v1/providers/:id/refresh",
				"/v1/events",
				"/v1/extensions",
				"/v1/extensions/:slug/secrets",
				"/v1/extensions/:slug/secrets/:key",
				"/v1/extensions/:slug/settings",
				"/v1/ext/:slug/surfaces/:id",
				"/v1/ext/:slug/surfaces/:id/data",
				"/v1/ext/:slug/surfaces/:id/actions",
				"/v1/ext/:slug/surfaces/:id/uploads/:field/:name",
				// Fastify prints the assets wildcard route as a bare "*" line
				// (printRoutes collapses `/v1/ext/:slug/assets/*` onto the
				// root wildcard row the test's parser reconstructs).
				"*",
				"/v1/settings",
				"/v1/settings/sections",
				"/v1/interactions",
				"/v1/jobs",
				"/v1/jobs/:id",
				"/v1/jobs/:id/revisions",
				"/v1/jobs/:id/run",
				"/v1/jobs/:id/runs",
				"/v1/users",
				"/v1/users/:user",
				"/v1/users/invites",
				"/v1/conversations",
				"/v1/conversations/import",
				"/v1/conversations/:id",
				"/v1/conversations/:id/stream",
				"/v1/conversations/:id/submissions",
				"/v1/conversations/:id/submissions/:submissionId",
				"/v1/conversations/:id/configure",
				"/v1/conversations/:id/abort",
				"/v1/conversations/:id/interactions",
				"/v1/conversations/:id/interactions/:callId/answer",
				"/v1/conversations/:id/ambient",
				"/v1/conversations/:id/commands/:name",
				"/v1/conversations/:id/compact",
				"/v1/conversations/:id/fork",
				"/v1/conversations/:id/export",
				"/v1/conversations/:id/meta",
				"/v1/conversations/:id/uploads",
				"/v1/conversations/:id/uploads/:name",
				"/v1/conversations/:id/files",
				"/v1/conversations/:id/files/content",
				"/v1/conversations/:id/files/raw",
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

describe("token list wire", () => {
	test("GET /v1/auth/tokens shows kind and expiresAt", async () => {
		const { app, opened } = await bootServer({ auth: "token" });
		const api = await opened.identity.tokens.create("laptop", "tester");
		const now = Date.now();
		const session = await opened.identity.tokens.createSession(
			"tester",
			"login:oauth:acme",
			60_000,
			now,
		);
		const response = await app.inject({
			method: "GET",
			url: "/v1/auth/tokens",
			headers: { authorization: `Bearer ${api.token}` },
		});
		expect(response.statusCode).toBe(200);
		expect(response.json().tokens).toEqual([
			{
				id: api.record.id,
				name: "laptop",
				user: "tester",
				createdAt: api.record.createdAt,
			},
			{
				id: session.record.id,
				name: "login:login:oauth:acme",
				user: "tester",
				createdAt: now,
				kind: "session",
				expiresAt: now + 60_000,
			},
		]);
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
							headers: {
								"content-type": testCase.contentType ?? "application/json",
							},
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

// ---------------------------------------------------------------------------
// encoded /v1 sweep — the pipeline's public branch from the matched route
// ---------------------------------------------------------------------------

/**
 * The public GET patterns under `/v1` (the pipeline's rules 1-4): every
 * OTHER registered GET route, requested with its first character after
 * `/` percent-encoded (`/v1/x` → `/%761/x`, `:params` filled with `1`),
 * must answer 401 without a credential on a token server — the raw-URL
 * prefix check once mistook every one of these for the browser surface.
 */
describe("encoded /v1 route sweep", () => {
	/** The pipeline's public GET list (mirrors `isPublicPath`'s rules). */
	const PUBLIC_PATTERNS = new Set([
		"/v1/onboarding",
		// The auth-login/logout public rules are POST-only; the GET
		// spellings of those patterns are NOT public (a GET never matched
		// the POST route anyway — it 404s, never API data).
	]);

	test("every non-public /v1 GET route, first segment letter encoded, no credential → 401", async () => {
		const { app } = await bootServer({ auth: "token" });
		const encoded: string[] = [];
		for (const [method, pattern] of ROUTES) {
			if (method !== "GET") continue;
			if (!pattern.startsWith("/v1/")) continue;
			if (PUBLIC_PATTERNS.has(pattern)) continue;
			// `/v1/settings` → `/%761/settings`; params filled with `1`.
			const concrete = pattern
				.replace(":id", "1")
				.replace(":user", "1")
				.replace(":submissionId", "1")
				.replace(":callId", "1")
				.replace(":name", "1")
				.replace(":slug", "1")
				.replace(":key", "1");
			const slashed = concrete.split("/");
			// `["", "v1", "settings", ...]` → encode the "v1" segment.
			slashed[1] = "%761";
			const url = slashed.join("/");
			encoded.push(url);
			const response = await app.inject({ method: "GET", url });
			// The route matched (Fastify decoded it): no credential may
			// reach a handler — 401 from the pipeline, never the route's
			// own 200/404 answer.
			expect(
				response.statusCode,
				`status for ${url} (pattern ${pattern})`,
			).toBe(401);
			expect(
				response.json(),
				`body for ${url} (pattern ${pattern})`,
			).toEqual({ error: "unauthenticated" });
		}
		// The sweep actually swept (a regression in ROUTES would empty it).
		expect(encoded.length).toBeGreaterThanOrEqual(20);
	});
});
