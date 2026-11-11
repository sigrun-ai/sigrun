import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { ResolvedExtensionInput } from "../src/harness/loader.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { NoticeStore } from "../src/notices/store.js";
import { createServer } from "../src/server/index.js";
import type { FastifyInstance } from "fastify";
import { NOTICE_LIMITS } from "@sigrun/shared/notices";
import { seededIdentity } from "./helpers/identity.js";
import {
	declared as factoryNoticeDeclared,
	reset as resetFactoryNotice,
} from "./fixtures/fixture-settings-factory-notice/index.js";
import {
	factoryRead as builtinFactoryRead,
	factoryStateDir as builtinFactoryStateDir,
	reset as resetBuiltin,
} from "./fixtures/fixture-settings-builtin-mcp/index.js";
import {
	declared,
	reset as resetDeclared,
} from "./fixtures/fixture-settings-declare/index.js";
import {
	factoryRead as mismatchFactoryRead,
	reset as resetMismatch,
} from "./fixtures/fixture-settings-mismatch/index.js";

const DECLARING = fixture("fixture-settings-declare");
const TWICE = fixture("fixture-settings-twice");
const LATE = fixture("fixture-settings-late");
const MALFORMED = fixture("fixture-settings-malformed");
const OLD_SECTION = fixture("fixture-settings-old-section");
const MISMATCH = fixture("fixture-settings-mismatch");
const BUILTIN_MCP = fixture("fixture-settings-builtin-mcp");
const RESERVED = fixture("fixture-settings-reserved-id");
const FACTORY_NOTICE = fixture("fixture-settings-factory-notice");
const cleanups: Array<() => Promise<void>> = [];

function fixture(name: string): string {
	return pathToFileURL(join(import.meta.dirname, "fixtures", name, "index.js")).href;
}

afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0)) await cleanup();
	resetBuiltin();
	resetMismatch();
	resetDeclared();
	resetFactoryNotice();
});

interface Rig {
	readonly opened: OpenedHarness;
	readonly dir: string;
	readonly app?: FastifyInstance;
}

async function boot(
	specifiers: readonly (string | ResolvedExtensionInput)[],
	options: {
		readonly settings?: Record<string, unknown>;
		readonly userSettings?: Record<string, unknown>;
		readonly secrets?: Record<string, unknown>;
		readonly server?: boolean;
		readonly settingsFile?: string;
		readonly builtinSettings?: Record<string, unknown>;
		readonly extraBuiltins?: readonly string[];
		readonly realBuiltins?: boolean;
	} = {},
): Promise<Rig> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-settings-declare-"));
	const configDir = join(dir, "config");
	await mkdir(join(configDir, "settings"), { recursive: true });
	if (options.settings !== undefined) {
		await writeFile(
			join(configDir, "settings", options.settingsFile ?? "acme-settings.json"),
			JSON.stringify(options.settings),
		);
	}
	if (options.userSettings !== undefined) {
		await mkdir(join(configDir, "user-settings", "tester"), { recursive: true });
		await writeFile(
			join(configDir, "user-settings", "tester", "acme-settings.json"),
			JSON.stringify(options.userSettings),
		);
	}
	if (options.builtinSettings !== undefined) {
		await writeFile(
			join(configDir, "settings", "sigrun-mcp.json"),
			JSON.stringify(options.builtinSettings),
		);
	}
	if (options.secrets !== undefined) {
		await writeFile(
			join(configDir, "secrets.json"),
			JSON.stringify({ "acme-settings": options.secrets }),
			{ mode: 0o600 },
		);
	}
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
		SIGRUN_CONFIG_DIR: configDir,
		SIGRUN_DATA_DIR: join(dir, "data"),
		SIGRUN_CACHE_DIR: join(dir, "cache"),
		SIGRUN_STATE_DIR: join(dir, "state"),
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
	});
	const opened = await openHarness(config, {
		identity: await seededIdentity(dir),
		extensions: [contributor],
		env: { SIGRUN_CONFIG_DIR: configDir },
		settingsDir: dir,
		builtins: options.realBuiltins === true ? true : false,
		builtinResolver: (specifier, fallback) =>
			specifier === "@sigrun/ext-mcp"
				? { name: specifier, entry: BUILTIN_MCP, settingsSlug: "sigrun-mcp" }
				: fallback(specifier),
		...(options.realBuiltins === true
			? { extensionEntries: specifiers as readonly ResolvedExtensionInput[] }
			: { extensionSpecifiers: specifiers as readonly string[] }),
		extraBuiltins: options.extraBuiltins,
		expectHostBridge: options.server,
	});
	let app: FastifyInstance | undefined;
	if (options.server === true) app = await createServer(opened, config);
	cleanups.push(async () => {
		await app?.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		// The notice store's shutdown drain can still be writing when the
		// harness closes (a settings.invalid notice from the last get());
		// retry the removal briefly instead of racing the drain's tail.
		for (let attempt = 0; ; attempt++) {
			try {
				await rm(dir, { recursive: true, force: true });
				return;
			} catch (cause) {
				if (attempt >= 20 || (cause as NodeJS.ErrnoException).code !== "ENOTEMPTY") {
					throw cause;
				}
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
		}
	});
	return { opened, dir, app };
}

