/**
 * System-prompt Task 4: the end-to-end patch-shape regression net.
 *
 * `planSystemEntries` is not importable from pi-durable's public surface
 * (deep paths are blocked by package exports), so this pins the
 * minimal-patch behavior through REAL conversation runs: boot the full
 * harness (Task 3 wiring — core sections first, guidance LAST), settle one
 * turn on one model, swap the stored agent model (`AgentChange.model` via
 * `configure()`), settle a second turn, then read the conversation's
 * committed `pi.system` entries and assert each swap emitted the MINIMAL
 * section patch:
 *
 * - matched→matched patches only the guidance values — no core key is
 *   re-emitted;
 * - matched→unmatched removes only the trailing guidance section(s) the
 *   previous model showed — never a remove-all/re-add-all pair (the
 *   placement invariant: guidance installed last is what makes
 *   appear/disappear a minimal patch instead of a full prompt re-emit);
 * - unmatched→matched appends only the trailing guidance section(s).
 *
 * A model swap between two families whose guidance renders IDENTICALLY
 * (the seed table's kimi and deepseek entries carry the same
 * execution text) emits no `pi.system` entry at all — the degenerate
 * minimal patch, pinned as its own test.
 *
 * Hermetic pattern (memory-seam.test.ts): faux provider + tmpdir +
 * `openHarness` — real `node:sqlite` storage, real generation task, no
 * network. The workspace carries an `AGENTS.md` and one skill so
 * `workspace-instructions` and `skills` actually RENDER (a bare workspace
 * would make "core keys absent from the patch" trivially true — with them
 * shown, a remove-all/re-add-all regression could not hide). Auto-naming
 * is disabled via the settings file: the namer completes through the same
 * faux provider and would consume the scripted responses
 * (memory-seam.test.ts's note).
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { SystemMessage } from "@earendil-works/pi-ai";
import type { Conversation, EntryRecord, ModelRef } from "@earendil-works/pi-durable";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { matchGuidance } from "../src/harness/sections/model-guidance.js";

/**
 * The fixture provider: its id carries none of the seed `MODEL_GUIDANCE`
 * match patterns, so every match decision below rides the MODEL id alone.
 */
const PROVIDER = "faux";

/** Matched: renders `execution-guidance` (the seed kimi entry). */
const KIMI = "kimi-k3";
/**
 * Matched, same guidance VALUES as kimi (the seed deepseek entry carries
 * the identical execution text): the zero-emission swap pair.
 */
const DEEPSEEK = "deepseek-v4";
/** Matched: renders `tool-guidance` (the seed qwen entry). */
const QWEN = "qwen-3.8";
/** Unmatched: renders neither guidance section. */
const UNMATCHED = "unmatched-1";

/** The core section keys that must NEVER appear in a swap patch. */
const CORE_SECTION_KEYS = [
	"identity",
	"persona",
	"workspace-instructions",
	"skills",
	"long-term-memory",
] as const;

/** The trailing guidance keys — the only keys a swap patch may touch. */
const GUIDANCE_SECTION_KEYS = ["tool-guidance", "execution-guidance"] as const;

const dirs: string[] = [];
const closes: Array<() => Promise<void>> = [];

