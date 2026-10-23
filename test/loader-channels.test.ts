/**
 * Gateway C1: the loader's channel-contribution pathway.
 *
 * A channel adapter's factory result may carry a `channels` array
 * (`ChannelContribution[]`, spec §7); the loader validates it fail-loud
 * (a malformed entry quarantines, exactly like a malformed notifier), and
 * a channel-id COLLISION across extensions quarantines the later loader
 * (deliberately unlike the last-registered-wins rule for commands and
 * bundles — chat bindings are keyed by channel id, so a shadowing adapter
 * would inherit another adapter's chats). A result carrying `channels`
 * with NO `extension` is a valid contributor-only form (identified by its
 * `name` field, like `providers`).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import { resolveExtension } from "../src/harness/loader.js";
import { createServer } from "../src/server/index.js";
import { seededIdentity } from "./helpers/identity.js";

/** The contributor-only fixture: `name` + `channels` (id "loop"), NO extension. */
const ADAPTER_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-channel-adapter", "index.js"),
).href;

/** The twin fixture: declares the SAME channel id "loop" (any valid shape). */
const TWIN_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-channel-twin", "index.js"),
).href;

/** The malformed fixture: a channel whose `send` is a string. */
const BAD_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-channel-bad", "index.js"),
).href;

function configWith(dir: string) {
	return loadConfig({
		SIGRUN_MODEL: "openai/gpt-4o",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
	});
}

/** Boot the harness with the fixture specifiers; close + clean up after. */
async function withOpenedHarness(
	specifiers: readonly string[],
	run: (opened: OpenedHarness) => Promise<void>,
): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-loader-channels-"));
	let opened: OpenedHarness | undefined;
	try {
		opened = await openHarness(configWith(dir), {
			env: {},
			// Hermetic: this suite pins the channel pathway's outcomes for
			// its FIXTURE specifiers, not the built-in surface (builtins:
			// false = the pre-built-ins boot shape).
			builtins: false,
			extensionSpecifiers: specifiers,
		});
		await run(opened);
	} finally {
		await opened?.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	}
}

test("a contributor-only channels result loads and binds under its slug", async () => {
	await withOpenedHarness([ADAPTER_SPECIFIER], async (opened) => {
		expect(opened.extensionOutcomes).toEqual([
			{ name: "fixture-channel-adapter", status: "ok", channels: ["loop"] },
		]);
		// Contributor-only: nothing pi-durable behind it.
		expect(
			opened.registry.snapshot().extension("fixture-channel-adapter"),
		).toBeUndefined();
		// The binding is slug-attributed and carries the contributions.
		expect(opened.channelBindings).toHaveLength(1);
		expect(opened.channelBindings[0]?.extension).toBe(
			"fixture-channel-adapter",
		);
		expect(
			opened.channelBindings[0]?.channels.map((channel) => channel.id),
		).toEqual(["loop"]);
	});
});

test("a channel-id collision quarantines the later extension, naming both", async () => {
	await withOpenedHarness([ADAPTER_SPECIFIER, TWIN_SPECIFIER], async (opened) => {
		const [first, second] = opened.extensionOutcomes;
		expect(first?.name).toBe("fixture-channel-adapter");
		expect(first?.status).toBe("ok");
		expect(second?.status).toBe("quarantined");
		expect(second?.error).toContain(
			'channel "loop" is already contributed by "fixture-channel-adapter"',
		);
		// Only the FIRST loader's contribution binds — never last-wins.
		expect(opened.channelBindings).toHaveLength(1);
		expect(opened.channelBindings[0]?.extension).toBe(
			"fixture-channel-adapter",
		);
	});
});

test("a malformed channel quarantines with an error naming the channel and the field", async () => {
	await withOpenedHarness([BAD_SPECIFIER], async (opened) => {
		expect(opened.extensionOutcomes).toHaveLength(1);
		const outcome = opened.extensionOutcomes[0];
		expect(outcome?.status).toBe("quarantined");
		expect(outcome?.error).toContain('channel "loop"');
		expect(outcome?.error).toContain("send is not a function");
	});
});

// ---------------------------------------------------------------------------
// /v1/extensions rows
// ---------------------------------------------------------------------------

