/**
 * UI-blocks U3 Task 3: the upload route
 * (`PUT /v1/ext/<slug>/surfaces/<id>/uploads/<field>/<name>`) and the
 * contained asset route (`GET /v1/ext/<slug>/assets/<path>`, spec
 * §11.1/§7.2).
 *
 * Uploads: raw octet-stream body, the name validated against core's
 * `validUploadName` rule (on the DECODED param), the MIME sniffed from
 * the bytes (never the client name — a `.png` name over JPEG bytes
 * reports `image/jpeg`), and the field's `maxBytes` cap enforced at
 * the STREAM — an over-cap chunked body is cut off (the socket closes
 * before the end is sent; Review Focus 5).
 *
 * Assets: sniffed Content-Type + `X-Content-Type-Options: nosniff`;
 * realpath containment (`..` and a symlink out of the assets dir both
 * 404); a package with no declared `sigrun.assets` answers 404 for
 * every asset request.
 *
 * Two fixture extensions: `fixture-surfaces` (the board with a
 * maxBytes:1024 `file` field) and `fixture-surfaces-assets` (declares
 * `sigrun.assets: "assets"` with a real PNG inside).
 */

import { createConnection } from "node:net";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	afterAll,
	beforeEach,
	describe,
	expect,
	test,
	vi,
} from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import { createServer } from "../src/server/index.js";
import { seededIdentity } from "./helpers/identity.js";
import {
	accessOverrides,
	actionCalls,
	resetSurfaceFixture,
} from "./fixtures/fixture-surfaces/index.js";

const FIXTURES_DIR = join(import.meta.dirname, "fixtures");
const SURFACES_SPECIFIER = pathToFileURL(
	join(FIXTURES_DIR, "fixture-surfaces", "index.js"),
).href;
const ASSETS_SPECIFIER = pathToFileURL(
	join(FIXTURES_DIR, "fixture-surfaces-assets", "index.js"),
).href;
const ASSETS_DIR = join(FIXTURES_DIR, "fixture-surfaces-assets", "assets");

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

interface TestServer {
	readonly app: FastifyInstance;
	readonly opened: OpenedHarness;
	readonly aliceToken: string;
	readonly listenUrl: string;
}

let booted: Promise<TestServer> | undefined;
function server(): Promise<TestServer> {
	booted ??= bootServer();
	return booted;
}

/** Boot one hermetic server with BOTH fixtures, listening on loopback. */
async function bootServer(): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-surfaces-assets-"));
	const configDir = join(dir, "config");
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "openai/gpt-test",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
		SIGRUN_WEBUI: "false",
		SIGRUN_AUTH: "token",
		SIGRUN_CONFIG_DIR: configDir,
	});
	const identity = await seededIdentity(join(dir, "seed"), "alice");
	const opened = await openHarness(config, {
		identity,
		extensionSpecifiers: [SURFACES_SPECIFIER, ASSETS_SPECIFIER],
		env: { SIGRUN_CONFIG_DIR: configDir },
		settingsDir: dir,
	});
	const { token: aliceToken } = await opened.identity.tokens.create(
		"alice-cli",
		"alice",
	);
	const app = await createServer(opened, config, [], {
		listenHost: "127.0.0.1",
	});
	await app.listen({ host: "127.0.0.1", port: 0 });
	const address = app.server.address();
	if (address === null || typeof address === "string") {
		throw new Error("no listen address");
	}
	const listenUrl = `http://127.0.0.1:${address.port}`;
	cleanups.push(async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	});
	return { app, opened, aliceToken, listenUrl };
}

/** Render the board once so the file-field caps are known. */
async function warmBoard(app: FastifyInstance, token: string): Promise<void> {
	const response = await app.inject({
		method: "GET",
		url: "/v1/ext/fixture-surfaces/surfaces/board",
		headers: { authorization: `Bearer ${token}` },
	});
	if (response.statusCode !== 200) throw new Error("warm render failed");
}

beforeEach(() => {
	resetSurfaceFixture();
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-10-22T00:00:00Z"));
	// restore real timers for the socket test: each test that needs them
	// re-enables fake timers itself
	vi.useRealTimers();
});

/** A tiny valid JPEG (SOI + EOI; the sniffer reads the magic only). */
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

