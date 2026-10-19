/**
 * §6.2 uploads and import (W2 Task 2): the raw upload route, the
 * `server.maxUploadBytes` knob, and the shared 413 `too_large` shape.
 *
 * Phone photos fail today through Fastify's 1 MiB default body limit: the
 * base64 POST inflates a multi-megabyte file past it before the route ever
 * runs. The fix is the `PUT /v1/conversations/:id/uploads/:name` route —
 * raw `application/octet-stream`, route `bodyLimit` = the knob — plus
 * explicit limits on the base64 POST (ceil(knob × 4/3) + 4 KiB: the base64
 * inflation of the capped content plus the JSON wrapper) and the JSONL
 * import (same formula). Over any of them: `413 {error:"too_large",
 * maxBytes}` from one app-level error handler on Fastify's
 * `FST_ERR_CTP_BODY_TOO_LARGE`.
 *
 * Name rule (Review Focus): `:name` is validated AFTER Fastify decodes the
 * percent-encoded param — `..%2Fx` arrives as `../x` (contains `/`) and
 * `%2e%2e` arrives as `..`, both 400 `invalid_body`. A PUT with NO
 * content-type is accepted (an `onRequest` on the route defaults the absent
 * header to `application/octet-stream`).
 *
 * Hermetic pattern: faux provider + tmp workspace + `app.inject()` (see
 * `server-submissions.test.ts`).
 */

import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { loadConfig, type Env } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { createServer } from "../src/server/index.js";
import type { FastifyInstance } from "fastify";

/** One hermetic server: harness + faux provider + Fastify app + workspace. */
interface TestServer {
	app: FastifyInstance;
	opened: OpenedHarness;
	/** The tmp workspace root (`SIGRUN_WORKSPACE_PATH`). */
	workspace: string;
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

/** Boot a hermetic server; `env` appends config overrides (the knob tests). */
async function bootServer(env: Env = {}): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-uploads-"));
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
		// register the catch-all static route.
		SIGRUN_WEBUI: "false",
		...env,
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
	return { app, opened, workspace: dir };
}

describe("PUT /v1/conversations/:id/uploads/:name", () => {
	test("an 8 MiB octet-stream PUT → 201, and the workspace bytes equal the input", async () => {
		const { app, opened, workspace } = await bootServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const bytes = randomBytes(8 * 1024 * 1024);
		const response = await app.inject({
			method: "PUT",
			url: `/v1/conversations/${root.id}/uploads/photo.bin`,
			headers: { "content-type": "application/octet-stream" },
			payload: bytes,
		});
		expect(response.statusCode).toBe(201);
		expect(response.json()).toEqual({
			path: `uploads/${root.id}/photo.bin`,
		});
		// The bytes on disk are exactly what was sent (read through the
		// workspace path — the files/content route has its own 1 MiB read
		// cap, so it cannot carry an 8 MiB round-trip).
		const stored = await readFile(
			join(workspace, "uploads", String(root.id), "photo.bin"),
		);
		expect(stored.equals(bytes)).toBe(true);
	});

	test("a PUT with NO content-type → 201 (the route defaults it to octet-stream)", async () => {
		const { app, opened } = await bootServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const response = await app.inject({
			method: "PUT",
			url: `/v1/conversations/${root.id}/uploads/plain.dat`,
			// No headers: light-my-request leaves content-type absent for a
			// Buffer payload, so Fastify sees a body with no content type.
			payload: Buffer.from("no content type"),
		});
		expect(response.statusCode).toBe(201);
		expect(response.json()).toEqual({
			path: `uploads/${root.id}/plain.dat`,
		});
	});

	test("over SIGRUN_MAX_UPLOAD_BYTES → 413 {error: \"too_large\", maxBytes}", async () => {
		const { app, opened } = await bootServer({
			SIGRUN_MAX_UPLOAD_BYTES: "1024",
		});
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const response = await app.inject({
			method: "PUT",
			url: `/v1/conversations/${root.id}/uploads/big.bin`,
			headers: { "content-type": "application/octet-stream" },
			payload: randomBytes(2 * 1024),
		});
		expect(response.statusCode).toBe(413);
		expect(response.json()).toEqual({ error: "too_large", maxBytes: 1024 });
	});

	test("percent-encoded traversal names are checked after decoding → 400 invalid_body", async () => {
		const { app, opened } = await bootServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		// `..%2Fx` decodes to `../x`, `%2e%2e%2f` to `../` (both contain
		// `/`), `..%5Cevil` to `..\\evil` (backslash). A BARE `%2e%2e`
		// segment cannot be delivered through app.inject — the WHATWG URL
		// parser resolves a whole `%2e%2e`/`..` segment client-side before
		// the router ever sees it — so the decoded-name-equals-`..` branch is
		// pinned through the base64 POST body instead (the routes share the
		// rule).
		for (const name of ["..%2Fx", "%2e%2e%2f", "a%2Fb", "..%5Cevil"]) {
			const response = await app.inject({
				method: "PUT",
				url: `/v1/conversations/${root.id}/uploads/${name}`,
				headers: { "content-type": "application/octet-stream" },
				payload: Buffer.from("x"),
			});
			expect(response.statusCode, name).toBe(400);
			expect(response.json(), name).toEqual({ error: "invalid_body" });
		}
		// The exact `.`/`..` names, through the body the URL parser cannot
		// touch (validUploadName is shared by both routes).
		for (const name of [".", ".."]) {
			const response = await app.inject({
				method: "POST",
				url: `/v1/conversations/${root.id}/uploads`,
				payload: { name, contentBase64: "aGk=" },
				headers: { "content-type": "application/json" },
			});
			expect(response.statusCode, name).toBe(400);
			expect(response.json(), name).toEqual({ error: "invalid_body" });
		}
	});

	test("404s for an unknown conversation id", async () => {
		const { app } = await bootServer();
		const response = await app.inject({
			method: "PUT",
			url: "/v1/conversations/999999/uploads/x.txt",
			headers: { "content-type": "application/octet-stream" },
			payload: Buffer.from("x"),
		});
		expect(response.statusCode).toBe(404);
		expect(response.json()).toEqual({ error: "conversation_not_found" });
	});
});

