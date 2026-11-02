/**
 * Task A8 (curator P6 gate): `sigrun.curation-gate` — the hooks-only
 * core extension that confines an internal curator run to its allow
 * list. Its `beforeTool` blocks any tool not in `CurationRunDoc.allow`,
 * naming the allowed list; it writes nothing (a decision only). Boot
 * installs it into the registry but keeps it OUT of the host default
 * extension selection — A9's producer selects it in the run
 * conversation it creates (this test does the same by hand).
 *
 * Hermetic pattern (curation-wrap.test.ts): faux provider + tmpdir +
 * `openHarness` with `builtins: false`, the curation-target fixture via
 * `extensionEntries`, and one REAL driven run (a faux tool call) so the
 * hook fires through the built-in tool task.
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
import type { JsonObject, ConversationId } from "@earendil-works/pi-durable";
import type { ResolvedExtensionInput } from "../src/harness/loader.js";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import {
	CURATION_GATE_EXTENSION,
	createCurationGateExtension,
} from "../src/curation/gate.js";
import { CurationRunDoc } from "../src/curation/run-doc.js";
import { seededIdentity } from "./helpers/identity.js";

/** The fixture-curation-target entry (the P9 vehicle). */
const TARGET_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-curation-target", "index.js"),
).href;

/** The fixture module's exports (records + reset). */
type FixtureModule = {
	readonly writes: readonly { text: string }[];
	readonly directs: readonly { text: string }[];
	readonly resetTargetFixture: () => void;
};

/** Import the fixture module by the SAME URL the loader imported. */
async function fixtureModule(): Promise<FixtureModule> {
	return (await import(TARGET_SPECIFIER)) as unknown as FixtureModule;
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

/** Boot one hermetic harness with the curation-target fixture installed. */
async function boot(responses: readonly unknown[]): Promise<{
	opened: OpenedHarness;
	fixture: FixtureModule;
}> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-curation-gate-"));
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	faux.setResponses(responses as never);
	const contributor: ProviderContributor = {
		name: "ext-faux",
		providers: [{ provider: faux.provider }],
	};
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
	});
	// Naming off: the namer would consume the scripted faux responses.
	await writeFile(join(dir, "settings.json"), '{"namingModel": false}');
	const opened = await openHarness(config, {
		identity: await seededIdentity(dir),
		extensions: [contributor],
		builtins: false,
		env: {},
		settingsDir: dir,
		extensionEntries: [
			{
				name: "fixture-curation-target",
				entry: TARGET_SPECIFIER,
			} satisfies ResolvedExtensionInput,
		],
	});
	cleanups.push(async () => {
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	});
	const fixture = await fixtureModule();
	fixture.resetTargetFixture();
	return { opened, fixture };
}

/** One curator-run conversation: the run doc in the creating commit. */
async function runConversation(
	opened: OpenedHarness,
	run: { user: string; reviewId: string; allow: string[] },
	extensions: readonly string[],
): Promise<number> {
	const snapshot = opened.registry.snapshot();
	const selected = extensions.map((name) => {
		const extension = snapshot.extension(name);
		if (extension === undefined) throw new Error(`extension ${name} missing`);
		return extension;
	});
	const conversation = await opened.harness.createConversation(
		{
			ownership: { kind: "ownerless" },
			agent: { model: opened.defaultModel, extensions: selected },
			init: async (tx, id) => {
				const doc = await tx.doc(CurationRunDoc, id);
				doc.user = run.user;
				doc.reviewId = run.reviewId;
				doc.allow = [...run.allow];
			},
		},
		BACKGROUND_CONTEXT,
	);
	return conversation.id as number;
}

/** The concatenated text of every tool result of one tool, in call order. */
async function toolResultText(
	opened: OpenedHarness,
	id: number,
	tool: string,
): Promise<{ text: string; isError: boolean }[]> {
	const conversation = await opened.harness.conversation(
		id as ConversationId,
		BACKGROUND_CONTEXT,
	);
	if (conversation === undefined) throw new Error("conversation vanished");
	const page = await conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
	const results: { text: string; isError: boolean }[] = [];
	for (const entry of [...page.items].reverse()) {
		if (entry.kind !== "pi.tool-result") continue;
		for (const message of entry.model ?? []) {
			if (message.role !== "toolResult" || message.toolName !== tool) continue;
			const text =
				typeof message.content === "string"
					? message.content
					: message.content
							.filter((block) => block.type === "text")
							.map((block) => block.text)
							.join("");
			results.push({ text, isError: message.isError });
		}
	}
	return results;
}

// ─── The gate ──────────────────────────────────────────────────────────────

describe("the curator-run gate (curator P6)", () => {
	test("boot installs the gate but keeps it out of the default selection", { timeout: 20_000 }, async () => {
		const { opened } = await boot([fauxAssistantMessage("idle")]);
		// Installed: an exact selection can resolve it by name.
		expect(
			opened.registry.snapshot().extension(CURATION_GATE_EXTENSION)?.name,
		).toBe(CURATION_GATE_EXTENSION);
		// The factory builds the same hooks-only shape (no tools, no sections).
		const gate = createCurationGateExtension();
		expect(gate.tools).toBeUndefined();
		expect(gate.sections).toBeUndefined();
		expect(gate.hooks).toHaveLength(1);
		// NOT in the default selection: an ordinary conversation's agent
		// resolves without it (A9's producer selects it in run conversations).
		const conversation = await opened.harness.createConversation(
			{ ownership: { kind: "ownerless" }, agent: { model: opened.defaultModel } },
			BACKGROUND_CONTEXT,
		);
		const agent = await conversation.agent(BACKGROUND_CONTEXT);
		expect(
			agent.extensions.some(
				(extension) => extension.name === CURATION_GATE_EXTENSION,
			),
		).toBe(false);
		// But a conversation that selects it resolves it.
		const gated = await opened.harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: {
					model: opened.defaultModel,
					extensions: [
						opened.registry.snapshot().extension(CURATION_GATE_EXTENSION)!,
					],
				},
			},
			BACKGROUND_CONTEXT,
		);
		const gatedAgent = await gated.agent(BACKGROUND_CONTEXT);
		expect(
			gatedAgent.extensions.some(
				(extension) => extension.name === CURATION_GATE_EXTENSION,
			),
		).toBe(true);
	});

	test("in a curator run, a tool outside allow is blocked naming the allowed list", { timeout: 30_000 }, async () => {
		const { opened, fixture } = await boot([
			fauxAssistantMessage(
				[fauxToolCall("notes_write", { text: "review note" } as JsonObject)],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("review done"),
		]);
		const id = await runConversation(
			opened,
			{ user: "alice", reviewId: "review-1", allow: ["skill_manage"] },
			["fixture-curation-target", CURATION_GATE_EXTENSION],
		);
		const conversation = await opened.harness.conversation(
			id as ConversationId,
			BACKGROUND_CONTEXT,
		);
		const submission = await conversation!.submit(
			{ type: "input", content: "review the hints" },
			BACKGROUND_CONTEXT,
		);
		const settled = await submission.wait(BACKGROUND_CONTEXT);
		expect(settled.status).toBe("done");
		const results = await toolResultText(opened, id, "notes_write");
		expect(results).toHaveLength(1);
		expect(results[0]?.isError).toBe(true);
		expect(results[0]?.text).toContain(
			"notes_write is not available in this review; use one of: skill_manage",
		);
		// The original never executed — the gate is a decision, not a reroute.
		expect(fixture.writes).toEqual([]);
	});
});
