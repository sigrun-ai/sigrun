/**
 * Task 13: the deploy entry smoke test — `src/index.ts` is the composition
 * the Deployment's container command runs: `loadConfig(process.env)` →
 * `openHarness` → `createServer` → `app.listen`.
 *
 * This spawns the REAL entry as a subprocess (tsx, exactly the `"start"`
 * script's invocation) in a hermetic env:
 * - `SIGRUN_DEFAULT_MODEL=openai/gpt-4o` + a never-called `OPENAI_BASE_URL`
 *   — boot only CONSTRUCTS the degenerate provider; no generation is
 *   submitted, so no real provider is ever contacted.
 * - `SIGRUN_STORAGE_PATH`/`SIGRUN_WORKSPACE_PATH` in a tmpdir; a reserved
 *   free port for `SIGRUN_PORT` (loadConfig refuses 0, so the test reserves
 *   an OS-ephemeral port itself and passes the number).
 *
 * Assertions: the entry prints its listening line (with the actual port),
 * `GET /v1/meta` answers 200 over the real socket, and SIGTERM exits 0
 * (the kubelet stop path). The boot-failure leg asserts fail-loud: a missing
 * default model (env AND file) crashes the process with exit 1, never
 * serves broken.
 */

import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
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

/**
 * Minimal hermetic env for the entry — nothing inherited but PATH/HOME.
 * `SIGRUN_API_TOKEN` is the W1 spawned-process pattern (the task-3
 * brief): the child serves an UNCLAIMED directory, so the env service
 * token is what gets a caller past the setup gate; requests send it as
 * Bearer.
 */
function childEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
	return {
		PATH: process.env.PATH ?? "",
		HOME: process.env.HOME,
		SIGRUN_API_TOKEN: "sgr_test_env",
		...overrides,
	};
}

