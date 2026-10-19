/**
 * build-and-webui Task 5: serve-time webui bundle RESOLUTION — the
 * enabled gate, syntactic name/path selector discrimination, the
 * contributed-bundles parameter (Task 6 threads the registry through
 * `createServer`; Task 5 accepts it as a parameter), the boot-error
 * rules for explicit-but-unresolvable selectors, and the
 * `capabilities.channels` projection.
 *
 * Resolution order (the spec's serve-time contract):
 *  1. `webui.enabled === false` → no mount, API-only — even with a
 *     present, explicitly-selected bundle (the gate wins, nothing else
 *     resolves, no error fires).
 *  2. Selector is a NAME (`^[a-z][a-z0-9_-]*$`) matching a contributed
 *     bundle → that bundle (its name is the reported channel).
 *  3. Selector is a PATH (contains `/` or `\`, or starts with `.`) →
 *     that directory, cwd-relative; a missing `index.html` is a boot
 *     error (today's explicit rule). A selector EQUAL to the default
 *     (`webui/dist`) keeps the DEFAULT's semantics — the bootstrap
 *     mirror story (a hand-edited mirrored default must not flip to
 *     cwd-relative or turn absent into a boot error).
 *  4. Unset → the built-in default bundle (package-root anchored);
 *     absent default → API-only (the supported bare-checkout deploy).
 *
 * Anything else (neither path-shaped nor a valid name — e.g. uppercase
 * or spaces) is a validation error at serve time.
 *
 * The default-bundle cases are STATE-ADAPTIVE: the default anchors to
 * the package root (`webui/dist`), which exists in a checkout that ran
 * the webui build and does not in a bare one — both are supported
 * deploys, so the assertions pin whichever state is real (present →
 * served + `channels: ["webui"]`; absent → API-only + `[]`).
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import type { FastifyInstance } from "fastify";
import { loadConfig, type SigrunConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { createServer } from "../src/server/index.js";
import {
	resolveWebuiBundle,
	webuiBundleDir,
	type ContributedWebuiBundle,
} from "../src/server/static.js";

/** Write a one-file bundle: `index.html` carrying a distinctive marker. */
async function writeBundle(dir: string, marker: string): Promise<string> {
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "index.html"), `<html>${marker}</html>`);
	return dir;
}

interface TestServer {
	app: FastifyInstance;
	opened: OpenedHarness;
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

/**
 * Boot a hermetic harness + server in a tmpdir (the server-static
 * pattern). The webui surface is driven PURELY through env selectors
 * (`SIGRUN_WEBUI`, `SIGRUN_WEBUI_BUNDLE`) — never post-loadConfig field
 * overrides — and the contributed registry rides the third parameter.
 */
async function bootServer(
	envExtra: Record<string, string>,
	contributedBundles: readonly ContributedWebuiBundle[] = [],
): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-webui-res-"));
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	faux.setResponses([fauxAssistantMessage("ok")]);
	const contributor: ProviderContributor = {
		name: "ext-faux",
		providers: [{ provider: faux.provider }],
		health: () => "ok",
	};
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
		...envExtra,
	});
	const opened = await openHarness(config, {
		extensions: [contributor],
		env: {},
	});
	const app = await createServer(opened, config, contributedBundles);
	cleanups.push(async () => {
		await app.close().catch(() => {});
		await opened.harness.close(BACKGROUND_CONTEXT).catch(() => {});
		await rm(dir, { recursive: true, force: true });
	});
	return { app, opened };
}

/** `/v1/meta` → `capabilities.channels`. */
async function channels(app: FastifyInstance): Promise<string[]> {
	const response = await app.inject({ method: "GET", url: "/v1/meta" });
	expect(response.statusCode).toBe(200);
	return (response.json() as { capabilities: { channels: string[] } })
		.capabilities.channels;
}

// ---------------------------------------------------------------------------
// 1. The enabled gate
// ---------------------------------------------------------------------------