async function invalidNotices(rig: Rig) {
	const store = new NoticeStore({
		userArea: join(rig.dir, "data", "users", "tester"),
		user: "tester",
		userCreatedAt: () => rig.opened.identity.users.get("tester")?.createdAt,
		now: () => new Date("2026-11-08T00:00:00.000Z"),
		onChange: () => {},
		log: () => {},
	});
	return (await store.list()).filter((notice) => notice.key === "settings.invalid");
}

test("userSchema may not use x-sigrun-env", async () => {
	const { opened } = await boot([fixture("fixture-settings-user-env")]);
	expect(opened.extensionOutcomes[0]).toMatchObject({ status: "quarantined" });
	expect(opened.extensionOutcomes[0]?.error).toMatch(/userSchema.*x-sigrun-env/);
	expect(opened.extensionOutcomes[0]?.error).toContain("non-admin");
});

test("declare returns defaults for an empty file", async () => {
	const { opened } = await boot([DECLARING]);
	await expect(declared?.get()).resolves.toEqual({ interval: 60, group: { label: "acme" } });
	expect(opened.extensionSettingsDeclarations).toHaveLength(1);
	expect(opened.extensionSettingsDeclarations[0]?.extension).toBe("acme-settings");
});

test("get fills nested secrets", async () => {
	await boot([DECLARING], {
		settings: { servers: { gateway: { headers: { Authorization: "" } } } },
		secrets: { "servers/gateway/headers/Authorization": "Bearer synthetic" },
	});
	await expect(declared?.get()).resolves.toMatchObject({
		servers: { gateway: { headers: { Authorization: "Bearer synthetic" } } },
	});
});

test("invalid stored value falls back with a notice", async () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	const rig = await boot([DECLARING], { settings: { interval: "often" }, server: true });
	await expect(declared?.get()).resolves.toMatchObject({ interval: 60 });
	await expect(declared?.get()).resolves.toMatchObject({ interval: 60 });
	await vi.waitFor(async () => expect(await invalidNotices(rig)).toHaveLength(1));
	const [notice] = await invalidNotices(rig);
	expect(notice?.owner).toBe("acme-settings");
	expect(notice?.body).toContain("acme-settings");
	expect(notice?.body).toContain("/interval");
	expect(notice?.body).toContain("replaced");
	expect(notice?.actions).toEqual([
		expect.objectContaining({
			kind: "navigate",
			target: { settings: "acme-settings" },
		}),
	]);
	expect(warn.mock.calls.filter((call) => String(call[0]).includes("/interval"))).toHaveLength(1);
});

test("a factory-time checked read leaves the invalid notice for a post-bind read", async () => {
	const rig = await boot([FACTORY_NOTICE], {
		settingsFile: "acme-factory-notice.json",
		settings: { interval: "often" },
		server: true,
	});
	expect(await invalidNotices(rig)).toHaveLength(0);
	await expect(factoryNoticeDeclared?.get()).resolves.toMatchObject({ interval: 60 });
	await vi.waitFor(async () => expect(await invalidNotices(rig)).toHaveLength(1));
});

test("generateForm warnings are hoisted out of repeated checked reads", async () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	await boot([FACTORY_NOTICE], {
		settingsFile: "acme-factory-notice.json",
		settings: {},
	});
	const before = warn.mock.calls.filter((call) => String(call[0]).includes("outside the drawable subset")).length;
	await factoryNoticeDeclared?.get();
	await factoryNoticeDeclared?.get();
	expect(warn.mock.calls.filter((call) => String(call[0]).includes("outside the drawable subset"))).toHaveLength(before);
});

