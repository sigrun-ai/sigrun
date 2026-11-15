/**
 * Defensive inputs: `sigrun.tool-result-cap` — the hooks-only core
 * extension that bounds an oversized tool result's `details`.
 *
 * `details` is a separate channel from the model-visible `output`, and
 * nothing bounded it: an MCP tool that returns a whole page in
 * `{content:[{type:"text",text:"<!DOCTYPE…"}]}` stores the entire payload
 * in the entry record even when the model only ever sees a head. Entry
 * 28691 on the deployed instance was 8.1 MB for exactly this reason —
 * 7.2 KB of model-visible text beside 8.5 MB of `details` — and every
 * consumer that materializes the record paid for it.
 *
 * The cap keeps the small `details` (diffs, structured summaries, block
 * state) exactly as written and replaces an oversized one with a marker
 * object naming the size, so a UI can still render the row and see that
 * it was elided.
 *
 * Hermetic pattern (curation-gate.test.ts): faux provider + tmpdir +
 * `openHarness` with `builtins: false`, plus the fixture tool that
 * reports a large `details`.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId, JsonObject } from "@earendil-works/pi-durable";
import type { ResolvedExtensionInput } from "../src/harness/loader.js";
import { loadConfig, type Env } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import {
	TOOL_RESULT_CAP_EXTENSION,
	createToolResultCapExtension,
} from "../src/harness/tool-result-cap.js";
import { seededIdentity } from "./helpers/identity.js";

const FIXTURE_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-big-details", "index.js"),
).href;

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

/** Boot one hermetic harness with the big-details fixture tool installed. */
async function boot(env: Env = {}): Promise<OpenedHarness> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-details-cap-"));
	// The tool result the model sees is tiny; only `details` is huge.
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	faux.setResponses([
		fauxAssistantMessage(
			[fauxToolCall("big-result", { bytes: 200_000 } as JsonObject)],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("done"),
	]);
	const contributor: ProviderContributor = {
		name: "ext-faux",
		providers: [{ provider: faux.provider }],
	};
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
		...env,
	});
	await writeFile(join(dir, "settings.json"), '{"namingModel": false}');
	const opened = await openHarness(config, {
		identity: await seededIdentity(dir),
		extensions: [contributor],
		builtins: false,
		env: {},
		settingsDir: dir,
		extensionEntries: [
			{ name: "fixture-big-details", entry: FIXTURE_SPECIFIER } satisfies ResolvedExtensionInput,
		],
	});
	cleanups.push(async () => {
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	});
	return opened;
}

/**
 * One conversation that SELECTS the fixture tool, submits a turn, and
 * returns the conversation id — tools come from the selected extensions,
 * so the fixture must be on the agent like any user-installed extension.
 */
async function runFixture(opened: OpenedHarness): Promise<number> {
	const snapshot = opened.registry.snapshot();
	const extension = snapshot.extension("fixture-big-details");
	if (extension === undefined) throw new Error("fixture extension missing");
	// Hooks apply where the extension is SELECTED, so the cap rides the
	// agent alongside the fixture — exactly what boot's default selection
	// does for a real conversation.
	const cap = snapshot.extension(TOOL_RESULT_CAP_EXTENSION);
	if (cap === undefined) throw new Error("cap extension missing");
	const conversation = await opened.harness.createConversation(
		{
			ownership: { kind: "ownerless" },
			agent: { model: opened.defaultModel, extensions: [extension, cap] },
		},
		BACKGROUND_CONTEXT,
	);
	const submission = await conversation.submit(
		{ type: "input", content: "fetch it" },
		BACKGROUND_CONTEXT,
	);
	const settled = await submission.wait(BACKGROUND_CONTEXT);
	expect(settled.status).toBe("done");
	return conversation.id as number;
}

/** The stored `details` of the conversation's one tool result. */
async function toolResultDetails(
	opened: OpenedHarness,
	id: number,
): Promise<{ details: unknown; textBytes: number }> {
	const conversation = await opened.harness.conversation(
		id as ConversationId,
		BACKGROUND_CONTEXT,
	);
	if (conversation === undefined) throw new Error("conversation vanished");
	const page = await conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
	for (const entry of page.items) {
		if (entry.kind !== "pi.tool-result") continue;
		for (const message of entry.model ?? []) {
			if (message.role !== "toolResult") continue;
			const text =
				typeof message.content === "string"
					? message.content
					: message.content
							.filter((block) => block.type === "text")
							.map((block) => block.text)
							.join("");
			return { details: (message as { details?: unknown }).details, textBytes: text.length };
		}
	}
	throw new Error("no tool result entry");
}