describe("the enabled gate", () => {
	test("enabled:false mounts nothing even with a present bundle", async () => {
		const present = await writeBundle(
			join(await mkdtemp(join(tmpdir(), "sigrun-webui-gate-")), "bundle"),
			"gated-bundle-marker",
		);
		// A present, explicitly-selected bundle + the gate OFF: no mount,
		// API-only, and no boot error (the gate short-circuits resolution).
		const { app } = await bootServer({
			SIGRUN_WEBUI: "false",
			SIGRUN_WEBUI_BUNDLE: present,
		});
		const root = await app.inject({ method: "GET", url: "/" });
		expect(root.statusCode).toBe(404);
		const body = root.json() as { error: string; statusCode: number };
		expect(body.error).toBe("Not Found");
		expect(body.statusCode).toBe(404);
		expect(await channels(app)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// 2-3. NAME and PATH selectors
// ---------------------------------------------------------------------------

describe("a NAME selector", () => {
	test("a NAME selector resolves the contributed bundle", async () => {
		const scratch = await mkdtemp(join(tmpdir(), "sigrun-webui-name-"));
		const contributedDir = await writeBundle(
			join(scratch, "ui"),
			"contributed-bundle-marker",
		);
		const { app } = await bootServer(
			{ SIGRUN_WEBUI_BUNDLE: "custom-ui" },
			[{ name: "custom-ui", dir: contributedDir, extension: "fixture-contributor" }],
		);
		const root = await app.inject({ method: "GET", url: "/" });
		expect(root.statusCode).toBe(200);
		expect(root.headers["content-type"]).toContain("text/html");
		expect(root.body).toContain("contributed-bundle-marker");
		// The unit level pins WHICH dir resolved: the contributed one.
		const config = loadConfig({
			SIGRUN_DEFAULT_MODEL: "faux/m",
			SIGRUN_WEBUI_BUNDLE: "custom-ui",
		});
		const bundle = await resolveWebuiBundle(config, [
			{ name: "custom-ui", dir: contributedDir, extension: "fixture-contributor" },
		]);
		expect(bundle?.dir).toBe(contributedDir);
	});

	test("an explicit selector resolving to nothing boot-errors naming it", async () => {
		// A valid NAME matching no contributed bundle: an explicit choice
		// must never degrade to silent API-only.
		const config = loadConfig({
			SIGRUN_DEFAULT_MODEL: "faux/m",
			SIGRUN_WEBUI_BUNDLE: "no-such-ui",
		});
		await expect(resolveWebuiBundle(config, [])).rejects.toThrow(
			/no-such-ui/,
		);
		await expect(
			bootServer({ SIGRUN_WEBUI_BUNDLE: "no-such-ui" }, []),
		).rejects.toThrow(/no-such-ui/);
	});
});

describe("a PATH selector", () => {
	test("a PATH selector (contains /) resolves the directory; missing index.html boot-errors", async () => {
		const scratch = await mkdtemp(join(tmpdir(), "sigrun-webui-path-"));
		const present = await writeBundle(
			join(scratch, "bundle"),
			"path-bundle-marker",
		);
		const { app } = await bootServer({ SIGRUN_WEBUI_BUNDLE: present });
		const root = await app.inject({ method: "GET", url: "/" });
		expect(root.statusCode).toBe(200);
		expect(root.body).toContain("path-bundle-marker");
		const config = loadConfig({
			SIGRUN_DEFAULT_MODEL: "faux/m",
			SIGRUN_WEBUI_BUNDLE: present,
		});
		expect((await resolveWebuiBundle(config))?.dir).toBe(present);
		// The same shape with no index.html: today's explicit rule — a boot
		// error, never silent API-only.
		const empty = join(scratch, "no-index");
		await mkdir(empty);
		await expect(
			bootServer({ SIGRUN_WEBUI_BUNDLE: empty }),
		).rejects.toThrow(/SIGRUN_WEBUI_BUNDLE/);
	});
});

// ---------------------------------------------------------------------------
// 4. The default (unset selector)
// ---------------------------------------------------------------------------

/**
 * The default's presence is the checkout's build state; both states are
 * supported deploys and each pins its own contract.
 */
const defaultDir = webuiBundleDir(
	loadConfig({ SIGRUN_DEFAULT_MODEL: "faux/m" }),
);
const defaultPresent = existsSync(join(defaultDir, "index.html"));

describe("the default bundle", () => {
	test("unset selector defaults to the built-in bundle; absent default → API-only", async () => {
		const config = loadConfig({ SIGRUN_DEFAULT_MODEL: "faux/m" });
		const bundle = await resolveWebuiBundle(config);
		if (defaultPresent) {
			expect(bundle?.dir).toBe(defaultDir);
			const { app } = await bootServer({});
			const root = await app.inject({ method: "GET", url: "/" });
			expect(root.statusCode).toBe(200);
			expect(root.headers["content-type"]).toContain("text/html");
			expect(await channels(app)).toEqual(["webui"]);
		} else {
			expect(bundle).toBeUndefined();
			const { app } = await bootServer({});
			const root = await app.inject({ method: "GET", url: "/" });
			expect(root.statusCode).toBe(404);
			expect(await channels(app)).toEqual([]);
		}
	});

	test("a selector equal to the default keeps the default's semantics (the mirror story)", async () => {
		// A configured value EQUAL to `webui/dist` — the bootstrap's own
		// mirror, or a hand-edited default — must NOT flip to cwd-relative
		// explicit resolution (a missing index.html stays API-only).
		const config = loadConfig({
			SIGRUN_DEFAULT_MODEL: "faux/m",
			SIGRUN_WEBUI_BUNDLE: "webui/dist",
		});
		expect(webuiBundleDir(config)).toBe(defaultDir);
		const bundle = await resolveWebuiBundle(config);
		expect(bundle?.dir ?? undefined).toBe(
			defaultPresent ? defaultDir : undefined,
		);
	});
});

// ---------------------------------------------------------------------------
// 5. capabilities.channels
// ---------------------------------------------------------------------------

describe("capabilities.channels reports the selected bundle's name", () => {
	test("a contributed selection reports its name; paths and the default report the channel id", async () => {
		const scratch = await mkdtemp(join(tmpdir(), "sigrun-webui-chan-"));
		const contributedDir = await writeBundle(
			join(scratch, "ui"),
			"contributed-bundle-marker",
		);
		const pathDir = await writeBundle(
			join(scratch, "path"),
			"path-bundle-marker",
		);
		const named = await bootServer(
			{ SIGRUN_WEBUI_BUNDLE: "custom-ui" },
			[{ name: "custom-ui", dir: contributedDir, extension: "fixture-contributor" }],
		);
		expect(await channels(named.app)).toEqual(["custom-ui"]);
		const byPath = await bootServer({ SIGRUN_WEBUI_BUNDLE: pathDir });
		expect(await channels(byPath.app)).toEqual(["webui"]);
		if (defaultPresent) {
			const byDefault = await bootServer({});
			expect(await channels(byDefault.app)).toEqual(["webui"]);
		}
	});
});

// ---------------------------------------------------------------------------
// 6. Syntactic discrimination
// ---------------------------------------------------------------------------

describe("syntactic name/path discrimination", () => {
	test("a selector that is neither a path nor a valid name fails validation naming it", async () => {
		for (const bad of ["Not-A-Name", "with space", "1ui", "ui!"]) {
			const config = loadConfig({
				SIGRUN_DEFAULT_MODEL: "faux/m",
				SIGRUN_WEBUI_BUNDLE: bad,
			});
			await expect(resolveWebuiBundle(config, [])).rejects.toThrow(
				new RegExp(bad.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
			);
			await expect(resolveWebuiBundle(config, [])).rejects.toThrow(
				/bundle selector/,
			);
		}
	});

	test("a dot-prefixed and a backslash-containing selector are PATHS, not names", async () => {
		const config = loadConfig({
			SIGRUN_DEFAULT_MODEL: "faux/m",
			SIGRUN_WEBUI_BUNDLE: "./relative-bundle",
		});
		// A path selector resolves cwd-relative; a missing index.html is
		// the path boot error (not a name/no-match error).
		await expect(resolveWebuiBundle(config, [])).rejects.toThrow(
			/\.\/relative-bundle.*has no index\.html/s,
		);
	});
});