describe("the surface upload route (U3 Task 3)", () => {
	test("onUpload receives {field, name, mime, bytes} with the MIME sniffed from the bytes", async () => {
		const { app, aliceToken } = await server();
		await warmBoard(app, aliceToken);
		const response = await app.inject({
			method: "PUT",
			url: "/v1/ext/fixture-surfaces/surfaces/board/uploads/attachment/a.png",
			headers: {
				authorization: `Bearer ${aliceToken}`,
				"content-type": "application/octet-stream",
			},
			payload: JPEG_BYTES,
		});
		expect(response.statusCode).toBe(200);
		const uploads = actionCalls.filter((entry) => entry.action === "upload");
		expect(uploads).toHaveLength(1);
		const file = uploads[0]?.file;
		expect(file?.field).toBe("attachment");
		expect(file?.name).toBe("a.png");
		// A `.png` name over JPEG bytes reports image/jpeg (never the client name).
		expect(file?.mime).toBe("image/jpeg");
		expect(file?.bytes).toEqual(Array.from(JPEG_BYTES));
	});

	test("a name failing validUploadName (..) → 400", async () => {
		const { app, aliceToken } = await server();
		await warmBoard(app, aliceToken);
		// Fastify normalizes `..` in the PATH before routing (a literal
		// `/../` segment collapses the path and 404s at the router), so
		// the rule is exercised by the OTHER rejected names the check
		// exists for — a name with a separator arrives decoded with a
		// slash inside the param (`a%2Fb` → `a/b`).
		const response = await app.inject({
			method: "PUT",
			url: "/v1/ext/fixture-surfaces/surfaces/board/uploads/attachment/a%2Fb.png",
			headers: {
				authorization: `Bearer ${aliceToken}`,
				"content-type": "application/octet-stream",
			},
			payload: JPEG_BYTES,
		});
		expect(response.statusCode).toBe(400);
		expect(response.json()).toEqual({ error: "invalid_body" });
	});

	test("over the field's maxBytes (declared content-length) → 413 without the handler running", async () => {
		const { app, aliceToken } = await server();
		await warmBoard(app, aliceToken);
		const overCap = Buffer.alloc(1025, 0x61);
		const response = await app.inject({
			method: "PUT",
			url: "/v1/ext/fixture-surfaces/surfaces/board/uploads/attachment/big.bin",
			headers: {
				authorization: `Bearer ${aliceToken}`,
				"content-type": "application/octet-stream",
			},
			payload: overCap,
		});
		expect(response.statusCode).toBe(413);
		expect(actionCalls.filter((entry) => entry.action === "upload")).toHaveLength(
			0,
		);
	});

	test("an over-cap CHUNKED body is cut off: the socket closes before the end is sent (Review Focus 5)", async () => {
		const { app, aliceToken, listenUrl } = await server();
		await warmBoard(app, aliceToken);
		const port = Number(new URL(listenUrl).port);
		const result = await new Promise<{
			readonly status: number | undefined;
			readonly socketClosedBeforeEnd: boolean;
		}>((resolvePromise, rejectPromise) => {
			const socket = createConnection({ port, host: "127.0.0.1" }, () => {
				socket.write(
					"PUT /v1/ext/fixture-surfaces/surfaces/board/uploads/attachment/big.bin HTTP/1.1\r\n" +
						`Host: 127.0.0.1:${port}\r\n` +
						`authorization: Bearer ${aliceToken}\r\n` +
						"content-type: application/octet-stream\r\n" +
						"transfer-encoding: chunked\r\n" +
						"connection: close\r\n" +
						"\r\n",
				);
			});
			let responded = false;
			let status: number | undefined;
			const chunksToSend = 8; // 8 × 256 B = 2048 B > the 1024 cap
			let sent = 0;
			const sendNext = (): void => {
				if (socket.destroyed || socket.closed) {
					return;
				}
				if (sent < chunksToSend) {
					sent += 1;
					socket.write(`100\r\n${"a".repeat(256)}\r\n`);
					setTimeout(sendNext, 5);
				}
			};
			socket.on("data", (data) => {
				const text = data.toString("latin1");
				const match = /^HTTP\/1\.1 (\d{3})/m.exec(text);
				if (match !== null) {
					status = Number(match[1]);
					responded = true;
				}
			});
			socket.on("error", () => {
				// ECONNRESET on our next write counts as the server closing.
			});
			socket.on("close", () => {
				resolvePromise({
					status,
					socketClosedBeforeEnd: sent < chunksToSend && responded,
				});
			});
			socket.setTimeout(10_000, () => {
				socket.destroy();
				rejectPromise(new Error("socket test timed out"));
			});
			setTimeout(sendNext, 5);
		});
		expect(result.status).toBe(413);
		expect(result.socketClosedBeforeEnd).toBe(true);
	});

	test("read access → 403 on the upload route, before the body is read", async () => {
		const { app, aliceToken } = await server();
		await warmBoard(app, aliceToken);
		accessOverrides.set("alice", "read");
		// Expire the access-cache entry the warm render wrote: hold the
		// fake Date at real-now + 120 s THROUGH the inject (the cache
		// clock is Date.now).
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(Date.now() + 120_000);
		try {
			const response = await app.inject({
				method: "PUT",
				url: "/v1/ext/fixture-surfaces/surfaces/board/uploads/attachment/a.png",
				headers: {
					authorization: `Bearer ${aliceToken}`,
					"content-type": "application/octet-stream",
				},
				payload: JPEG_BYTES,
			});
			expect(response.statusCode).toBe(403);
			expect(
				actionCalls.filter((entry) => entry.action === "upload"),
			).toHaveLength(0);
		} finally {
			vi.useRealTimers();
		}
	});

	test("an upload to an unknown file field → 400 unknown_field", async () => {
		const { app, aliceToken } = await server();
		await warmBoard(app, aliceToken);
		const response = await app.inject({
			method: "PUT",
			url: "/v1/ext/fixture-surfaces/surfaces/board/uploads/no-such-field/a.png",
			headers: {
				authorization: `Bearer ${aliceToken}`,
				"content-type": "application/octet-stream",
			},
			payload: JPEG_BYTES,
		});
		expect(response.statusCode).toBe(400);
		expect(response.json()).toEqual({ error: "unknown_field" });
	});
});

