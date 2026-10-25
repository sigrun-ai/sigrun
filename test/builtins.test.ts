/**
 * Built-in extensions: codemode, MCP, tool search and OAuth ship WITH
 * core — present by default, disableable via settings
 * `builtinExtensions`, replaceable by a same-named configured extension.
 *
 * Hermetic pattern (server.test.ts): a faux provider serves `faux/m`
 * through a provider contributor; `openHarness` boots in a tmpdir;
 * `createServer` builds the Fastify app; `app.inject()` exercises routes
 * in-process. The built-ins resolve from core's own node_modules (real
 * `sigrun-ext-*` file: dependencies), never the packages dir.
 *
 * MCP tests point `SIGRUN_MCP_CONFIG` (via the boot env seam) at a temp
 * mcp.json naming the in-repo stdio fixture server
 * (test/fixtures/stub-mcp-server.mjs) — a real JSON-RPC handshake, no
 * network, no npx.
 *
 * The auto-enable assertions check the LIVE model-offered tool set
 * (`conversation.agent().tools`): the implementation narrows the offered
 * set by names via the stored `modelTools` `{remove: [...]}` edit form
 * (NOT the array form), so `tool_search`'s `control.addTools` merges
 * into the full default-offered set instead of a frozen boot snapshot.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxToolCall,
	fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import {
	defineTool,
	type Conversation,
	type ConversationId,
	type ToolExecutionApi,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import type { SigrunHost } from "../src/extension.js";
import { loadConfig, type SigrunConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import { SettingsStore, SettingsValidationError, settingsPath } from "../src/harness/settings.js";
import type { ResolvedExtensionInput } from "../src/harness/loader.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { createServer } from "../src/server/index.js";
import { seededIdentity } from "./helpers/identity.js";
import type { FastifyInstance } from "fastify";

/** Replacement fixtures whose manifest names match built-in packages. */
const REPLACES_MCP_SPECIFIER = pathToFileURL(
	join(
		import.meta.dirname,
		"fixtures",
		"fixture-replaces-mcp",
		"index.js",
	),
).href;
const REPLACES_OAUTH_SPECIFIER = pathToFileURL(
	join(
		import.meta.dirname,
		"fixtures",
		"fixture-replaces-oauth",
		"index.js",
	),
).href;

/** The throwing fixture (the built-in quarantine path). */
const THROWING_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-throwing", "index.js"),
).href;

/** The fixture declaring the host's per-user publication capability. */
const USER_TOOLS_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-user-tools", "index.js"),
).href;

/** The in-repo stdio MCP fixture server. */
const STUB_MCP_SERVER = join(
	import.meta.dirname,
	"fixtures",
	"stub-mcp-server.mjs",
);