describe("the tool-result details cap", () => {
	test("an oversized details object is replaced by a marker naming its size", { timeout: 20_000 }, async () => {
		const opened = await boot();
		const id = await runFixture(opened);
		const { details, textBytes } = await toolResultDetails(opened, id);
		// The model-visible output is untouched (the tool decided its own
		// model-facing size); only `details` was elided.
		expect(textBytes).toBeLessThan(1_000);
		const record = details as { capped?: boolean; bytes?: number; kind?: string };
		expect(record.capped).toBe(true);
		expect(record.bytes).toBeGreaterThan(200_000);
		// And the marker says what was there, so a UI can explain the elision.
		expect(record.kind).toBe("object");
	});

	test("a small details object passes through byte-identical", { timeout: 20_000 }, async () => {
		const opened = await boot({ SIGRUN_MAX_INLINE_FILE_BYTES: "999999" });
		const id = await runFixture(opened);
		const { details } = await toolResultDetails(opened, id);
		// Under the cap: the fixture's real object survives intact.
		expect((details as { capped?: boolean }).capped).toBeUndefined();
		expect((details as { payload?: string }).payload?.length).toBe(200_000);
	});

	test("the cap honors SIGRUN_MAX_INLINE_FILE_BYTES (configurable)", { timeout: 20_000 }, async () => {
		const opened = await boot({ SIGRUN_MAX_INLINE_FILE_BYTES: "500" });
		const id = await runFixture(opened);
		const { details } = await toolResultDetails(opened, id);
		expect((details as { capped?: boolean }).capped).toBe(true);
	});

	test("boot's DEFAULT selection carries the cap — no conversation opts in", { timeout: 20_000 }, async () => {
		const opened = await boot();
		// A plain root conversation (no explicit extension list): the host
		// default must already include the cap, which is the whole point of
		// a host-owned invariant rather than an optional extension.
		const conversation = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const agent = await conversation.agent(BACKGROUND_CONTEXT);
		expect(agent.extensions.map((one) => one.name)).toContain(
			TOOL_RESULT_CAP_EXTENSION,
		);
	});

	test("the extension is installed by boot and is hooks-only", () => {
		const extension = createToolResultCapExtension(50 * 1024);
		expect(extension.name).toBe(TOOL_RESULT_CAP_EXTENSION);
		expect(extension.tools).toBeUndefined();
		expect(extension.sections).toBeUndefined();
		expect(extension.hooks).toHaveLength(1);
	});
});

describe("the cap and explicit selections", () => {
	test("a caller-supplied HOST default still gets the cap appended", { timeout: 20_000 }, async () => {
		// The host default (`settings.extensions`) resolves through boot's
		// getter, which appends the cap when a caller-supplied list omits
		// it — so an operator narrowing the default selection cannot
		// accidentally unbound `details` for every conversation.
		const opened = await boot();
		const agent = await opened.harness
			.root(BACKGROUND_CONTEXT, { agent: { model: opened.defaultModel } })
			.then((conversation) => conversation.agent(BACKGROUND_CONTEXT));
		expect(agent.extensions.map((one) => one.name)).toContain(
			TOOL_RESULT_CAP_EXTENSION,
		);
	});

	test("an EXACT conversation selection stays exact (documented contract)", { timeout: 20_000 }, async () => {
		const opened = await boot();
		const fixture = opened.registry
			.snapshot()
			.extension("fixture-big-details");
		if (fixture === undefined) throw new Error("fixture extension missing");
		// An exact array is the deliberate opt-out seam; boot never widens
		// it. Named here so the boundary is explicit rather than assumed.
		const conversation = await opened.harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: { model: opened.defaultModel, extensions: [fixture] },
			},
			BACKGROUND_CONTEXT,
		);
		const agent = await conversation.agent(BACKGROUND_CONTEXT);
		expect(agent.extensions.map((one) => one.name)).toEqual([
			"fixture-big-details",
		]);
	});
});