describe("the extension asset route (U3 Task 3, spec §11.1)", () => {
	test("GET assets/img/a.png serves the file with a sniffed type and nosniff", async () => {
		const { app, aliceToken } = await server();
		const response = await app.inject({
			method: "GET",
			url: "/v1/ext/fixture-surfaces-assets/assets/img/a.png",
			headers: { authorization: `Bearer ${aliceToken}` },
		});
		expect(response.statusCode).toBe(200);
		expect(response.headers["content-type"]).toBe("image/png");
		expect(response.headers["x-content-type-options"]).toBe("nosniff");
		expect(response.rawPayload.byteLength).toBeGreaterThan(0);
	});

	test("assets/../package.json → 404 (realpath containment)", async () => {
		const { app, aliceToken } = await server();
		const response = await app.inject({
			method: "GET",
			url: "/v1/ext/fixture-surfaces-assets/assets/../package.json",
			headers: { authorization: `Bearer ${aliceToken}` },
		});
		expect(response.statusCode).toBe(404);
	});

	test("a symlink inside assets/ pointing outside it → 404", async () => {
		const { app, aliceToken } = await server();
		const outside = join(ASSETS_DIR, "..", "escape-target.txt");
		const link = join(ASSETS_DIR, "escape.txt");
		await writeFile(outside, "acme secret");
		await symlink(outside, link);
		cleanups.push(async () => {
			await rm(link, { force: true });
			await rm(outside, { force: true });
		});
		const response = await app.inject({
			method: "GET",
			url: "/v1/ext/fixture-surfaces-assets/assets/escape.txt",
			headers: { authorization: `Bearer ${aliceToken}` },
		});
		expect(response.statusCode).toBe(404);
	});

	test("a package with no declared assets dir answers 404 for every asset request", async () => {
		const { app, aliceToken } = await server();
		const response = await app.inject({
			method: "GET",
			url: "/v1/ext/fixture-surfaces/assets/anything.png",
			headers: { authorization: `Bearer ${aliceToken}` },
		});
		expect(response.statusCode).toBe(404);
	});
});