interface TestServer {
	app: FastifyInstance;
	opened: OpenedHarness;
	config: SigrunConfig;
	faux: ReturnType<typeof fauxProvider>;
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

beforeEach(() => {
	vi.restoreAllMocks();
});

/** Boot the auto-enable matrix server (built-ins on, MCP config per the option). */
async function bootBuiltins(options?: {
	readonly extensionSpecifiers?: readonly string[];
	/** mcp.json body written into the tmpdir (SIGRUN_MCP_CONFIG points at it). */
	readonly mcpServers?: Record<string, unknown>;
	/** Extra settings-file fields (merged with `namingModel: false`). */
	readonly settings?: Record<string, unknown>;
	/** Test-only: additional built-in load entries (the quarantine seam). */
	readonly extraBuiltins?: readonly string[];
	readonly unresolvableOAuth?: boolean;
	readonly multiUser?: boolean;
}): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-builtins-"));
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	faux.setResponses([fauxAssistantMessage("hello answer")]);
	const contributor: ProviderContributor = {
		name: "ext-faux",
		providers: [{ provider: faux.provider }],
	};
	const env: Record<string, string> = {
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_AUTH: options?.multiUser === true ? "token" : "none",
		SIGRUN_WORKSPACE_PATH: dir,
	};
	if (options?.mcpServers !== undefined) {
		const mcpPath = join(dir, "mcp.json");
		await writeFile(
			mcpPath,
			JSON.stringify({ servers: options.mcpServers }),
			"utf8",
		);
		env.SIGRUN_MCP_CONFIG = mcpPath;
		// The built-in MCP extension reads `process.env` directly (its
		// factory-time config load has no boot-env seam — the recorded
		// known limitation), so the override must exist in the REAL env too.
		// Saved/restored so one boot's override never leaks into the next.
		const saved = process.env.SIGRUN_MCP_CONFIG;
		process.env.SIGRUN_MCP_CONFIG = mcpPath;
		cleanups.push(async () => {
			if (saved === undefined) delete process.env.SIGRUN_MCP_CONFIG;
			else process.env.SIGRUN_MCP_CONFIG = saved;
		});
	}
	const config0 = loadConfig(env);
	const config: SigrunConfig = {
		...config0,
		webui: { ...config0.webui, enabled: false },
	};
	await writeFile(
		join(dir, "settings.json"),
		JSON.stringify({ namingModel: false, ...options?.settings }),
	);
	const opened = await openHarness(config, {
		identity: await seededIdentity(dir),
		extensions: [contributor],
		env,
		...(options?.extensionSpecifiers === undefined
			? {}
			: { extensionSpecifiers: options.extensionSpecifiers }),
		...(options?.extraBuiltins === undefined
			? {}
			: { extraBuiltins: options.extraBuiltins }),
		...(options?.unresolvableOAuth === true
			? {
					builtinResolver: (
						specifier: string,
						fallback: (specifier: string) => ResolvedExtensionInput,
					) =>
						specifier === "@sigrun/oauth"
							? {
									name: specifier,
									entry: pathToFileURL(join(tmpdir(), "missing-sigrun-oauth.js")).href,
								}
							: fallback(specifier),
				}
			: {}),
		settingsDir: dir,
		...(options?.multiUser === true
			? { isolationProbe: async () => ({ available: true, abi: 6 }) }
			: {}),
	});
	const app = await createServer(opened, config);
	const teardown = async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	};
	cleanups.push(teardown);
	return { app, opened, config, faux };
}

/** The stdio MCP server entry naming the in-repo stub. */
function stubServer(extra?: Record<string, unknown>): Record<string, unknown> {
	return {
		// These pre-catalog fixtures assert the system-tool surface. Catalog
		// credentials default to per-user, so retain their original path.
		credentials: "shared",
		sharedAuthority: "Synthetic shared test authority",
		command: process.execPath,
		args: [STUB_MCP_SERVER],
		...extra,
	};
}

/** Create a conversation and read back its LIVE model-offered tool names. */
async function offeredToolNames(
	app: FastifyInstance,
	opened: OpenedHarness,
): Promise<string[]> {
	const response = await app.inject({
		method: "POST",
		url: "/v1/conversations",
		payload: {},
		headers: { "content-type": "application/json" },
	});
	expect(response.statusCode).toBe(201);
	const { id } = response.json() as { id: number };
	const conversation = await opened.harness.conversation(
		id as ConversationId,
		BACKGROUND_CONTEXT,
	);
	const agent = await conversation!.agent(BACKGROUND_CONTEXT);
	return agent.tools.map((tool) => tool.name);
}

/**
 * Wait (bounded) for an MCP tool to appear in the registry: the built-in
 * MCP extension's discovery is ASYNC BY CONTRACT (the factory returns
 * immediately; discovered tools land in the live `tools` array the
 * registry re-reads per snapshot), so a test asserting discovery must
 * poll rather than snapshot immediately after boot. Polling (not a fixed
 * sleep) keeps it deterministic: 10ms ticks, 10s ceiling.
 */
