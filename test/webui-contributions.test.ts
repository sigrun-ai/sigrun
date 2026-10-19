/**
 * Task 6 (build-and-webui): extension-contributed webui bundles.
 *
 * A factory result may carry `webuiBundles: readonly { name, dir }[]`; the
 * loader validates it fail-loud (mirroring the provider-contributor
 * pathway), resolves each `dir` against the EXTENSION MODULE's URL (an
 * npm-installed extension's bundle lives in its own package — never the
 * server cwd), and collects the entries attributed to the extension slug.
 * Boot folds the flat collection into a name→bundle registry
 * (last-registered-wins, collision warned + recorded on a sink mirroring
 * the provider-merge shape) and threads it to `createServer`, whose
 * serve-time NAME resolution mounts the selected bundle. The server owns
 * the `index.html` existence check — a contributed dir without one fails
 * at serve time NAMING THE EXTENSION.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { FastifyInstance } from "fastify";
import { loadConfig, type SigrunConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { createServer } from "../src/server/index.js";
import { seededIdentity } from "./helpers/identity.js";

/** The fixture package roots (dirs carry the bundle dirs the entries name). */
const FIXTURE_WEBUI_DIR = join(import.meta.dirname, "fixtures", "fixture-webui");
const FIXTURE_ALT_DIR = join(import.meta.dirname, "fixtures", "fixture-webui-alt");
const SPECIFIER_WEBUI = pathToFileURL(
	join(FIXTURE_WEBUI_DIR, "index.js"),
).href;
const SPECIFIER_ALT = pathToFileURL(join(FIXTURE_ALT_DIR, "index.js")).href;
const SPECIFIER_BAD = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-webui-bad", "index.js"),
).href;
const SPECIFIER_NOINDEX = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-webui-noindex", "index.js"),
).href;
const SPECIFIER_ONLY = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-webui-only", "index.js"),
).href;

function configWith(dir: string, extra: Record<string, string> = {}) {
	return loadConfig({
		SIGRUN_MODEL: "openai/gpt-4o",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_AUTH: "none",
		SIGRUN_WORKSPACE_PATH: dir,
		...extra,
	});
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

/** Boot the harness with fixture specifiers; close + clean up after. */
async function withOpenedHarness(
	specifiers: readonly string[],
	run: (opened: OpenedHarness, config: SigrunConfig) => Promise<void>,
	envExtra: Record<string, string> = {},
	options: { contributors?: readonly ProviderContributor[] } = {},
): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-webui-contrib-"));
	const config = configWith(dir, envExtra);
	let opened: OpenedHarness | undefined;
	try {
		opened = await openHarness(config, {
		identity: await seededIdentity(dir),
			env: {},
			extensionSpecifiers: specifiers,
			...(options.contributors === undefined
				? {}
				: { extensions: options.contributors }),
		});
		await run(opened, config);
	} finally {
		await opened?.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	}
}

/** Boot harness + server in a tmpdir (the server-static pattern). */
async function bootServer(
	specifiers: readonly string[],
	envExtra: Record<string, string>,
	options: { contributors?: readonly ProviderContributor[] } = {},
): Promise<{ app: FastifyInstance; opened: OpenedHarness }> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-webui-contrib-srv-"));
	const config = configWith(dir, envExtra);
	const opened = await openHarness(config, {
		identity: await seededIdentity(dir),
		env: {},
		extensionSpecifiers: specifiers,
		...(options.contributors === undefined
			? {}
			: { extensions: options.contributors }),
	});
	const app = await createServer(opened, config, opened.webuiBundles);
	cleanups.push(async () => {
		await app.close().catch(() => {});
		await opened.harness.close(BACKGROUND_CONTEXT).catch(() => {});
		await rm(dir, { recursive: true, force: true });
	});
	return { app, opened };
}

/** `/v1/meta` → the parsed body. */
async function getMeta(app: FastifyInstance): Promise<Record<string, unknown>> {
	const response = await app.inject({ method: "GET", url: "/v1/meta" });
	expect(response.statusCode).toBe(200);
	return response.json() as Record<string, unknown>;
}