describe("GET /v1/extensions channel ids", () => {
	test("a loaded adapter's row lists its contributed channel ids", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-channels-api-"));
		const configDir = join(dir, "config");
		const config = loadConfig({
			SIGRUN_DEFAULT_MODEL: "openai/gpt-test",
			SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
			SIGRUN_WORKSPACE_PATH: dir,
			SIGRUN_WEBUI: "false",
			SIGRUN_AUTH: "token",
			SIGRUN_CONFIG_DIR: configDir,
		});
		const identity = await seededIdentity(join(dir, "seed"));
		const opened = await openHarness(config, {
			identity,
			builtins: false,
			extensionSpecifiers: [ADAPTER_SPECIFIER],
			env: { SIGRUN_CONFIG_DIR: configDir },
			settingsDir: dir,
		});
		const { token } = await opened.identity.tokens.create(
			"tester-cli",
			"tester",
		);
		let app: FastifyInstance | undefined;
		try {
			app = await createServer(opened, config);
			const response = await app.inject({
				method: "GET",
				url: "/v1/extensions",
				headers: { authorization: `Bearer ${token}` },
			});
			expect(response.statusCode).toBe(200);
			const rows = response.json().extensions as unknown as {
				readonly name: string;
				readonly channels?: readonly string[];
			}[];
			const row = rows.find((entry) => entry.name === "fixture-channel-adapter");
			expect(row?.channels).toEqual(["loop"]);
		} finally {
			await app?.close();
			await opened.harness.close(BACKGROUND_CONTEXT);
			await rm(dir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// validateChannels: every rule rejects (table-driven over an in-memory
// factory, the extension-commands pattern)
// ---------------------------------------------------------------------------

/** One minimal VALID channel — each case mutates a fresh deep copy. */
function goodChannel(): Record<string, unknown> {
	return {
		id: "loop",
		label: "Loopback",
		capabilities: {
			chatTypes: ["dm"],
			maxMessageLength: 4096,
			format: "markdown",
		},
		configured: () => ({ status: "ready" }),
		start: async () => {},
		send: async () => ({ messageIds: ["m1"] }),
	};
}

/** Every validation rule: [name, mutation, message fragment]. */
const RULES: readonly (readonly [
	string,
	(channel: Record<string, unknown>) => void,
	string,
])[] = [
	["id does not match the grammar", (c) => void (c.id = "Loop"), "id"],
	["label is empty", (c) => void (c.label = ""), "label"],
	["capabilities.maxMessageLength is not positive", (c) => {
		const caps = c.capabilities as Record<string, unknown>;
		caps.maxMessageLength = 0;
	}, "maxMessageLength"],
	["capabilities.chatTypes is empty", (c) => {
		const caps = c.capabilities as Record<string, unknown>;
		caps.chatTypes = [];
	}, "chatTypes"],
	["capabilities.format is not one of the three", (c) => {
		const caps = c.capabilities as Record<string, unknown>;
		caps.format = "html";
	}, "format"],
	["configured is missing", (c) => void delete c.configured, "configured"],
	["edit is present but not a function", (c) => void (c.edit = "nope"), "edit"],
	["optional format required when capabilities.format is native", (c) => {
		const caps = c.capabilities as Record<string, unknown>;
		caps.format = "native";
	}, "format"],
];

describe("validateChannels rules", () => {
	for (const [name, mutate, fragment] of RULES) {
		test(`rejects when ${name}`, async () => {
			const channel = goodChannel();
			mutate(channel);
			await expect(
				resolveExtension({
					default: () => ({
						name: "rule-probe",
						channels: [channel],
					}),
				}),
			).rejects.toThrow(new RegExp(fragment));
		});
	}

	test("rejects duplicate channel ids within one result", async () => {
		const channel = goodChannel();
		await expect(
			resolveExtension({
				default: () => ({
					name: "rule-probe",
					channels: [channel, { ...channel }],
				}),
			}),
		).rejects.toThrow(/duplicate channel id "loop"/);
	});

	test("a channels field that is not an array rejects", async () => {
		await expect(
			resolveExtension({
				default: () => ({ name: "rule-probe", channels: "loop" }),
			}),
		).rejects.toThrow(/array/);
	});

	test("a well-formed declaration resolves with its channels retained", async () => {
		const channel = goodChannel();
		const result = await resolveExtension({
			default: () => ({ name: "good-channels", channels: [channel] }),
		});
		expect(result?.channels).toEqual([channel]);
	});
});