async function waitForTool(
	opened: OpenedHarness,
	name: string,
): Promise<void> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		const names = opened.registry
			.snapshot()
			.tools()
			.map((entry) => entry.tool.name);
		if (names.includes(name)) return;
		if (Date.now() > deadline) {
			throw new Error(`tool "${name}" never registered (tools: ${JSON.stringify(names)})`);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/** The stored agent doc of the newest conversation (modelTools untouched check). */
async function storedAgentDoc(
	app: FastifyInstance,
): Promise<Record<string, unknown>> {
	const response = await app.inject({
		method: "POST",
		url: "/v1/conversations",
		payload: {},
		headers: { "content-type": "application/json" },
	});
	expect(response.statusCode).toBe(201);
	return response.json().view.docs["pi.agent"] as Record<string, unknown>;
}

function acmeHost(opened: OpenedHarness): SigrunHost {
	const host = opened.seamHosts.get("acme");
	if (host === undefined) throw new Error("acme host missing");
	return host;
}

function perUserProbe(deferred: boolean): ToolRegistration {
	return defineTool({
		name: "acme_probe",
		description: "Alice's synthetic per-user probe",
		parameters: Type.Object({}),
		...(deferred ? { deferred: true } : {}),
		execute: async () => ({ output: [{ type: "text" as const, text: "probe" }] }),
	});
}

async function ownedConversation(
	app: FastifyInstance,
	opened: OpenedHarness,
	owner: "alice" | "bob",
): Promise<Conversation> {
	await opened.identity.users.add({ user: owner, admin: false, source: "cli" });
	const { token } = await opened.identity.tokens.create(`${owner}-cli`, owner);
	const response = await app.inject({
		method: "POST",
		url: "/v1/conversations",
		headers: { authorization: `Bearer ${token}` },
	});
	expect(response.statusCode).toBe(201);
	const conversation = await opened.harness.conversation(
		response.json().id as ConversationId,
		BACKGROUND_CONTEXT,
	);
	if (conversation === undefined) throw new Error("owned conversation missing");
	return conversation;
}

async function renderSection(
	opened: OpenedHarness,
	conversation: Conversation,
	key: string,
): Promise<string | undefined> {
	const section = opened.registry.snapshot().sections().find(
		(entry) => entry.section.key === key,
	)?.section;
	if (section === undefined) throw new Error(`section ${key} missing`);
	const agent = await conversation.agent(BACKGROUND_CONTEXT);
	return section.render({
		conversationId: conversation.id,
		agent,
		env: undefined,
		shown: {},
		read: opened.harness,
	}, BACKGROUND_CONTEXT);
}

function executionApi(
	opened: OpenedHarness,
	conversation: Conversation,
): ToolExecutionApi {
	return {
		conversationId: conversation.id,
		snapshot: opened.harness.snapshot.bind(opened.harness),
		agent: () => conversation.agent(BACKGROUND_CONTEXT),
	} as unknown as ToolExecutionApi;
}

// ---------------------------------------------------------------------------
// Default boot
// ---------------------------------------------------------------------------

describe("default boot", () => {
	test("loads all four built-ins; /v1/extensions reports them builtin: true", { timeout: 60_000 }, async () => {
		const { app } = await bootBuiltins();
		const response = await app.inject({ method: "GET", url: "/v1/extensions" });
		expect(response.statusCode).toBe(200);
		const rows = response.json().extensions as {
			name: string;
			status: string;
			builtin?: boolean;
			replacedBy?: string;
		}[];
		const codemode = rows.find((row) => row.name === "codemode");
		const mcp = rows.find((row) => row.name === "sigrun-mcp");
		const toolSearch = rows.find((row) => row.name === "tool-search");
		const oauth = rows.find((row) => row.name === "oauth");
		expect(codemode).toMatchObject({
			status: "ok",
			builtin: true,
			version: "0.1.0",
		});
		expect(mcp).toMatchObject({
			status: "ok",
			builtin: true,
			version: "0.2.0",
		});
		expect(toolSearch).toMatchObject({
			status: "ok",
			builtin: true,
			version: "0.1.0",
		});
		expect(oauth).toMatchObject({
			status: "ok",
			builtin: true,
			version: "0.1.0",
		});
		// A non-built-in outcome carries no builtin flag (the field is
		// exactly true-or-absent).
		const others = rows.filter(
			(row) =>
				!["codemode", "sigrun-mcp", "tool-search", "gateway", "oauth"].includes(
					row.name,
				),
		);
		for (const row of others) expect(row.builtin).toBeUndefined();
	});

	test("the MCP tools surface works against the fixture server; pi parity: neither codemode nor tool_search is offered by default", { timeout: 60_000 }, async () => {
		const { app, opened, faux } = await bootBuiltins({
			mcpServers: { acme: stubServer({ exposure: "direct" }) },
		});
		// The discovered MCP tool registered under <server>/<tool>.
		await waitForTool(opened, "acme/echo");
		const names = opened.registry
			.snapshot()
			.tools()
			.map((entry) => entry.tool.name);
		expect(names).toContain("acme/echo");
		expect(names).toContain("codemode");
		expect(names).toContain("tool_search");

		// Ruling 8 (pi parity): with no defaultTools and no codemode-exposed
		// server, codemode/tool_search are NOT in the offered set. (The
		// server above is exposure "direct" — a model-offered MCP tool —
		// which engages neither auto-enable arm.)
		const offered = await offeredToolNames(app, opened);
		expect(offered).toContain("acme/echo");
		expect(offered).not.toContain("codemode");
		expect(offered).not.toContain("tool_search");

		// A REAL tools/call round-trip: the faux model calls the MCP tool
		// and the fixture server's answer lands in the tool result.
		faux.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("acme/echo", { name: "sigrun" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		const create = await app.inject({
			method: "POST",
			url: "/v1/conversations",
			payload: {},
			headers: {
				"content-type": "application/json",
				// Shared MCP tools require an identified directory user; the
				// fixture's seeded principal supplies that identity here.
				"x-sigrun-user": "tester",
			},
		});
		const { id } = create.json() as { id: number };
		const conversation = await opened.harness.conversation(
			id as ConversationId,
			BACKGROUND_CONTEXT,
		);
		const submission = await conversation!.submit(
			{ type: "input", content: "echo" },
			BACKGROUND_CONTEXT,
		);
		const settled = await submission.wait(BACKGROUND_CONTEXT);
		expect(settled.status).toBe("done");
		const view = (
			await app.inject({ method: "GET", url: `/v1/conversations/${id}` })
		).json();
		const transcript = JSON.stringify(view.entries);
		expect(transcript).toContain("hello, sigrun");
	});

	test("the MCP section lists the fixture server (proves the built-in installed, not just resolved)", { timeout: 60_000 }, async () => {
		const { opened } = await bootBuiltins({
			mcpServers: { acme: stubServer() },
		});
		const sections = opened.registry.snapshot().sections();
		const keys = sections.map((entry) => entry.section.key);
		expect(keys).toContain("mcp_servers");
	});
});

describe("per-user tools in built-in discovery", () => {
	test("codemode renders acme@alice's tool for alice's conversation only", async () => {
		const { app, opened } = await bootBuiltins({
			extensionSpecifiers: [USER_TOOLS_SPECIFIER],
			multiUser: true,
		});
		acmeHost(opened).tools.setUserTools("alice", [perUserProbe(false)]);
		const alice = await ownedConversation(app, opened, "alice");
		const bob = await ownedConversation(app, opened, "bob");
		expect((await alice.agent(BACKGROUND_CONTEXT)).extensions.map(
			(extension) => extension.name,
		)).toContain("acme@alice");
		const aliceSection = await renderSection(opened, alice, "codemode");
		expect(aliceSection).toContain("acme_probe");
		expect(aliceSection).not.toContain("acme@alice");
		expect((await bob.agent(BACKGROUND_CONTEXT)).extensions.map(
			(extension) => extension.name,
		)).not.toContain("acme@alice");
		expect(await renderSection(opened, bob, "codemode")).not.toContain("acme_probe");
	});

	test("tool_search finds acme@alice's deferred tool for alice's conversation only", async () => {
		const { app, opened } = await bootBuiltins({
			extensionSpecifiers: [USER_TOOLS_SPECIFIER],
			multiUser: true,
		});
		acmeHost(opened).tools.setUserTools("alice", [perUserProbe(true)]);
		const alice = await ownedConversation(app, opened, "alice");
		const bob = await ownedConversation(app, opened, "bob");
		const search = (await alice.agent(BACKGROUND_CONTEXT)).extensions
			.flatMap((extension) => extension.tools ?? [])
			.find((tool) => tool.name === "tool_search");
		if (search === undefined) throw new Error("tool_search missing");
		expect((await alice.agent(BACKGROUND_CONTEXT)).deferred.map(
			(tool) => tool.name,
		)).toContain("acme_probe");
		const result = await search.execute(
			{ query: "acme_probe" },
			executionApi(opened, alice),
			BACKGROUND_CONTEXT,
		);
		expect(result.details).toEqual({ loaded: ["acme_probe"] });
		expect((await bob.agent(BACKGROUND_CONTEXT)).deferred.map(
			(tool) => tool.name,
		)).not.toContain("acme_probe");
		const bobResult = await search.execute(
			{ query: "acme_probe" },
			executionApi(opened, bob),
			BACKGROUND_CONTEXT,
		);
		expect(bobResult.details).toEqual({ loaded: [] });
	});
});

// ---------------------------------------------------------------------------
// builtinExtensions disables
// ---------------------------------------------------------------------------

describe("builtinExtensions disables", () => {
	test("builtinExtensions: {mcp: false} → MCP absent entirely, the others present; one log line", { timeout: 60_000 }, async () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { app, opened } = await bootBuiltins({
			settings: { builtinExtensions: { mcp: false } },
			mcpServers: { acme: stubServer() },
		});
		const rows = (
			await app.inject({ method: "GET", url: "/v1/extensions" })
		).json().extensions as { name: string; builtin?: boolean }[];
		// Absent ENTIRELY (acceptance F7): no row, not even a skipped one.
		expect(rows.some((row) => row.name === "sigrun-mcp")).toBe(false);
		expect(rows.some((row) => row.name === "codemode")).toBe(true);
		expect(rows.some((row) => row.name === "tool-search")).toBe(true);
		// And no MCP tools registered.
		const names = opened.registry
			.snapshot()
			.tools()
			.map((entry) => entry.tool.name);
		expect(names).not.toContain("acme/echo");
		// One log line naming the disabled built-in.
		const lines = [...info.mock.calls, ...warn.mock.calls]
			.map((call) => String(call[0]))
			.filter((line) => line.includes("mcp"));
		expect(lines).toHaveLength(1);
	});

	test("builtinExtensions: {codemode: false, toolSearch: false} → only MCP and OAuth load", { timeout: 60_000 }, async () => {
		const { app } = await bootBuiltins({
			settings: { builtinExtensions: { codemode: false, toolSearch: false } },
		});
		const rows = (
			await app.inject({ method: "GET", url: "/v1/extensions" })
		).json().extensions as { name: string }[];
		expect(rows.some((row) => row.name === "codemode")).toBe(false);
		expect(rows.some((row) => row.name === "tool-search")).toBe(false);
		expect(rows.some((row) => row.name === "sigrun-mcp")).toBe(true);
		expect(rows.some((row) => row.name === "oauth")).toBe(true);
	});

	test("builtinExtensions: {oauth: false} → OAuth absent, one log line", { timeout: 60_000 }, async () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { app } = await bootBuiltins({
			settings: { builtinExtensions: { oauth: false } },
		});
		const rows = (
			await app.inject({ method: "GET", url: "/v1/extensions" })
		).json().extensions as { name: string }[];
		expect(rows.some((row) => row.name === "oauth")).toBe(false);
		expect(rows.some((row) => row.name === "codemode")).toBe(true);
		expect(rows.some((row) => row.name === "sigrun-mcp")).toBe(true);
		expect(rows.some((row) => row.name === "tool-search")).toBe(true);
		const lines = [...info.mock.calls, ...warn.mock.calls]
			.map((call) => String(call[0]))
			.filter((line) => line.includes("@sigrun/oauth"));
		expect(lines).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// Replacement (Review Focus 1)
// ---------------------------------------------------------------------------

describe("replacement", () => {
	test("a configured package named @sigrun/ext-mcp replaces the built-in: skipped with replacedBy, one warning naming both, configured loads", { timeout: 60_000 }, async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { app, opened } = await bootBuiltins({
			extensionSpecifiers: [REPLACES_MCP_SPECIFIER],
		});
		// The configured extension loaded (its marker tool registered).
		const names = opened.registry
			.snapshot()
			.tools()
			.map((entry) => entry.tool.name);
		expect(names).toContain("acme_replacement");
		// The built-in's row reports builtin + replacedBy, and NOT ok: the
		// built-in was skipped, not loaded.
		const rows = (
			await app.inject({ method: "GET", url: "/v1/extensions" })
		).json().extensions as {
			name: string;
			status: string;
			builtin?: boolean;
			replacedBy?: string;
		}[];
		const builtinRow = rows.find((row) => row.name === "sigrun-mcp");
		expect(builtinRow).toBeDefined();
		expect(builtinRow?.builtin).toBe(true);
		expect(builtinRow?.replacedBy).toBe(REPLACES_MCP_SPECIFIER);
		expect(builtinRow?.status).not.toBe("ok");
		// The configured extension's own row exists and is not a builtin.
		const configuredRow = rows.find(
			(row) => row.name === "acme-mcp-replacement",
		);
		expect(configuredRow).toMatchObject({ status: "ok" });
		expect(configuredRow?.builtin).toBeUndefined();
		// Exactly ONE warning naming both the built-in and the replacement.
		const warnings = warn.mock.calls
			.map((call) => String(call[0]))
			.filter((line) => line.includes("@sigrun/ext-mcp"));
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain(REPLACES_MCP_SPECIFIER);
	});

	test("a configured package named @sigrun/oauth replaces the built-in OAuth row", { timeout: 60_000 }, async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { app, opened } = await bootBuiltins({
			extensionSpecifiers: [REPLACES_OAUTH_SPECIFIER],
		});
		const names = opened.registry
			.snapshot()
			.tools()
			.map((entry) => entry.tool.name);
		expect(names).toContain("acme_oauth_replacement");
		const rows = (
			await app.inject({ method: "GET", url: "/v1/extensions" })
		).json().extensions as {
			name: string;
			status: string;
			builtin?: boolean;
			replacedBy?: string;
		}[];
		expect(rows.find((row) => row.name === "oauth")).toMatchObject({
			status: "replaced",
			builtin: true,
			replacedBy: REPLACES_OAUTH_SPECIFIER,
		});
		expect(rows.find((row) => row.name === "acme-oauth-replacement")).toMatchObject({
			status: "ok",
		});
		expect(rows.find((row) => row.name === "acme-oauth-replacement")?.builtin).toBeUndefined();
		const warnings = warn.mock.calls
			.map((call) => String(call[0]))
			.filter((line) => line.includes("@sigrun/oauth"));
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain(REPLACES_OAUTH_SPECIFIER);
	});

	test("an unrelated configured extension replaces nothing", { timeout: 60_000 }, async () => {
		const { app } = await bootBuiltins({
			extensionSpecifiers: [THROWING_SPECIFIER.replace("fixture-throwing", "fixture-gate")],
		});
		const rows = (
			await app.inject({ method: "GET", url: "/v1/extensions" })
		).json().extensions as { name: string; builtin?: boolean }[];
		expect(rows.find((row) => row.name === "sigrun-mcp")).toMatchObject({
			builtin: true,
			status: "ok",
		});
	});
});

// ---------------------------------------------------------------------------
// Quarantine (Ruling 7)
// ---------------------------------------------------------------------------

describe("quarantine", () => {
	test("an unresolvable @sigrun/oauth is quarantined and boot continues", { timeout: 60_000 }, async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const { app } = await bootBuiltins({
			settings: {
				builtinExtensions: { codemode: false, mcp: false, toolSearch: false },
			},
			unresolvableOAuth: true,
		});
		const rows = (
			await app.inject({ method: "GET", url: "/v1/extensions" })
		).json().extensions as {
			name: string;
			status: string;
			error?: string;
			builtin?: boolean;
		}[];
		const oauth = rows.find((row) => row.status === "quarantined" && row.builtin === true);
		expect(oauth, JSON.stringify(rows)).toBeDefined();
		expect(oauth?.name).toContain("@sigrun/oauth");
		expect(oauth?.error).toContain("Cannot find module");
		expect(rows.some((row) => row.name === "oauth" && row.status === "ok")).toBe(false);
	});

	test("a built-in that throws while loading is quarantined exactly like a configured extension; boot continues", { timeout: 60_000 }, async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const { app } = await bootBuiltins({
			settings: {
				builtinExtensions: {
					codemode: false,
					mcp: false,
					toolSearch: false,
					oauth: false,
				},
			},
			extraBuiltins: [THROWING_SPECIFIER],
		});
		const rows = (
			await app.inject({ method: "GET", url: "/v1/extensions" })
		).json().extensions as {
			name: string;
			status: string;
			error?: string;
			builtin?: boolean;
		}[];
		const thrown = rows.find(
			(row) => row.status === "quarantined" && row.builtin === true,
		);
		expect(thrown).toBeDefined();
		expect(thrown?.error).toContain("deliberately failing factory");
		// Boot continued: the server answers (this very response proves it).
	});
});

// ---------------------------------------------------------------------------
// Auto-enable (Ruling 4 / Ruling 8)
// ---------------------------------------------------------------------------

describe("auto-enable", () => {
	test("a codemode-exposed MCP server (the default) offers codemode to new conversations; tool_search stays off", { timeout: 60_000 }, async () => {
		const { app, opened } = await bootBuiltins({
			mcpServers: { acme: stubServer() }, // no exposure → server default "codemode"
		});
		const offered = await offeredToolNames(app, opened);
		expect(offered).toContain("codemode");
		expect(offered).not.toContain("tool_search");
		// The offered set rides the stored `modelTools` `{remove}` edit, so
		// the doc carries that shape (never a frozen array snapshot —
		// tool_search's control.addTools must merge into the full default).
		const doc = await storedAgentDoc(app);
		expect(doc.modelTools).toEqual({ remove: ["tool_search"] });
	});

	test("a deferred-exposed server adds tool_search (and not codemode)", { timeout: 60_000 }, async () => {
		const { app, opened } = await bootBuiltins({
			mcpServers: { acme: stubServer({ exposure: "deferred" }) },
		});
		const offered = await offeredToolNames(app, opened);
		expect(offered).toContain("tool_search");
		expect(offered).not.toContain("codemode");
		// The deferred MCP tool itself is NOT offered until searched.
		expect(offered).not.toContain("acme/echo");
	});

	test("pi's codemode-deferred alias normalizes to codemode", { timeout: 60_000 }, async () => {
		const { app, opened } = await bootBuiltins({
			mcpServers: { acme: stubServer({ exposure: "codemode-deferred" }) },
		});
		const offered = await offeredToolNames(app, opened);
		expect(offered).toContain("codemode");
	});

	test("autoEnableCodemode: false turns both arms off", { timeout: 60_000 }, async () => {
		const { app, opened } = await bootBuiltins({
			mcpServers: {
				acme: stubServer(),
				beta: stubServer({ exposure: "deferred" }),
			},
			settings: { autoEnableCodemode: false },
		});
		const offered = await offeredToolNames(app, opened);
		expect(offered).not.toContain("codemode");
		expect(offered).not.toContain("tool_search");
	});

	test("an explicit defaultTools filter wins (auto-enable only adds to the DEFAULT set)", { timeout: 60_000 }, async () => {
		const { app, opened } = await bootBuiltins({
			mcpServers: { acme: stubServer() },
			settings: { defaultTools: ["read"] },
		});
		const offered = await offeredToolNames(app, opened);
		expect(offered).toEqual(["read"]);
	});

	test("no MCP servers → neither tool auto-added (Ruling 8)", { timeout: 60_000 }, async () => {
		const { app, opened } = await bootBuiltins({
			mcpServers: {},
		});
		const offered = await offeredToolNames(app, opened);
		expect(offered).not.toContain("codemode");
		expect(offered).not.toContain("tool_search");
	});

	test("a disabled server engages neither arm", { timeout: 60_000 }, async () => {
		const { app, opened } = await bootBuiltins({
			mcpServers: { acme: stubServer({ disabled: true }) },
		});
		const offered = await offeredToolNames(app, opened);
		expect(offered).not.toContain("codemode");
		expect(offered).not.toContain("tool_search");
	});
});

// ---------------------------------------------------------------------------
// Gateway (gateway C3: the fourth built-in)
// ---------------------------------------------------------------------------

/** The loopback channel fixture (id "loop"; the inert-marker probe). */
const LOOPBACK_SPECIFIER = pathToFileURL(
	join(
		import.meta.dirname,
		"fixtures",
		"fixture-loopback-channel",
		"index.js",
	),
).href;

describe("gateway built-in (C3)", () => {
	test("the gateway built-in loads by default; /v1/extensions reports it builtin: true", { timeout: 60_000 }, async () => {
		const { app } = await bootBuiltins();
		const response = await app.inject({ method: "GET", url: "/v1/extensions" });
		expect(response.statusCode).toBe(200);
		const rows = response.json().extensions as {
			name: string;
			status: string;
			builtin?: boolean;
		}[];
		const gateway = rows.find((row) => row.name === "gateway");
		expect(gateway).toMatchObject({
			status: "ok",
			builtin: true,
			version: "0.1.0",
		});
	});

	test("builtinExtensions: {gateway: false} removes the gateway row and makes the loopback row inert: \"no gateway\"", { timeout: 60_000 }, async () => {
		const { app } = await bootBuiltins({
			settings: { builtinExtensions: { gateway: false } },
			extensionSpecifiers: [LOOPBACK_SPECIFIER],
		});
		const rows = (
			await app.inject({ method: "GET", url: "/v1/extensions" })
		).json().extensions as {
			name: string;
			status: string;
			builtin?: boolean;
			inert?: string;
		}[];
		// Disabled: absent ENTIRELY (ruling 6, the other keys' rule).
		expect(rows.some((row) => row.name === "gateway")).toBe(false);
		// The loopback adapter row is inert: no engine loaded, so its
		// adapters never start (plan 1's marker).
		const loopRow = rows.find(
			(row) => row.name === "fixture-loopback-channel",
		);
		expect(loopRow).toMatchObject({ status: "ok" });
		expect(loopRow?.inert).toBe("no gateway");
	});

	test("settings validation accepts gateway: false and rejects gateway: \"no\"", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-builtin-gw-"));
		cleanups.push(() => rm(dir, { recursive: true, force: true }));
		const store = new SettingsStore({ dir });
		// Accepts the boolean (and persists/reads back).
		const accepted = store.update({ builtinExtensions: { gateway: false } });
		expect(accepted.builtinExtensions).toEqual({ gateway: false });
		// Rejects a non-boolean naming the field.
		const file = settingsPath(dir);
		await writeFile(
			file,
			'{"builtinExtensions": {"gateway": "no"}}',
			"utf8",
		);
		let rejected: unknown;
		try {
			store.read();
		} catch (error) {
			rejected = error;
		}
		expect(rejected).toBeInstanceOf(SettingsValidationError);
		expect(String(rejected)).toMatch(/builtinExtensions\.gateway/);
	});
});