afterAll(async () => {
	for (const close of closes.splice(0)) await close();
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

/**
 * The wrapped wire form `renderSections` emits for a rendered section
 * (`tag !== false` upstream): `<key>\\n text \\n</key>`. The text itself
 * comes from the shipped matcher — the values are
 * model-guidance.test.ts's subject; here they are only the oracle for
 * what the patch carries.
 */
function wrappedGuidance(field: "tool" | "execution", modelId: string): string {
	const text = matchGuidance({ provider: PROVIDER, modelId })?.[field];
	if (text === undefined) {
		throw new Error(`fixture model ${modelId} has no ${field} guidance`);
	}
	return `<${field}-guidance>\n${text}\n</${field}-guidance>`;
}

/** Boot one hermetic harness whose workspace renders every core section. */
async function bootSwapHarness(firstModel: string): Promise<OpenedHarness> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-prompt-patch-"));
	dirs.push(dir);
	// AGENTS.md + one skill: workspace-instructions and skills then RENDER,
	// so their absence from a swap patch is a real observation.
	await writeFile(join(dir, "AGENTS.md"), "Swap-test workspace instructions.\n");
	await mkdir(join(dir, "skills", "probe"), { recursive: true });
	await writeFile(
		join(dir, "skills", "probe", "SKILL.md"),
		"---\nname: probe\ndescription: A probe skill for patch-shape tests.\n---\nProbe body.\n",
	);
	// Auto-naming off (memory-seam.test.ts's note): the namer would consume
	// the scripted faux responses after the first settled run.
	await writeFile(join(dir, "settings.json"), '{"namingModel": false}');
	const faux = fauxProvider({
		provider: PROVIDER,
		models: [KIMI, DEEPSEEK, QWEN, UNMATCHED].map((id) => ({
			id,
			contextWindow: 128_000,
		})),
	});
	faux.setResponses([
		fauxAssistantMessage("first answer"),
		fauxAssistantMessage("second answer"),
	]);
	const contributor: ProviderContributor = {
		name: "faux-fixture",
		providers: [{ provider: faux.provider }],
	};
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: `${PROVIDER}/${firstModel}`,
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
	});
	const opened = await openHarness(config, {
		extensions: [contributor],
		env: {},
		settingsDir: dir,
	});
	closes.push(() => opened.harness.close(BACKGROUND_CONTEXT));
	return opened;
}

/** Submit one input and wait for the settled run (asserting it completed). */
async function runTurn(conversation: Conversation, content: string): Promise<void> {
	const submission = await conversation.submit(
		{ type: "input", content },
		BACKGROUND_CONTEXT,
	);
	const record = await submission.wait(BACKGROUND_CONTEXT);
	expect(record.status).toBe("done");
}

/** The conversation's committed `pi.system` messages, oldest first. */
async function committedSystemMessages(
	conversation: Conversation,
): Promise<SystemMessage[]> {
	const page = await conversation.entries(
		{ order: "ascending" },
		200,
		undefined,
		BACKGROUND_CONTEXT,
	);
	return page.items
		.filter((entry: EntryRecord) => entry.kind === "pi.system")
		.map((entry) => {
			const message = entry.model?.[0];
			if (!isSystemMessage(message)) {
				throw new Error("pi.system entry without a system message");
			}
			return message;
		});
}

function isSystemMessage(message: unknown): message is SystemMessage {
	return (
		typeof message === "object" &&
		message !== null &&
		(message as { role?: unknown }).role === "system"
	);
}

/** The sections patch of one `pi.system` message. */
function sectionsOf(message: SystemMessage): Record<string, string | null> {
	if (message.sections === undefined) {
		throw new Error("pi.system message without a sections patch");
	}
	return message.sections;
}

/**
 * The shared driver: settle a turn on `first`, swap the stored agent model
 * (`configure()` — the `AgentChange.model` field, the same change the
 * §5 endpoints write), settle a second turn, and return every committed
 * `pi.system` message. Turn 1 commits the full baseline (all rendered
 * sections); turn 2's entry (if any) is the swap patch under test.
 */
async function runModelSwap(
	firstModel: string,
	secondModel: string,
): Promise<SystemMessage[]> {
	const opened = await bootSwapHarness(firstModel);
	const conversation = await opened.harness.root(BACKGROUND_CONTEXT, {
		agent: { model: modelRef(firstModel) },
	});
	await runTurn(conversation, "first turn");
	await conversation.configure(
		{ model: modelRef(secondModel) },
		BACKGROUND_CONTEXT,
	);
	await runTurn(conversation, "second turn");
	return committedSystemMessages(conversation);
}

function modelRef(modelId: string): ModelRef {
	return { provider: PROVIDER, modelId };
}

/** Assert one patch touches guidance keys only — no core key, in any form. */
function expectOnlyGuidanceKeys(sections: Record<string, string | null>): void {
	for (const key of CORE_SECTION_KEYS) {
		expect(sections).not.toHaveProperty(key);
	}
	for (const key of Object.keys(sections)) {
		expect(GUIDANCE_SECTION_KEYS).toContain(key);
	}
}