test("an extension contributing webuiBundles registers them", async () => {
	await withOpenedHarness([SPECIFIER_WEBUI], async (opened, config) => {
		expect(opened.extensionOutcomes).toEqual([
			{ name: "sigrun-fixture-webui", status: "ok" },
		]);
		// The retained registry: loader-attributed, module-anchored.
		expect(opened.webuiBundles).toContainEqual({
			name: "fixture-ui",
			dir: join(FIXTURE_WEBUI_DIR, "webui"),
			extension: "sigrun-fixture-webui",
		});
	});
	// And the registered bundle SERVES under its NAME selector, reporting
	// its own name as the channel.
	const dir = await mkdtemp(join(tmpdir(), "sigrun-webui-contrib-reg-"));
	cleanups.push(async () => {
		await rm(dir, { recursive: true, force: true });
	});
	const config = configWith(dir, { SIGRUN_WEBUI_BUNDLE: "fixture-ui" });
	const opened = await openHarness(config, {
		identity: await seededIdentity(dir),
		env: {},
		extensionSpecifiers: [SPECIFIER_WEBUI],
	});
	cleanups.push(async () => {
		await opened.harness.close(BACKGROUND_CONTEXT).catch(() => {});
	});
	const app = await createServer(opened, config, opened.webuiBundles);
	cleanups.push(async () => {
		await app.close().catch(() => {});
	});
	const root = await app.inject({ method: "GET", url: "/" });
	expect(root.statusCode).toBe(200);
	expect(root.body).toContain("sigrun-fixture-webui-bundle");
	const meta = await getMeta(app);
	expect((meta as { capabilities: { channels: string[] } }).capabilities.channels).toEqual([
		"fixture-ui",
	]);
});

test("a malformed webuiBundles entry quarantines the extension", async () => {
	await withOpenedHarness([SPECIFIER_BAD], async (opened) => {
		expect(opened.extensionOutcomes).toHaveLength(1);
		const outcome = opened.extensionOutcomes[0];
		expect(outcome.status).toBe("quarantined");
		expect(outcome.name).toContain("fixture-webui-bad");
		expect(outcome.error).toMatch(/webuiBundles/);
		// A quarantined extension contributes nothing.
		expect(opened.webuiBundles).toEqual([]);
		expect(opened.webuiBundleCollisions).toEqual([]);
	});
});

test("a name collision warns, last-wins, and records to the sink", async () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	try {
		const { app, opened } = await bootServer(
			[SPECIFIER_WEBUI, SPECIFIER_ALT],
			{ SIGRUN_WEBUI_BUNDLE: "fixture-ui" },
		);
		// Last-registered-wins: the ALT fixture's entry owns the name.
		const entry = opened.webuiBundles.find(
			(bundle) => bundle.name === "fixture-ui",
		);
		expect(entry).toEqual({
			name: "fixture-ui",
			dir: join(FIXTURE_ALT_DIR, "webui-alt"),
			extension: "sigrun-fixture-webui-alt",
		});
		// The collision sink mirrors the provider-merge shape.
		expect(opened.webuiBundleCollisions).toEqual([
			{
				kind: "webui-bundle",
				name: "fixture-ui",
				previous: "sigrun-fixture-webui",
				contributor: "sigrun-fixture-webui-alt",
			},
		]);
		// The warn is part of the contract (never silent).
		expect(warn).toHaveBeenCalledWith(
			expect.stringMatching(/webui bundle collision/),
		);
		// And the served bundle is the LAST registration's.
		const root = await app.inject({ method: "GET", url: "/" });
		expect(root.statusCode).toBe(200);
		expect(root.body).toContain("sigrun-fixture-webui-alt-bundle");
	} finally {
		warn.mockRestore();
	}
});

test("a contributed dir resolves against the extension module URL", async () => {
	await withOpenedHarness([SPECIFIER_WEBUI], async (opened) => {
		// A RELATIVE dir anchors at the extension MODULE's directory —
		// never the process cwd (an npm-installed extension's bundle lives
		// in its own package).
		const relative = opened.webuiBundles.find(
			(bundle) => bundle.name === "fixture-ui",
		);
		expect(relative?.dir).toBe(join(FIXTURE_WEBUI_DIR, "webui"));
		// An ABSOLUTE dir passes through EXACTLY as contributed.
		const absolute = opened.webuiBundles.find(
			(bundle) => bundle.name === "fixture-abs",
		);
		expect(absolute?.dir).toBe(join(FIXTURE_WEBUI_DIR, "webui"));
	});
});

