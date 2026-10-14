/**
 * Task 13: the deploy entry smoke test — `src/index.ts` is the composition
 * the Deployment's container command runs: `loadConfig(process.env)` →
 * `openHarness` → `createServer` → `app.listen`.
 *
 * This spawns the REAL entry as a subprocess (tsx, exactly the `"start"`
 * script's invocation) in a hermetic env:
 * - `SIGRUN_MODEL=openai/gpt-4o` + a never-called `OPENAI_BASE_URL` — boot
 *   only CONSTRUCTS the degenerate provider; no generation is submitted, so
 *   no real provider is ever contacted.
 * - `SIGRUN_STORAGE_PATH`/`SIGRUN_WORKSPACE_PATH` in a tmpdir; a reserved
 *   free port for `SIGRUN_PORT` (loadConfig refuses 0, so the test reserves
 *   an OS-ephemeral port itself and passes the number).
 *
 * Assertions: the entry prints its listening line (with the actual port),
 * `GET /v1/meta` answers 200 over the real socket, and SIGTERM exits 0
 * (the kubelet stop path). The boot-failure leg asserts fail-loud: a missing
 * SIGRUN_MODEL crashes the process with exit 1, never serves broken.
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { expect, test } from "vitest";

/** Repo root (test/ → ..): cwd for the entry; where tsx + src live. */
const REPO_ROOT = join(import.meta.dirname, "..");

/** The tsx launcher the `start` script uses, resolved from node_modules. */
const TSX = join(REPO_ROOT, "node_modules", ".bin", "tsx");

/** Reserve an OS-ephemeral port (listen 0, read the port, close). */
function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address === null || typeof address === "string") {
				server.close();
				reject(new Error("no ephemeral port"));
				return;
			}
			const { port } = address;
			server.close(() => resolve(port));
		});
	});
}

/** Minimal hermetic env for the entry — nothing inherited but PATH/HOME. */
function childEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
	return {
		PATH: process.env.PATH ?? "",
		HOME: process.env.HOME,
		...overrides,
	};
}

/** Spawn the entry and resolve once it prints its listening line. */
function spawnEntry(env: NodeJS.ProcessEnv) {
	const child = spawn(TSX, ["src/index.ts"], {
		cwd: REPO_ROOT,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk: Buffer) => {
		stdout += chunk.toString("utf-8");
	});
	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf-8");
	});
	const exited = new Promise<{ code: number | null }>((resolve) => {
		child.on("exit", (code) => resolve({ code }));
	});
	// Resolves with the printed port; rejects with the collected output.
	const listening = new Promise<number>((resolve, reject) => {
		const startedAt = Date.now();
		const poll = (): void => {
			const match = /listening on http:\/\/0\.0\.0\.0:(\d+)/.exec(stdout);
			if (match) {
				resolve(Number(match[1]));
				return;
			}
			if (Date.now() - startedAt > 30_000) {
				reject(
					new Error(
						`entry never reported listening; stdout=${stdout}; stderr=${stderr}`,
					),
				);
				return;
			}
			void exited.then(() =>
				reject(
					new Error(
						`entry exited before listening; code=${child.exitCode}; stderr=${stderr}`,
					),
				),
			);
			setTimeout(poll, 100);
		};
		poll();
	});
	return { child, exited, listening, getStderr: () => stderr };
}

test(
	"deploy entry boots on a free port, serves /v1/meta, exits 0 on SIGTERM",
	async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-entry-"));
		const port = await freePort();
		const entry = spawnEntry(
			childEnv({
				SIGRUN_MODEL: "openai/gpt-4o",
				OPENAI_API_KEY: "smoke-test-key-never-sent",
				OPENAI_BASE_URL: "http://127.0.0.1:9",
				SIGRUN_PORT: String(port),
				SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
				SIGRUN_WORKSPACE_PATH: dir,
				SIGRUN_CONFIG_DIR: join(dir, "config"),
			}),
		);
		try {
			const listenedOn = await entry.listening;
			expect(listenedOn).toBe(port);
			const response = await fetch(`http://127.0.0.1:${port}/v1/meta`);
			expect(response.status).toBe(200);
			const meta = (await response.json()) as {
				harnessVersion: string;
			};
			expect(typeof meta.harnessVersion).toBe("string");
			// The probe endpoints exist on the real listener too.
			const healthz = await fetch(`http://127.0.0.1:${port}/healthz`);
			expect(healthz.status).toBe(200);
			// Settings bootstrap: first boot wrote the resolved server section
			// (env + code defaults — port/workspace/storage present even at
			// defaults) under SIGRUN_CONFIG_DIR.
			const bootstrapped = JSON.parse(
				await readFile(
						join(dir, "config", "settings.json"),
						"utf8",
				),
			) as { server: Record<string, unknown> };
			expect(bootstrapped.server).toMatchObject({
				port,
				storagePath: join(dir, "sigrun.db"),
				workspacePath: dir,
			});
			// Defaults are recorded too (extensionsDir/compaction even though no
			// env set them).
			expect(bootstrapped.server.extensionsDir).toBe("extensions");
			expect(bootstrapped.server.compaction).toMatchObject({
				enabled: true,
			});
		} finally {
			entry.child.kill("SIGTERM");
			const exit = await entry.exited;
			expect(exit.code).toBe(0);
			await rm(dir, { recursive: true, force: true });
		}
	},
	60_000,
);

test("deploy entry fails loud on boot error: missing SIGRUN_MODEL exits 1", async () => {
	const child = spawn(TSX, ["src/index.ts"], {
		cwd: REPO_ROOT,
		env: childEnv({ OPENAI_API_KEY: "x" }),
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stderr = "";
	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf-8");
	});
	const exit = await new Promise<{ code: number | null }>((resolve) => {
		child.on("exit", (code) => resolve({ code }));
	});
	expect(exit.code).toBe(1);
	expect(stderr).toMatch(/SIGRUN_MODEL/);
});