/** The Bearer header every spawned-entry request sends (W1 Task 3). */
const SERVICE_BEARER = { authorization: "Bearer sgr_test_env" };

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
			const match = /listening on http:\/\/(?:\[[^\]]*\]|[^:\/]+):(\d+)/.exec(stdout);
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
				SIGRUN_DEFAULT_MODEL: "openai/gpt-4o",
				OPENAI_API_KEY: "smoke-test-key-never-sent",
				OPENAI_BASE_URL: "http://127.0.0.1:9",
				SIGRUN_PORT: String(port),
				SIGRUN_CONFIG_DIR: join(dir, "config"),
				// HOME (not SIGRUN_*_PATH vars) keeps the data root hermetic:
			// the store-root chain falls back to `$HOME/.local/share/sigrun`,
			// so the DB, the workspace default, and the ensured roots all land
			// under the tmp dir WITHOUT setting any server-path env var —
			// which is the point of this test's bootstrap assertions.
				HOME: dir,
			}),
		);
		try {
			const listenedOn = await entry.listening;
			expect(listenedOn).toBe(port);
			const response = await fetch(`http://127.0.0.1:${port}/v1/meta`, {
				headers: SERVICE_BEARER,
			});
			expect(response.status).toBe(200);
			const meta = (await response.json()) as {
				harnessVersion: string;
				version: string;
			};
			expect(typeof meta.harnessVersion).toBe("string");
			// The server's own version rides /v1/meta (the Settings version
			// line and bug reports read it).
			expect(meta.version).toBe("0.1.6");
			// The probe endpoints exist on the real listener too.
			const healthz = await fetch(`http://127.0.0.1:${port}/healthz`);
			expect(healthz.status).toBe(200);
			// Settings bootstrap (ruling 5 / spec §6.6): first boot writes
			// ONLY what the environment set — here `SIGRUN_PORT` (a server
		// key) and `SIGRUN_DEFAULT_MODEL` (the top-level defaultModel).
			// NO defaults are persisted: no extensionsDir, no compaction, no
			// maxUploadBytes, no dataDir, and no extensions list (nothing
			// env-supplied it — an empty `extensions: []` is not written
			// either). HOME/SIGRUN_CONFIG_DIR/OPENAI_* are not server keys.
			const bootstrapped = JSON.parse(
				await readFile(
						join(dir, "config", "settings.json"),
					"utf8",
					),
			) as Record<string, unknown>;
			expect(bootstrapped).toEqual({
				defaultModel: "openai/gpt-4o",
				server: { port },
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

test("deploy entry fails loud on boot error: no default model (env or file) exits 1", async () => {
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
	expect(stderr).toMatch(/SIGRUN_DEFAULT_MODEL/);
});

test("deploy entry boots from a settings-file-only defaultModel (no env model)", async () => {
	// The file-only path is a documented contract (README quickstart,
	// config tests): `defaultModel` in settings.json satisfies the model
	// requirement with NO env model set. Regression: serve()'s env-only
	// `loadConfig(env)` step used to throw before the file was ever read.
	const dir = await mkdtemp(join(tmpdir(), "sigrun-entry-file-model-"));
	const port = await freePort();
	const configDir = join(dir, "config");
	await mkdir(configDir, { recursive: true });
	await writeFile(
		join(configDir, "settings.json"),
		JSON.stringify({
			server: { port },
			defaultModel: "openai/gpt-4o",
		}),
	);
	const entry = spawnEntry(
		childEnv({
			// NOTE: deliberately NO SIGRUN_DEFAULT_MODEL / SIGRUN_MODEL.
			OPENAI_API_KEY: "smoke-test-key-never-sent",
			OPENAI_BASE_URL: "http://127.0.0.1:9",
			SIGRUN_CONFIG_DIR: configDir,
			HOME: dir,
		}),
	);
	try {
		expect(await entry.listening).toBe(port);
		// A present settings file is never rewritten by bootstrap: the
		// file-only defaultModel survives verbatim.
		const file = JSON.parse(
			await readFile(join(configDir, "settings.json"), "utf8"),
		) as { defaultModel?: string };
		expect(file.defaultModel).toBe("openai/gpt-4o");
	} finally {
		entry.child.kill("SIGTERM");
		const exit = await entry.exited;
		expect(exit.code).toBe(0);
		await rm(dir, { recursive: true, force: true });
	}
}, 60_000);

test(
	"deploy entry still honors the deprecated SIGRUN_MODEL alias (one release cycle)",
	async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-entry-alias-"));
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
		expect(await entry.listening).toBe(port);
		// The deprecation warning was printed (stderr), boot succeeded.
		expect(entry.getStderr()).toMatch(
			/SIGRUN_MODEL is deprecated, use SIGRUN_DEFAULT_MODEL/,
		);
		// The env-provided model landed in the bootstrapped file.
		const bootstrapped = JSON.parse(
			await readFile(join(dir, "config", "settings.json"), "utf8"),
		) as { defaultModel?: string };
		expect(bootstrapped.defaultModel).toBe("openai/gpt-4o");
	} finally {
		entry.child.kill("SIGTERM");
		const exit = await entry.exited;
		expect(exit.code).toBe(0);
		await rm(dir, { recursive: true, force: true });
	}
}, 60_000);

test(
	"deploy entry installs a declared packages[] extension and LOADS it (boot-time install)",
	async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-entry-pkg-"));
		const port = await freePort();
		const configDir = join(dir, "config");
		await mkdir(configDir, { recursive: true });
		// The operator flow, end to end: settings.json declares the package
		// (install list + load list), the container restarts, boot installs
		// and loads it. The specifier is a packed TARBALL (npm pack of the
		// fixture), not the fixture dir itself: a registry install lands a
		// real copy, while a file:-directory install SYMLINKS — and a
		// symlinked fixture's imports resolve through the repo's own
		// node_modules, which hits a chord-package exports quirk under tsx
		// that is unrelated to this feature (covered live in
		// packages.test.ts, where import() still succeeds under vitest).
		const { stdout: packOut } = await new Promise<{
			stdout: string;
		}>((resolvePack, rejectPack) => {
			execFile(
				"npm",
				[
					"pack",
					"--pack-destination",
					dir,
					join(REPO_ROOT, "test", "fixtures", "fixture-pkg"),
				],
				(error: Error | null, stdout: string) =>
					error === null ? resolvePack({ stdout }) : rejectPack(error),
			);
		});
		const tarball = join(dir, packOut.trim().split("\n").pop() ?? "");
		await writeFile(
			join(configDir, "settings.json"),
			JSON.stringify({
				extensions: [`file:${tarball}`],
				// builtins off via settings (the spawn-world equivalent of
				// openHarness's `builtins: false`): this test asserts the
				// operator install+load flow's OWN outcome row, not the
				// built-in surface.
				builtinExtensions: {
					codemode: false,
					mcp: false,
					toolSearch: false,
				},
			}) + "\n",
			"utf8",
			);
		const entry = spawnEntry(
			childEnv({
				SIGRUN_DEFAULT_MODEL: "openai/gpt-4o",
				OPENAI_API_KEY: "smoke-test-key-never-sent",
				OPENAI_BASE_URL: "http://127.0.0.1:9",
				SIGRUN_PORT: String(port),
				SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
				SIGRUN_WORKSPACE_PATH: dir,
				SIGRUN_CONFIG_DIR: configDir,
			}),
		);
		try {
			expect(await entry.listening).toBe(port);
			// The package was installed into the packages dir…
			const installed = JSON.parse(
				await readFile(
					join(configDir, "packages", "package.json"),
					"utf8",
				),
			) as { dependencies?: Record<string, string> };
			expect(installed.dependencies?.["fixture-pkg"]).toBeDefined();
			// …and the extension LOADED — outcome ok (not quarantined). The
			// entry's own generation needs a provider, so the assertion is the
			// outcome record + the install, not a /v1/meta equality (a symlinked
			// fixture's import chain is a tsx-invocation detail, not the
			// feature under test).
			const meta = (await (
				await fetch(`http://127.0.0.1:${port}/v1/meta`, {
					headers: SERVICE_BEARER,
				})
			).json()) as { extensions?: readonly { name: string; status: string }[] };
			expect(meta.extensions).toEqual([
				{ name: "sigrun-fixture-ext", status: "ok" },
			]);
		} finally {
			entry.child.kill("SIGTERM");
			const exit = await entry.exited;
			expect(exit.code).toBe(0);
			await rm(dir, { recursive: true, force: true });
		}
	},
	120_000,
);

