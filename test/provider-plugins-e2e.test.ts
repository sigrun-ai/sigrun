/**
 * Provider plugins Task 11: end-to-end integration over the four REAL
 * plugin repos — the seam-shakeout suite.
 *
 * Boots sigrun exactly like the deploy path (`src/serve.ts`, minus the
 * listen): settings file → `syncPackages` (real `npm install` of the four
 * plugins PACKED FROM THEIR LOCAL REPOS into tarballs — the registry
 * install shape: a real copy, not a `file:`-directory symlink, so plugin
 * bare imports must resolve through the packages dir, not the dev
 * checkouts' own node_modules) → `openHarness` with the sync's
 * resolutions → `createServer` → `app.inject()`.
 *
 * Phases (one deployment chain, sequentially):
 *  A. cold boot, NO credentials — all four load ok, no catalog fetch is
 *     attempted (no fixture request), `/v1/auth/check` reports every
 *     plugin `not_configured`, `/v1/models` is empty;
 *  B. restart with credentials in auth.json — the boot refresh populates
 *     every catalog from the fixture upstreams (proving the scoped
 *     settings `baseUrl` overrides steered each plugin at its fixture and
 *     the bridged auth.json credentials reached the wire), `/v1/models`
 *     lists every stamped entry, readiness is `ready`, and the persisted
 *     catalogs land under `<dataDir>/models/`;
 *  C. restart with the fixtures DEAD — the catalogs restore from disk
 *     before any network (pi-ai's offline restore phase), `/v1/models`
 *     serves the same ids, readiness reports `degraded`;
 *  D. restart-required scoped settings — rewriting one plugin's scoped
 *     settings file (`baseUrl`) and restarting re-bakes the plugin: the
 *     NEW fixture serves the next refresh.
 *
 * Hermetic: fixture upstreams are node:http servers on 127.0.0.1; the
 * plugins' ambient env keys are absent from the injected env (the plugins
 * never see `process.env`). The suite NEEDS the four sibling repos
 * (sigrun-ollama / sigrun-opencode / sigrun-pareto / sigrun-bifrost next
 * to this checkout) and skips loudly when they are absent — it is an
 * integration suite over external repos by design.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import { packagesDirOf, syncPackages } from "../src/harness/packages.js";
import { SettingsStore } from "../src/harness/settings.js";
import { createServer } from "../src/server/index.js";
import { seededIdentity } from "./helpers/identity.js";

// ---------------------------------------------------------------------------
// The four real plugin repos (integration inputs)
// ---------------------------------------------------------------------------

/** The plugin repos this suite packs; ordered as the settings list them. */
const PLUGIN_REPOS = [
	"sigrun-ollama",
	"sigrun-opencode",
	"sigrun-pareto",
	"sigrun-bifrost",
] as const;

/**
 * Locate the directory holding the four sibling repos: walk up from this
 * test file until every repo's manifest is present (the sibling layout of
 * this machine's checkout — `~/repos/sigrun-<name>`), capped before the
 * filesystem root.
 */
