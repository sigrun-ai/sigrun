/**
 * Task 5: degenerate MemoryBackend (observe / recall / section).
 *
 * The memory extension observes every completed generation — one record for
 * the user input and one for the assistant answer — through the generation
 * `afterResponse` hook, and recalls by scanning `conversation.entries()` (the
 * durable transcript), NOT the observe buffer: recall must work for history
 * the live window has compacted away. The section is a stable placeholder
 * until spec B replaces the backend.
 *
 * All generation runs against a faux provider (no network), and the harness
 * env is scrubbed (`env: {}`) so no ambient credential can leak in.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import {
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import {
	createMemory,
	DegenerateMemoryBackend,
	MEMORY_PLACEHOLDER,
	type MemoryWiring,
} from "../src/extensions/memory/degenerate.js";
import type { HarnessSettings } from "@earendil-works/pi-durable";

type CompactionSettings = NonNullable<HarnessSettings["compaction"]>;
type RetrySettings = NonNullable<HarnessSettings["retry"]>;

/**
 * Open a hermetic harness whose root conversation answers through a faux
 * provider, with the memory extension installed. `compaction` forces
 * pi-durable's threshold-compaction thresholds (the compacted-recall test);
 * `retry` lowers retry delays (the retry-path test); the defaults leave
 * pi-durable's policies untouched.
 */
async function openMemoryHarness(
	dir: string,
	compaction?: CompactionSettings,
	retry?: RetrySettings,
) {
	const config = loadConfig({
		SIGRUN_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
	});
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	faux.setResponses([fauxAssistantMessage("faux answer one")]);
	const memory = createMemory();
	const settings: HarnessSettings = {
		...(compaction === undefined ? {} : { compaction }),
		...(retry === undefined ? {} : { retry }),
	};
	const opened = await openHarness(config, {
		extensions: [
			{
				name: "sigrun.test-faux",
				providers: [
					{
						provider: faux.provider,
						defaultModel: { provider: "faux", modelId: "m" },
					},
				],
			},
		],
		env: {},
		...(Object.keys(settings).length === 0 ? {} : { settings }),
	});
	// The memory extension is sigrun-owned, not boot-owned: install it into the
	// opened registry (hooks resolve against the live registry snapshot).
	opened.registry.install(memory.extension);
	return { opened, memory, faux };
}

/** Submit one user input through the memory wiring and wait for `done`. */
async function ask(
	opened: OpenedHarness,
	memory: MemoryWiring,
	text: string,
	context: Context,
) {
	const root = await opened.harness.root(context, {
		agent: { model: opened.defaultModel },
	});
	const submission = await memory.submit(
		root,
		{ type: "input", content: text },
		context,
	);
	await submission.wait(context);
	return { root, submission };
}