describe("POST /v1/conversations/:id/uploads (base64, one more release)", () => {
	test("a 900 KB file under the default knob → 201 (was 413 through Fastify's 1 MiB default)", async () => {
		const { app, opened } = await bootServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		// 900 KB of base64 is ~1.2 MB of JSON body — past Fastify's 1 MiB
		// default, under the knob-derived limit.
		const bytes = randomBytes(900 * 1024);
		const response = await app.inject({
			method: "POST",
			url: `/v1/conversations/${root.id}/uploads`,
			payload: {
				name: "photo.jpg",
				contentBase64: bytes.toString("base64"),
			},
			headers: { "content-type": "application/json" },
		});
		expect(response.statusCode).toBe(201);
		expect(response.json()).toEqual({
			path: `uploads/${root.id}/photo.jpg`,
		});
	});

	test("over the knob-derived base64 limit → 413 {error: \"too_large\", maxBytes}", async () => {
		// knob 1024 → ceil(1024 × 4/3) + 4096 = 5462 body bytes; a 4 KiB
		// file base64s to ~5.5 KB of JSON — over.
		const { app, opened } = await bootServer({
			SIGRUN_MAX_UPLOAD_BYTES: "1024",
		});
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const response = await app.inject({
			method: "POST",
			url: `/v1/conversations/${root.id}/uploads`,
			payload: {
				name: "big.txt",
				contentBase64: randomBytes(4 * 1024).toString("base64"),
			},
			headers: { "content-type": "application/json" },
		});
		expect(response.statusCode).toBe(413);
		// maxBytes is the route's enforced body limit (the formula value).
		expect(response.json().error).toBe("too_large");
		expect(response.json().maxBytes).toBe(
			Math.ceil((1024 * 4) / 3) + 4096,
		);
	});
});

describe("POST /v1/conversations/import body limit", () => {
	test("a 2 MiB JSONL import → 201, not 413", async () => {
		const { app } = await bootServer();
		// Application-kind entries (a kind that is not `pi.*`) carry
		// arbitrary JSON data — the import-replay shape.
		const lines: string[] = [];
		for (let i = 0; ; i++) {
			lines.push(
				JSON.stringify({
					kind: "import.pad",
					data: { i, pad: "x".repeat(64 * 1024) },
				}),
			);
			if (lines.join("\n").length >= 2 * 1024 * 1024) break;
		}
		const response = await app.inject({
			method: "POST",
			url: "/v1/conversations/import",
			payload: `${lines.join("\n")}\n`,
			headers: { "content-type": "application/x-ndjson" },
		});
		expect(response.statusCode).toBe(201);
		const body = response.json();
		expect(typeof body.id).toBe("number");
		expect(body.view.entries).toHaveLength(lines.length);
	});
});

describe("the server.maxUploadBytes knob", () => {
	/** The minimal env every knob parse runs against. */
	const BASE: Env = {
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: "/tmp/x/sigrun.db",
	};

	test("SIGRUN_MAX_UPLOAD_BYTES is strict: non-positive/non-integer values fail loud naming the variable", () => {
		for (const bad of ["0", "-1", "1.5", "abc", " "]) {
			expect(() =>
				loadConfig({ ...BASE, SIGRUN_MAX_UPLOAD_BYTES: bad }),
			).toThrow(/SIGRUN_MAX_UPLOAD_BYTES/);
		}
	});

	test("the default is 64 MiB; env wins; the file's server.maxUploadBytes applies when env is absent", () => {
		expect(loadConfig(BASE).maxUploadBytes).toBe(64 * 1024 * 1024);
		expect(
			loadConfig({ ...BASE, SIGRUN_MAX_UPLOAD_BYTES: "2048" })
				.maxUploadBytes,
		).toBe(2048);
		expect(
			loadConfig(BASE, { server: { maxUploadBytes: 4096 } })
				.maxUploadBytes,
		).toBe(4096);
		// Env wins over the file (the bad env value fails even with a valid
		// file value — the parseTokenCount posture).
		expect(
			loadConfig(
				{ ...BASE, SIGRUN_MAX_UPLOAD_BYTES: "2048" },
				{ server: { maxUploadBytes: 4096 } },
			).maxUploadBytes,
		).toBe(2048);
	});
});