// ─── The placement invariant ───────────────────────────────────────────────

test("matched→matched model swap patches only the guidance values", async () => {
	// kimi → qwen: both matched, different guidance fields. The swap patch
	// retires the shown execution-guidance (null) and appends the qwen
	// tool-guidance — the exact "a matched→matched swap that only changes
	// tool guidance re-emits a few lines" case the section split exists for.
	const messages = await runModelSwap(KIMI, QWEN);

	// Turn 1 committed the baseline: every core section (the workspace has
	// an AGENTS.md and a skill, so all five render) plus kimi's
	// execution-guidance, in install order — guidance last.
	expect(messages).toHaveLength(2);
	expect(Object.keys(sectionsOf(messages[0]))).toEqual([
		...CORE_SECTION_KEYS,
		"execution-guidance",
	]);

	// Turn 2 committed exactly ONE pi.system entry: the value patch, never
	// a remove-all/re-add-all pair.
	const swap = messages[1];
	expect(sectionsOf(swap)).toEqual({
		"execution-guidance": null,
		"tool-guidance": wrappedGuidance("tool", QWEN),
	});
	expectOnlyGuidanceKeys(sectionsOf(swap));
	// A pure sections patch: the tool loadout did not change, so nothing
	// rides along (planSystemEntries only attaches tool changes when the
	// declarations differ).
	expect(swap.toolsAdded).toBeUndefined();
	expect(swap.toolsRemoved).toBeUndefined();
});

test("matched→unmatched removes only the trailing guidance sections", async () => {
	// kimi → unmatched: the model stops matching, so the guidance section
	// it had shown is removed. With guidance installed LAST the removal is
	// a trailing null — no re-ordering, hence no remove-all/re-add-all
	// pair, and no core section is touched. The seed table's kimi entry
	// carries one field, so exactly one guidance key was shown; the patch
	// removes exactly that key.
	const messages = await runModelSwap(KIMI, UNMATCHED);

	// Turn 2 again committed exactly one entry (a remove-all/re-add-all
	// fallback would be TWO: every key nulled, then every key re-added).
	expect(messages).toHaveLength(2);
	expect(sectionsOf(messages[1])).toEqual({ "execution-guidance": null });
	expectOnlyGuidanceKeys(sectionsOf(messages[1]));
	expect(messages[1].toolsAdded).toBeUndefined();
	expect(messages[1].toolsRemoved).toBeUndefined();
});

test("unmatched→matched appends only the trailing guidance sections", async () => {
	// Reverse direction: the first turn renders no guidance at all (the
	// designed empty case), then kimi matches and its execution-guidance is
	// APPENDED — one trailing add, nothing else.
	const messages = await runModelSwap(UNMATCHED, KIMI);

	expect(messages).toHaveLength(2);
	// The baseline carried the five core sections and NO guidance key.
	expect(Object.keys(sectionsOf(messages[0]))).toEqual([...CORE_SECTION_KEYS]);
	const swap = sectionsOf(messages[1]);
	expect(swap).toEqual({ "execution-guidance": wrappedGuidance("execution", KIMI) });
	expectOnlyGuidanceKeys(swap);
	expect(messages[1].toolsAdded).toBeUndefined();
	expect(messages[1].toolsRemoved).toBeUndefined();
});

test("matched→matched with identical guidance values emits no pi.system entry", async () => {
	// The brief's kimi→deepseek pair, with its true shape under the seed
	// table: both entries render the same execution text (and no tool
	// text), so the desired sections are byte-identical and pi-durable
	// commits NOTHING for the second run — the degenerate minimal patch.
	// This is also the guard against spurious re-emits: an unconditional
	// re-emit on every run would show up here first.
	const messages = await runModelSwap(KIMI, DEEPSEEK);

	expect(messages).toHaveLength(1);
	// The one entry is turn 1's baseline; the second run added no entry.
	expect(Object.keys(sectionsOf(messages[0]))).toEqual([
		...CORE_SECTION_KEYS,
		"execution-guidance",
	]);
});