test("one turn observes both roles and registers the extension surfaces", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-memory-"));
	try {
		const { opened, memory } = await openMemoryHarness(dir);
		try {
			await ask(opened, memory, "hello from the user", BACKGROUND_CONTEXT);

			// Two records: the user input then the assistant answer, keyed to the
			// same conversation and generation (the generation task id).
			const records = memory.backend.records();
			expect(records).toHaveLength(2);
			const [user, assistant] = records;
			expect(user?.role).toBe("user");
			expect(user?.text).toBe("hello from the user");
			expect(assistant?.role).toBe("assistant");
			expect(assistant?.text).toContain("faux answer one");
			expect(user?.conversationId).toBe(assistant?.conversationId);
			expect(user?.generationId).toBe(assistant?.generationId);

			// The extension registered the recall tool and the placeholder section.
			const snapshot = opened.registry.snapshot();
			expect(snapshot.tools().map((entry) => entry.tool.name)).toContain(
				"memory_recall",
			);
			expect(snapshot.sections().map((entry) => entry.section.key)).toContain(
				"long-term-memory",
			);
		} finally {
			await opened.harness.close(BACKGROUND_CONTEXT);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("recall reaches an entry the live window compacted away", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-memory-"));
	try {
		// Forced thresholds: the blocking threshold is
		// `contextWindow - reserveTokens` = 400 tokens, so turn two's transcript
		// (two ~300-token user messages plus the answer) overflows it while turn
		// one's does not, and `keepRecentTokens: 1` cuts everything before the
		// newest user message. `backgroundTokens: 0` keeps compaction blocking-
		// only so the faux response queue stays deterministic.
		const { opened, memory, faux } = await openMemoryHarness(dir, {
			reserveTokens: 127_600,
			keepRecentTokens: 1,
			backgroundTokens: 0,
		});
		try {
			const secret = "the secret passphrase is sigrun-memorable";
			const longUser1 = `${secret}. ${"filler ".repeat(180)}`;
			const { root } = await ask(opened, memory, longUser1, BACKGROUND_CONTEXT);

			// Turn two: the compaction summary consumes one faux response, the
			// generation's answer the next.
			faux.appendResponses([
				fauxAssistantMessage("compacted history summary"),
				fauxAssistantMessage("faux answer two"),
			]);
			const second = await memory.submit(
				root,
				{ type: "input", content: `second question ${"context ".repeat(160)}` },
				BACKGROUND_CONTEXT,
			);
			const settled = await second.wait(BACKGROUND_CONTEXT);
			expect(settled.status).toBe("done");

			// The live context no longer contains the first user message: the
			// threshold compaction cut it. (This also proves the compaction ran —
			// without it the recall assertion below would pass vacuously.)
			const view = await root.context(BACKGROUND_CONTEXT);
			const liveUserText = view.messages
				.filter((message) => message.role === "user")
				.map((message) =>
					typeof message.content === "string"
						? message.content
						: message.content
								.map((block) => (block.type === "text" ? block.text : ""))
								.join(""),
				)
				.join("\n");
			expect(liveUserText).not.toContain("sigrun-memorable");

			// Recall reads the durable transcript and still finds the compacted-out
			// entry — the App C `entries()`-reachability verification. A *fresh*
			// backend (bound to the same conversation, nothing observed yet) makes
			// the read independent of the in-process observe buffer: only
			// `conversation.entries()` can hold the history.
			const fresh = new DegenerateMemoryBackend();
			fresh.bindRecallSource(root);
			const hits = await fresh.recall("sigrun-memorable");
			expect(hits.length).toBeGreaterThanOrEqual(1);
			expect(hits.some((hit) => hit.text.includes("sigrun-memorable"))).toBe(
				true,
			);
		} finally {
			await opened.harness.close(BACKGROUND_CONTEXT);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("section() returns the stable placeholder and the section renders it", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-memory-"));
	try {
		const { opened, memory } = await openMemoryHarness(dir);
		try {
			expect(memory.backend.section()).toBe(MEMORY_PLACEHOLDER);
			const found = opened.registry
				.snapshot()
				.sections()
				.find((entry) => entry.section.key === "long-term-memory");
			expect(found).toBeDefined();
			// The degenerate section ignores its input; the minimal PromptInput
			// keeps this test independent of the other render fields.
			expect(
				await found?.section.render(
					{
						conversationId: 1 as never,
						agent: null as never,
						env: undefined,
						shown: {},
						read: null as never,
					},
					BACKGROUND_CONTEXT,
				),
			).toBe(MEMORY_PLACEHOLDER);
		} finally {
			await opened.harness.close(BACKGROUND_CONTEXT);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// Review Finding 1: observe only the ANSWER round, not error/retry rounds.
test("a retryable error round observes nothing; the retried turn records the final answer once", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-memory-"));
	try {
		const { opened, memory, faux } = await openMemoryHarness(dir, undefined, {
			enabled: true,
			maxRetries: 3,
			baseDelayMs: 1,
			maxAgentDelayMs: 5,
		});
		try {
			// First attempt: a retryable provider error; second: the real answer.
			faux.setResponses([
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "provider 500 temporarily overloaded",
				}),
				fauxAssistantMessage("recovered answer"),
			]);
			const { submission } = await ask(
				opened,
				memory,
				"retry me",
				BACKGROUND_CONTEXT,
			);
			const settled = await submission.wait(BACKGROUND_CONTEXT);
			expect(settled.status).toBe("done");

			// Exactly two records: one user, one final answer. The error round
			// observed nothing (no error-text assistant record, and the final
			// answer is not dropped by a first-fire memo).
			const records = memory.backend.records();
			expect(records).toHaveLength(2);
			expect(records[0]?.role).toBe("user");
			expect(records[0]?.text).toBe("retry me");
			expect(records[1]?.role).toBe("assistant");
			expect(records[1]?.text).toBe("recovered answer");
		} finally {
			await opened.harness.close(BACKGROUND_CONTEXT);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a model-failed run leaves no orphan user record", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-memory-"));
	try {
		const { opened, memory, faux } = await openMemoryHarness(dir, undefined, {
			enabled: true,
			maxRetries: 1,
			baseDelayMs: 1,
			maxAgentDelayMs: 5,
		});
		try {
			// Every attempt fails; the run settles unanswered (model_error).
			faux.setResponses([
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "provider 500 temporarily overloaded",
				}),
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "provider 500 temporarily overloaded",
				}),
			]);
			const { submission } = await ask(
				opened,
				memory,
				"doomed input",
				BACKGROUND_CONTEXT,
			);
			const settled = await submission.wait(BACKGROUND_CONTEXT);
			expect(settled.status).not.toBe("done");

			// No answer round fired, so nothing is observed — most importantly no
			// orphaned half of the turn the run never answered.
			expect(memory.backend.records()).toHaveLength(0);
		} finally {
			await opened.harness.close(BACKGROUND_CONTEXT);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