test("the invalid notice dedupes paths and respects the body limit", async () => {
	const settings = {
		interval: "often",
		untyped: Object.fromEntries(Array.from({ length: 100 }, (_, index) => [
			`bad${index}`,
			"wrong",
		])),
	};
	const rig = await boot([FACTORY_NOTICE], {
		settingsFile: "acme-factory-notice.json",
		settings,
		server: true,
	});
	await factoryNoticeDeclared?.get();
	await vi.waitFor(async () => expect(await invalidNotices(rig)).toHaveLength(1));
	const [notice] = await invalidNotices(rig);
	expect(notice?.body?.length).toBeLessThanOrEqual(NOTICE_LIMITS.body);
	expect(notice?.body?.match(/\/interval/g)).toHaveLength(1);
});

test("declare twice throws", async () => {
	const { opened } = await boot([TWICE]);
	expect(opened.extensionOutcomes[0]).toMatchObject({ status: "quarantined" });
	expect(opened.extensionOutcomes[0]?.error).toContain("settings.declare may only be called once");
});

test("declare after the factory returned throws", async () => {
	const { opened } = await boot([LATE]);
	expect(() => opened.seamHosts.get("acme-late")!.settings.declare({
		schema: { type: "object", properties: {} },
	})).toThrow("settings.declare must be called during the factory");
});

test("a malformed schema quarantines the extension naming the keyword", async () => {
	const { opened } = await boot([MALFORMED]);
	expect(opened.extensionOutcomes[0]).toMatchObject({ status: "quarantined" });
	expect(opened.extensionOutcomes[0]?.error).toContain("x-sigrun-key");
});

test("surfaces.settings fails the load with the replacement message", async () => {
	const { opened } = await boot([OLD_SECTION]);
	expect(opened.extensionOutcomes[0]).toMatchObject({ status: "quarantined" });
	expect(opened.extensionOutcomes[0]?.error).toBe(
		"surfaces.settings is replaced by host.settings.declare (see docs/extending.md)",
	);
});

test("user(u).get() validates against userSchema", async () => {
	await boot([DECLARING], {
		settings: { mode: "shared" },
		userSettings: { nickname: 7, enabled: "yes" },
	});
	await expect(declared?.get()).resolves.toMatchObject({ mode: "shared" });
	await expect(declared?.user("tester").get()).resolves.toEqual({
		nickname: "tester",
		enabled: true,
	});
	await expect(declared?.user("tester").get()).resolves.not.toEqual({ mode: "shared" });
});

test("a built-in whose package name differs from its slug reads its own file in the factory", async () => {
	const { opened } = await boot([], {
		builtinSettings: { endpoint: "https://mcp.example.invalid" },
		realBuiltins: true,
	});
	// Without implementation-side pre-keying the factory reads ext-mcp.json,
	// not this package's declared sigrun-mcp settings file.
	expect(opened.extensionOutcomes.find((row) => row.name === "sigrun-mcp" && row.status === "ok")).toBeDefined();
	expect(builtinFactoryRead()).toEqual({ endpoint: "https://mcp.example.invalid" });
});

test("a built-in pre-keys only settings and secrets, not factory-captured paths", async () => {
	const { dir } = await boot([], { realBuiltins: true });
	expect(builtinFactoryStateDir()).toBe(join(dir, "state", "ext-mcp"));
});

test("a slug mismatch after re-key fails the load naming both", async () => {
	const { opened } = await boot([MISMATCH]);
	expect(opened.extensionOutcomes[0]).toMatchObject({ status: "quarantined" });
	expect(opened.extensionOutcomes[0]?.error).toContain("index");
	expect(opened.extensionOutcomes[0]?.error).toContain("acme-final");
	expect(mismatchFactoryRead()).toEqual({ from: "index" });
});

test("a failing entry with no default is dropped and named in the notice", async () => {
	const rig = await boot([DECLARING], {
		settings: {
			entries: [
				{ name: "good.example.invalid", port: 443 },
				{ name: "bad.example.invalid", port: "https" },
			],
		},
		server: true,
	});
	await expect(declared?.get()).resolves.toMatchObject({
		entries: [{ name: "good.example.invalid", port: 443 }],
	});
	await vi.waitFor(async () => expect(await invalidNotices(rig)).toHaveLength(1));
	const [notice] = await invalidNotices(rig);
	expect(notice?.body).toContain("/entries/1");
	expect(notice?.body).toContain("dropped");
});

test("declaring settings reserves the settings and user-settings surface ids", async () => {
	const { opened } = await boot([RESERVED]);
	expect(opened.extensionOutcomes[0]).toMatchObject({ status: "quarantined" });
	expect(opened.extensionOutcomes[0]?.error).toContain("settings");
});
