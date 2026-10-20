/**
 * Core hardening W3 Task 7 (spec §7.8): `GET /v1/conversations/:id/files/raw`
 * — the bounded raw read the workspace file surface serves when a file is
 * bigger (or binary-er) than files/content's 1 MiB text/base64 cap.
 *
 * - a 3 MiB file streams back byte-equal, `content-length` = size, read in
 *   CHUNKS through `ExecutionEnv.openBinaryReader` (never `readBinaryFile`);
 * - the extension→mime map picks `content-type` (`.png` → `image/png`;
 *   an unknown extension → `application/octet-stream`);
 * - `server.maxFileReadBytes` (`SIGRUN_MAX_FILE_READ_BYTES`, strict parse,
 *   default 16 MiB): over the cap → 413 `file_too_large` + `maxBytes`;
 * - a directory path → 400 `invalid_path`; `../x` → 400 `invalid_path`
 *   (the symlink policy is unchanged from files/content — the default
 *   follows-symlinks reader).
 *
 * Hermetic pattern (server-uploads.test.ts): faux provider + tmp workspace
 * + `app.inject()`; files are seeded straight into the workspace root.
 */

import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { loadConfig, type Env } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { seededIdentity } from "./helpers/identity.js";
import { createServer } from "../src/server/index.js";
import type { FastifyInstance } from "fastify";

/** One hermetic server: harness + faux provider + Fastify app + workspace. */
interface TestServer {
	readonly app: FastifyInstance;
	readonly opened: OpenedHarness;
	/** The tmp workspace root (`SIGRUN_WORKSPACE_PATH`). */
	readonly workspace: string;
	/** The root conversation's id. */
	readonly rootId: number;
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

/** Boot a hermetic server; `env` appends config overrides (the knob test). */
async function bootServer(env: Env = {}): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-files-raw-"));
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
		SIGRUN_WEBUI: "false",
		SIGRUN_AUTH: "none",
		...env,
	});
	const opened = await openHarness(config, {
		extensions: [contributor],
		env: {},
		settingsDir: dir,
		identity: await seededIdentity(dir),
	});
	const app = await createServer(opened, config);
	const root = await opened.harness.root(BACKGROUND_CONTEXT, {
		agent: { model: opened.defaultModel },
	});
	cleanups.push(async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	});
	return { app, opened, workspace: dir, rootId: root.id };
}

describe("GET /v1/conversations/:id/files/raw", () => {
	test("a 3 MiB file streams back byte-equal with content-length (chunked, default cap)", async () => {
		const { app, workspace, rootId } = await bootServer();
		const bytes = randomBytes(3 * 1024 * 1024);
		await writeFile(join(workspace, "blob.bin"), bytes);
		const response = await app.inject({
			method: "GET",
			url: `/v1/conversations/${rootId}/files/raw?path=blob.bin`,
		});
		expect(response.statusCode).toBe(200);
		expect(response.headers["content-length"]).toBe(String(bytes.length));
		// Unknown extension → the octet-stream default.
		expect(response.headers["content-type"]).toBe("application/octet-stream");
		expect(Buffer.from(response.rawPayload).equals(bytes)).toBe(true);
	});

	test("the extension picks the mime type (.png → image/png)", async () => {
		const { app, workspace, rootId } = await bootServer();
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
		await writeFile(join(workspace, "photo.png"), png);
		const response = await app.inject({
			method: "GET",
			url: `/v1/conversations/${rootId}/files/raw?path=photo.png`,
		});
		expect(response.statusCode).toBe(200);
		expect(response.headers["content-type"]).toBe("image/png");
		expect(Buffer.from(response.rawPayload).equals(png)).toBe(true);
	});

	test("over SIGRUN_MAX_FILE_READ_BYTES → 413 file_too_large + maxBytes", async () => {
		const { app, workspace, rootId } = await bootServer({
			SIGRUN_MAX_FILE_READ_BYTES: "1024",
		});
		await writeFile(join(workspace, "big.bin"), randomBytes(2 * 1024));
		const response = await app.inject({
			method: "GET",
			url: `/v1/conversations/${rootId}/files/raw?path=big.bin`,
		});
		expect(response.statusCode).toBe(413);
		expect(response.json()).toEqual({
			error: "file_too_large",
			maxBytes: 1024,
		});
	});

	test("a directory path → 400 invalid_path; ../x → 400 invalid_path", async () => {
		const { app, workspace, rootId } = await bootServer();
		await mkdir(join(workspace, "subdir"));
		const directory = await app.inject({
			method: "GET",
			url: `/v1/conversations/${rootId}/files/raw?path=subdir`,
		});
		expect(directory.statusCode).toBe(400);
		expect(directory.json()).toEqual({ error: "invalid_path" });
		const escape = await app.inject({
			method: "GET",
			url: `/v1/conversations/${rootId}/files/raw?path=..%2Fx`,
		});
		expect(escape.statusCode).toBe(400);
		expect(escape.json()).toEqual({ error: "invalid_path" });
	});

	test("an absent file → 404; the default cap is 16 MiB", async () => {
		const { app, rootId } = await bootServer();
		const absent = await app.inject({
			method: "GET",
			url: `/v1/conversations/${rootId}/files/raw?path=nope.bin`,
		});
		expect(absent.statusCode).toBe(404);
		expect(absent.json()).toEqual({ error: "not_found" });
	});
});