function locatePluginRoot(): string | undefined {
	let dir = import.meta.dirname;
	for (let hops = 0; hops < 8; hops++) {
		if (PLUGIN_REPOS.every((name) => existsSync(join(dir, name, "package.json")))) {
			return dir;
		}
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
	return undefined;
}

const pluginRoot = locatePluginRoot();
const SKIPPED = pluginRoot === undefined;

// ---------------------------------------------------------------------------
// Fixture upstreams
// ---------------------------------------------------------------------------

/** One fixture upstream: a 200-everything JSON server + request log. */
interface Upstream {
	/** The plugin-facing base URL (scheme://host:port + mount path). */
	readonly baseUrl: string;
	readonly requests: { path: string; authorization?: string }[];
	close(): Promise<void>;
}

async function startUpstream(
	mount: string,
	body: unknown,
): Promise<Upstream> {
	const requests: { path: string; authorization?: string }[] = [];
	const server = http.createServer((req, res) => {
		requests.push({
			path: (req.url ?? "").split("?")[0] ?? "",
			authorization: req.headers.authorization,
		});
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify(body));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new Error("fixture upstream did not report a port");
	}
	return {
		baseUrl: `http://127.0.0.1:${address.port}${mount}`,
		requests,
		close: () =>
			new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

/** `npm pack` one plugin repo (no lifecycle scripts; dist/ is committed). */
async function packPlugin(repoDir: string, destination: string): Promise<string> {
	const { stdout } = await new Promise<{ stdout: string }>(
		(resolve, reject) => {
			execFile(
				"npm",
				["pack", "--ignore-scripts", "--json", "--pack-destination", destination, repoDir],
				{ timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
				(error, out) => (error === null ? resolve({ stdout: out }) : reject(error)),
			);
		},
	);
	try {
		const parsed = JSON.parse(stdout) as { filename?: string }[];
		const filename = parsed.at(-1)?.filename;
		if (filename !== undefined) return join(destination, filename);
	} catch {
		// Non-JSON stdout (npm log noise) — fall through to the line scan.
	}
	const line = stdout
		.trim()
		.split("\n")
		.findLast((entry) => entry.endsWith(".tgz"));
	if (line === undefined) throw new Error(`npm pack produced no tarball for ${repoDir}`);
	return join(destination, line.trim());
}

// ---------------------------------------------------------------------------
// The deployment (settings + packages + harness + server)
// ---------------------------------------------------------------------------

/** One booted deployment, closed between phases. */
interface Deployment {
	app: FastifyInstance;
	opened: OpenedHarness;
	close(): Promise<void>;
}

let configDir = "";
let upstreams: { ollama: Upstream; opencode: Upstream; pareto: Upstream; bifrost: Upstream } | undefined;

/** The synthetic credentials phase B writes into auth.json. */
const KEYS = {
	ollama: "fixture-ollama-key",
	opencode: "fixture-opencode-key",
	pareto: "fixture-pareto-key",
	bifrost: "fixture-bifrost-key",
} as const;

/** The env every boot resolves through — hermetic off process.env. */
function bootEnv(): Record<string, string> {
	return {
		SIGRUN_CONFIG_DIR: configDir,
		SIGRUN_DATA_DIR: join(configDir, "data"),
		SIGRUN_CACHE_DIR: join(configDir, "cache"),
		SIGRUN_STATE_DIR: join(configDir, "state"),
		SIGRUN_WORKSPACE_PATH: join(configDir, "workspace"),
		SIGRUN_PROVIDER_REFRESH_MINUTES: "0",
		SIGRUN_AUTH: "none",
	};
}

/**
 * Boot the deployment exactly like `src/serve.ts` minus the listen: sync
 * the settings file's `extensions` into the packages dir (first boot: one
 * npm install of the four packed tarballs; later boots: the fast path),
 * then open the harness with the sync's resolutions and build the server.
 */
async function bootDeployment(): Promise<Deployment> {
	const env = bootEnv();
	const settingsStore = new SettingsStore({ dir: configDir });
	const settingsFile = settingsStore.read();
	const config = loadConfig(env, settingsFile);
	const packagesDir = packagesDirOf(configDir);
	const resolutions = await syncPackages(settingsFile.extensions ?? [], packagesDir);
	const opened = await openHarness(config, {
		identity: await seededIdentity(configDir),
		extensionEntries: resolutions,
		env,
		// Hermetic: this suite pins the four provider plugins' boot
		// readiness, not the built-in surface (builtins: false = the
		// pre-Task-2 boot shape).
		builtins: false,
		settingsDir: configDir,
		packagesDir,
	});
	const app = await createServer(opened, config);
	return {
		app,
		opened,
		close: async () => {
			await app.close();
			await opened.harness.close(BACKGROUND_CONTEXT);
		},
	};
}

/** GET /v1/models ids as a sorted array (order-independent comparisons). */
async function listModelIds(app: FastifyInstance): Promise<string[]> {
	const response = await app.inject({ method: "GET", url: "/v1/models" });
	expect(response.statusCode).toBe(200);
	const body = response.json() as { models: { id: string }[] };
	return body.models.map((model) => model.id).sort();
}

/** GET /v1/auth/check entries by provider id. */
async function authCheck(
	app: FastifyInstance,
): Promise<
	Map<
		string,
		{ provider: string; status: string; models: number; owner?: string; detail?: string }
	>
> {
	const response = await app.inject({ method: "GET", url: "/v1/auth/check" });
	expect(response.statusCode).toBe(200);
	const body = response.json() as {
		providers: {
			provider: string;
			status: string;
			models: number;
			owner?: string;
			detail?: string;
		}[];
	};
	return new Map(body.providers.map((entry) => [entry.provider, entry]));
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

describe.skipIf(SKIPPED)("provider plugins end-to-end (Task 11)", () => {
	let deployment: Deployment | undefined;
	let phaseBIds: string[] = [];

	beforeAll(async () => {
		if (pluginRoot === undefined) throw new Error("unreachable (skipIf)");
		// The fixture config dir: one settings file + the four plugins'
		// scoped settings pointing their base URLs at the fixture upstreams.
		configDir = await mkdtemp(join(tmpdir(), "sigrun-e2e-config-"));
		const packDir = join(configDir, "pack");
		await mkdir(packDir, { recursive: true });
		const tarballs: Record<string, string> = {};
		for (const name of PLUGIN_REPOS) {
			tarballs[name] = await packPlugin(join(pluginRoot, name), packDir);
		}
		// Upstreams first — the scoped settings need their base URLs.
		upstreams = {
			ollama: await startUpstream("/v1", {
				object: "list",
				data: [
					{ id: "acme/ollama-mini", object: "model", created: 1760000000, owned_by: "ollama" },
					{ id: "acme/ollama-large", object: "model", created: 1760000001, owned_by: "ollama" },
				],
			}),
			opencode: await startUpstream("/zen/go/v1", {
				object: "list",
				data: [{ id: "acme-go-mini", object: "model", created: 1760000000, owned_by: "opencode" }],
			}),
			pareto: await startUpstream("/v1", {
				object: "list",
				data: [
					{
						id: "acme/acme-mini",
						object: "model",
						created: 0,
						owned_by: "acme",
						pricing: { prompt: "0.00000003", completion: "0.0000001" },
					},
					{
						id: "acme/acme-large",
						object: "model",
						created: 0,
						owned_by: "acme",
						pricing: { prompt: "0.00000006", completion: "0.0000002" },
					},
				],
			}),
			// Member-only mode (publishChains defaults false): /v1/models alone.
			bifrost: await startUpstream("/v1", {
				data: [
					{
						id: "acme/gw-mini",
						owned_by: "acme",
						context_length: 262_144,
						pricing: { prompt: "0.0000001", completion: "0.0000005" },
					},
					{
						id: "acme/gw-large",
						owned_by: "acme",
						context_length: 1_000_000,
						pricing: { prompt: "0.0000002", completion: "0.0000009" },
					},
				],
			}),
		};
		await writeFile(
			join(configDir, "settings.json"),
			JSON.stringify(
				{
					extensions: PLUGIN_REPOS.map((name) => `file:${tarballs[name]}`),
					defaultModel: "pareto/acme/acme-mini",
					namingModel: false,
				},
				null,
				"\t",
			),
		);
		await mkdir(join(configDir, "settings"), { recursive: true });
		await writeFile(
			join(configDir, "settings", "provider-ollama.json"),
			JSON.stringify({ baseUrl: upstreams.ollama.baseUrl }),
		);
		await writeFile(
			join(configDir, "settings", "provider-opencode.json"),
			JSON.stringify({ baseUrl: upstreams.opencode.baseUrl }),
		);
		await writeFile(
			join(configDir, "settings", "provider-pareto.json"),
			JSON.stringify({ baseUrl: upstreams.pareto.baseUrl }),
		);
		await writeFile(
			join(configDir, "settings", "provider-bifrost.json"),
			JSON.stringify({ baseUrl: upstreams.bifrost.baseUrl }),
		);
	}, 180_000);

	afterAll(async () => {
		await deployment?.close();
		if (upstreams !== undefined) {
			await upstreams.ollama.close();
			await upstreams.opencode.close();
			await upstreams.pareto.close();
			await upstreams.bifrost.close();
		}
		if (configDir !== "") {
			await rm(configDir, { recursive: true, force: true });
		}
	});

	test(
		"phase A: cold boot without credentials — all four load, nothing fetches, not_configured",
		async () => {
			deployment = await bootDeployment();
			const { opened } = deployment;
			// All four packages loaded through the loader (tarball installs:
			// packages-dir resolution + the extension-package contract).
			expect(opened.extensionOutcomes).toEqual([
				{ name: "provider-ollama", status: "ok" },
				{ name: "provider-opencode", status: "ok" },
				{ name: "provider-pareto", status: "ok" },
				{ name: "provider-bifrost", status: "ok" },
			]);
			await opened.bootRefresh;
			// No credential resolved → pi-ai skips the fetch phase entirely:
			// no fixture request ever happened (and none leaked to the real
			// endpoints — the scoped settings own every base URL).
			expect(upstreams!.ollama.requests).toHaveLength(0);
			expect(upstreams!.opencode.requests).toHaveLength(0);
			expect(upstreams!.pareto.requests).toHaveLength(0);
			expect(upstreams!.bifrost.requests).toHaveLength(0);
			// Empty catalog boot; the default model's provider (pareto) is
			// contributor-owned, so no env-degenerate provider appears.
			expect(await listModelIds(deployment.app)).toEqual([]);
			const readiness = await authCheck(deployment.app);
			expect([...readiness.keys()].sort()).toEqual([
				"bifrost",
				"ollama",
				"opencode",
				"pareto",
			]);
			for (const provider of ["bifrost", "ollama", "opencode", "pareto"]) {
				expect(readiness.get(provider)).toEqual({
					provider,
					status: "not_configured",
					models: 0,
					owner: `provider-${provider}`,
				});
			}
		},
		180_000,
	);

	test(
		"phase B: restart with credentials — catalogs populate over the fixtures, ready, persisted",
		async () => {
			await deployment!.close();
			deployment = undefined;
			// The operator-provisioned credentials (the auth.json bridge).
			await writeFile(
				join(configDir, "auth.json"),
				JSON.stringify({
					ollama: { apiKey: KEYS.ollama },
					opencode: { apiKey: KEYS.opencode },
					pareto: { apiKey: KEYS.pareto },
					bifrost: { apiKey: KEYS.bifrost },
				}),
			);
			deployment = await bootDeployment();
			await deployment.opened.bootRefresh;
			const ids = await listModelIds(deployment.app);
			// The exact merged catalog: every fixture entry, provider-stamped.
			expect(ids).toEqual(
				[
					"ollama/acme/ollama-mini",
					"ollama/acme/ollama-large",
					"opencode/acme-go-mini",
					"pareto/acme/acme-mini",
					"pareto/acme/acme-large",
					"bifrost/acme/gw-mini",
					"bifrost/acme/gw-large",
				].sort(),
			);
			phaseBIds = ids;
			// The bridged auth.json credentials reached the fixture wire.
			expect(upstreams!.ollama.requests[0]).toEqual({
				path: "/v1/models",
				authorization: `Bearer ${KEYS.ollama}`,
			});
			expect(upstreams!.opencode.requests[0]).toEqual({
				path: "/zen/go/v1/models",
				authorization: `Bearer ${KEYS.opencode}`,
			});
			expect(upstreams!.pareto.requests[0]).toEqual({
				path: "/v1/models",
				authorization: `Bearer ${KEYS.pareto}`,
			});
			expect(upstreams!.bifrost.requests[0]).toEqual({
				path: "/v1/models",
				authorization: `Bearer ${KEYS.bifrost}`,
			});
			// Readiness: every tracker reports ready (with the W3 Task 6
			// enrichment: the populated catalog count + owning plugin).
			const readiness = await authCheck(deployment.app);
			expect(readiness.get("bifrost")).toEqual({
				provider: "bifrost",
				status: "ready",
				models: 2,
				owner: "provider-bifrost",
			});
			expect(readiness.get("ollama")).toEqual({
				provider: "ollama",
				status: "ready",
				models: 2,
				owner: "provider-ollama",
			});
			expect(readiness.get("opencode")).toEqual({
				provider: "opencode",
				status: "ready",
				models: 1,
				owner: "provider-opencode",
			});
			expect(readiness.get("pareto")).toEqual({
				provider: "pareto",
				status: "ready",
				models: 2,
				owner: "provider-pareto",
			});
			// The refresh persisted every catalog (the phase-C precondition).
			for (const provider of ["bifrost", "ollama", "opencode", "pareto"]) {
				expect(
					existsSync(join(configDir, "data", "models", `${provider}.json`)),
					`${provider} catalog persisted`,
				).toBe(true);
			}
		},
		120_000,
	);

	test(
		"phase C: restart with the fixtures dead — catalogs restore from disk before network",
		async () => {
			await deployment!.close();
			deployment = undefined;
			// Kill every fixture: the next refresh fails (connection
			// refused — fast, local), so anything the catalogs serve came
			// from the persisted models store, restored offline-first.
			await upstreams!.ollama.close();
			await upstreams!.opencode.close();
			await upstreams!.pareto.close();
			await upstreams!.bifrost.close();
			deployment = await bootDeployment();
			await deployment.opened.bootRefresh;
			expect(await listModelIds(deployment.app)).toEqual(phaseBIds);
			// Configured + last refresh failed → degraded, per tracker.
			const readiness = await authCheck(deployment.app);
			for (const provider of ["bifrost", "ollama", "opencode", "pareto"]) {
				const entry = readiness.get(provider);
				expect(entry?.status).toBe("degraded");
				expect(typeof entry?.detail).toBe("string");
			}
		},
		120_000,
	);

	test(
		"phase D: restart-required scoped settings — a rewritten baseUrl re-bakes on restart",
		async () => {
			await deployment!.close();
			deployment = undefined;
			// A NEW pareto fixture (different catalog) + a rewritten scoped
			// settings file: settings are read once at factory time, so the
			// change applies on the next boot, not before.
			const moved = await startUpstream("/v1", {
				object: "list",
				data: [
					{
						id: "acme/pareto-moved",
						object: "model",
						created: 0,
						owned_by: "acme",
						pricing: { prompt: "0.00000003", completion: "0.0000001" },
					},
				],
			});
			try {
				await writeFile(
					join(configDir, "settings", "provider-pareto.json"),
					JSON.stringify({ baseUrl: moved.baseUrl }),
				);
				deployment = await bootDeployment();
				await deployment.opened.bootRefresh;
				const ids = await listModelIds(deployment.app);
				// The re-baked base URL served: the moved model is in, the
				// old fixture's models are out (a successful refresh
				// replaces the catalog).
				expect(ids).toContain("pareto/acme/pareto-moved");
				expect(ids).not.toContain("pareto/acme/acme-mini");
				expect(moved.requests[0]).toEqual({
					path: "/v1/models",
					authorization: `Bearer ${KEYS.pareto}`,
				});
				const readiness = await authCheck(deployment.app);
				expect(readiness.get("pareto")).toEqual({
					provider: "pareto",
					status: "ready",
					models: 1,
					owner: "provider-pareto",
				});
			} finally {
				await moved.close();
			}
		},
		120_000,
	);
});