test("deploy entry fails loud when a declared extension cannot install", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-entry-pkgfail-"));
	const configDir = join(dir, "config");
	await mkdir(configDir, { recursive: true });
	await writeFile(
		join(configDir, "settings.json"),
		JSON.stringify({
			extensions: ["file:/nonexistent/definitely-not-a-package"],
		}) + "\n",
		"utf8",
	);
	const child = spawn(TSX, ["src/index.ts"], {
		cwd: REPO_ROOT,
		env: childEnv({
			SIGRUN_DEFAULT_MODEL: "openai/gpt-4o",
			OPENAI_API_KEY: "x",
			SIGRUN_CONFIG_DIR: configDir,
			SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
			SIGRUN_WORKSPACE_PATH: dir,
		}),
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stderr = "";
	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf-8");
	});
	const exit = await new Promise<{ code: number | null }>((resolve) => {
		child.on("exit", (code) => resolve({ code }));
	});
	try {
		expect(exit.code).toBe(1);
		// Fail-loud, naming the specifier (PackageSyncError → boot catch).
		expect(stderr).toMatch(/extensions:|packages:/);
		expect(stderr).toMatch(/definitely-not-a-package/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}, 120_000);

/**
 * The dual-stack regression (2026-10-24): the entry's default bind must
 * accept IPv6, not just IPv4.
 *
 * The incident: `serve()` bound `0.0.0.0` (a v4-ONLY socket). On a
 * dual-stack pod whose Service is `ipFamilies: ["IPv6"]`, the
 * EndpointSlice advertises only the pod's IPv6 address — the gateway
 * dialed it, got connection-refused, and the browser saw "upstream
 * connect error or disconnect/reset before headers. reset reason:
 * remote connection failure". The v4 loopback probes kept the pod Ready
 * throughout, so nothing else caught it.
 *
 * The assertion is deliberately about reachability on the IPv6 loopback,
 * not about the printed host string: a string assertion passes for a
 * v4-only bind that merely SAYS `::`. Skips on an IPv4-only host.
 */
test(
	"deploy entry's default bind accepts IPv6 connections",
	async () => {
		const ipv6 = await hostHasIpv6Loopback();
		if (!ipv6) {
			// An IPv4-only CI host cannot express this bind; the local
			// dual-stack dev box and the cluster can.
			return;
		}
		const dir = await mkdtemp(join(tmpdir(), "sigrun-entry-v6-"));
		const port = await freePort();
		const entry = spawnEntry(
			childEnv({
				SIGRUN_DEFAULT_MODEL: "openai/gpt-4o",
				OPENAI_API_KEY: "smoke-test-key-never-sent",
				OPENAI_BASE_URL: "http://127.0.0.1:9",
				SIGRUN_PORT: String(port),
				SIGRUN_CONFIG_DIR: join(dir, "config"),
				HOME: dir,
			}),
		);
		try {
			expect(await entry.listening).toBe(port);
			// The bind a Service with `ipFamilies: ["IPv6"]` routes to.
			const overV6 = await fetch(`http://[::1]:${port}/healthz`);
			expect(overV6.status).toBe(200);
			// And the v4 path still works (the dual-stack property, not a
			// v4→v6 swap).
			const overV4 = await fetch(`http://127.0.0.1:${port}/healthz`);
			expect(overV4.status).toBe(200);
		} finally {
			entry.child.kill("SIGTERM");
			await entry.exited;
			await rm(dir, { recursive: true, force: true });
		}
	},
	120_000,
);

/** Whether this host can bind/connect over the IPv6 loopback at all. */
async function hostHasIpv6Loopback(): Promise<boolean> {
	return await new Promise<boolean>((resolve) => {
		const server = net.createServer();
		server.on("error", () => resolve(false));
		server.listen(0, "::1", () => server.close(() => resolve(true)));
	});
}