test("a contributed dir lacking index.html fails at serve time naming the extension", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-webui-contrib-noidx-"));
	cleanups.push(async () => {
		await rm(dir, { recursive: true, force: true });
	});
	const config = configWith(dir, { SIGRUN_WEBUI_BUNDLE: "fixture-noindex" });
	const opened = await openHarness(config, {
		identity: await seededIdentity(dir),
		env: {},
		extensionSpecifiers: [SPECIFIER_NOINDEX],
	});
	cleanups.push(async () => {
		await opened.harness.close(BACKGROUND_CONTEXT).catch(() => {});
	});
	// The registry DID collect the bundle (the loader has no fs coupling —
	// the server owns the index.html check).
	expect(opened.webuiBundles).toEqual([
		{
			name: "fixture-noindex",
			dir: join(
				dirname(fileURLToPath(SPECIFIER_NOINDEX)),
				"no-bundle-dir",
			),
			extension: "sigrun-fixture-webui-noindex",
		},
	]);
	// Serve time fails loud, naming BOTH the bundle and the extension.
	await expect(
		createServer(opened, config, opened.webuiBundles),
	).rejects.toThrow(/sigrun-fixture-webui-noindex/);
	await expect(
		createServer(opened, config, opened.webuiBundles),
	).rejects.toThrow(/fixture-noindex/);
});

test("a contributor-only webuiBundles result (no extension field) registers", async () => {
	await withOpenedHarness([SPECIFIER_ONLY], async (opened) => {
		// The contributor-only gate accepts providers OR webuiBundles: this
		// result carries only the latter, with a `name` — it loads clean
		// (final-review tripwire: if the gate regresses to providers-only,
		// the contribution silently disappears and this test fails).
		expect(opened.extensionOutcomes).toEqual([
			{ name: "sigrun-fixture-webui-only", status: "ok" },
		]);
		// Nothing pi-durable behind it — no registry entry by that name.
		expect(
			opened.registry.snapshot().extension("sigrun-fixture-webui-only"),
		).toBeUndefined();
		// And the contribution REGISTERED: slug-attributed, anchored at the
		// fixture module's directory.
		expect(opened.webuiBundles).toEqual([
			{
				name: "fixture-only-ui",
				dir: join(
					dirname(fileURLToPath(SPECIFIER_ONLY)),
					"webui",
					),
				extension: "sigrun-fixture-webui-only",
			},
		]);
		expect(opened.webuiBundleCollisions).toEqual([]);
	});
});

test("/v1/meta reports the collisions (webui + provider sinks)", async () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	try {
		// A provider collision (two contributors claiming provider "clash")
		// alongside the webui-bundle collision from the fixture pair.
		const a = fauxProvider({
			provider: "clash",
			models: [{ id: "m", contextWindow: 128_000 }],
		});
		a.setResponses([fauxAssistantMessage("ok")]);
		const b = fauxProvider({
			provider: "clash",
			models: [{ id: "m", contextWindow: 128_000 }],
		});
		b.setResponses([fauxAssistantMessage("ok")]);
		const contributors: readonly ProviderContributor[] = [
			{ name: "ext-a", providers: [{ provider: a.provider }] },
			{ name: "ext-b", providers: [{ provider: b.provider }] },
		];
		const { app } = await bootServer(
			[SPECIFIER_WEBUI, SPECIFIER_ALT],
			{ SIGRUN_WEBUI_BUNDLE: "fixture-ui", SIGRUN_MODEL: "clash/m" },
			{ contributors },
		);
		const meta = (await getMeta(app)) as {
			collisions: {
				webui: unknown[];
				providers: unknown[];
			};
		};
		expect(meta.collisions.webui).toEqual([
			{
				kind: "webui-bundle",
				name: "fixture-ui",
				previous: "sigrun-fixture-webui",
				contributor: "sigrun-fixture-webui-alt",
			},
		]);
		// The provider sink — retained-but-never-read until this field —
		// rides the SAME meta surface.
		expect(meta.collisions.providers).toEqual([
			{
				kind: "provider",
				provider: "clash",
				modelIds: ["m"],
				previous: "ext-a",
				contributor: "ext-b",
			},
		]);
	} finally {
		warn.mockRestore();
	}
});
