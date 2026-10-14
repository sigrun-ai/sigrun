/**
 * Task 8: context-management defaults (compaction tuning).
 *
 * Sigrun surfaces pi-durable's compaction policy in config (env-overridable
 * via `SIGRUN_COMPACTION_*`, defaulting to upstream's
 * `DEFAULT_COMPACTION_POLICY`) and passes it through `openHarness` into
 * `HarnessSettings.compaction`. `backgroundTokens > 0` keeps background
 * compaction on (spec §3.1 "Background compaction on"): upstream starts a
 * background compaction `backgroundTokens` below the blocking threshold,
 * while `0` disables it.
 *
 * The E2E tests force the thresholds through config alone — the same
 * forced-compaction pattern the memory extension's tests use — proving the
 * config knob actually reaches the policy pi-durable enforces: an overflowing
 * conversation triggers compaction, a `pi.compaction` summary entry appears,
 * and the compacted prefix drops out of the live model context. Kill-mid-
 * compaction resume consistency is the Task 12 battery's job (forward-ref).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { DEFAULT_COMPACTION_POLICY } from "@earendil-works/pi-durable";
import {
	fauxAssistantMessage,
	fauxProvider,
	type FauxProviderHandle,
} from "@earendil-works/pi-ai/providers/faux";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { loadConfig } from "../src/config.js";
import { openHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";

/** The text of one message, flattening content blocks. */
function messageText(message: Pick<Message, "content">): string {
	return typeof message.content === "string"
		? message.content
		: message.content
				.map((block) => (block.type === "text" ? (block.text ?? "") : ""))
				.join("");
}

/** The text an entry contributes to model context, if any. */
function messageTextOf(entry: EntryRecord | undefined): string {
	const message = entry?.model?.[0] as
		| { content: Message["content"] }
		| undefined;
	return message === undefined ? "" : messageText(message);
}

/** A faux contributor serving one small-window model, for hermetic E2E runs. */
function fauxContributor(
	providerId: string,
	modelId: string,
	contextWindow: number,
	responses: AssistantMessage[],
): { contributor: ProviderContributor; faux: FauxProviderHandle } {
	const faux = fauxProvider({
		provider: providerId,
		models: [{ id: modelId, contextWindow }],
	});
	faux.setResponses(responses);
	return {
		contributor: {
			name: "ext-faux",
			providers: [{ provider: faux.provider }],
		},
		faux,
	};
}

// ---------------------------------------------------------------------------
// Config: defaults, overrides, validation
// ---------------------------------------------------------------------------

test("defaults match upstream DEFAULT_COMPACTION_POLICY", () => {
	// The shipped defaults must not drift from upstream's: sigrun tunes the
	// policy, it does not silently redefine it.
	const config = loadConfig({ SIGRUN_DEFAULT_MODEL: "openai/gpt-4o" });
	expect(config.compaction).toEqual(DEFAULT_COMPACTION_POLICY);
});

test("SIGRUN_COMPACTION_* env overrides apply", () => {
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "openai/gpt-4o",
		SIGRUN_COMPACTION_ENABLED: "false",
		SIGRUN_COMPACTION_RESERVE_TOKENS: "1000",
		SIGRUN_COMPACTION_KEEP_RECENT_TOKENS: "2000",
		SIGRUN_COMPACTION_BACKGROUND_TOKENS: "3000",
	});
	expect(config.compaction).toEqual({
		enabled: false,
		reserveTokens: 1000,
		keepRecentTokens: 2000,
		backgroundTokens: 3000,
	});
});

test("SIGRUN_COMPACTION_ENABLED accepts only true/false", () => {
	expect(() =>
		loadConfig({
			SIGRUN_DEFAULT_MODEL: "m",
			SIGRUN_COMPACTION_ENABLED: "yes",
		}),
	).toThrow(/SIGRUN_COMPACTION_ENABLED/);
	expect(
		loadConfig({
			SIGRUN_DEFAULT_MODEL: "m",
			SIGRUN_COMPACTION_ENABLED: "TRUE",
		}).compaction.enabled,
	).toBe(true);
});

test("SIGRUN_COMPACTION_* rejects non-positive or non-integer token counts", () => {
	for (const [key, value] of [
		["SIGRUN_COMPACTION_RESERVE_TOKENS", "0"],
		["SIGRUN_COMPACTION_RESERVE_TOKENS", "-1"],
		["SIGRUN_COMPACTION_RESERVE_TOKENS", "1.5"],
		["SIGRUN_COMPACTION_RESERVE_TOKENS", "abc"],
		["SIGRUN_COMPACTION_KEEP_RECENT_TOKENS", "0"],
		["SIGRUN_COMPACTION_KEEP_RECENT_TOKENS", "-1"],
		["SIGRUN_COMPACTION_BACKGROUND_TOKENS", "-1"],
	] as const) {
		expect(() =>
			loadConfig({ SIGRUN_DEFAULT_MODEL: "m", [key]: value }),
		).toThrow(new RegExp(key));
	}
	// backgroundTokens: 0 is the designed "background off" value, not an error.
	expect(
		loadConfig({
			SIGRUN_DEFAULT_MODEL: "m",
			SIGRUN_COMPACTION_BACKGROUND_TOKENS: "0",
		}).compaction.backgroundTokens,
	).toBe(0);
});

// ---------------------------------------------------------------------------
// E2E: the config knobs reach the policy pi-durable enforces
// ---------------------------------------------------------------------------

test("an overflowing conversation compacts and places a summary entry", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-compaction-"));
	try {
		// Forced thresholds, configured through config alone: the blocking
		// threshold is `contextWindow - reserveTokens` = 600 tokens, so turn
		// two's transcript (two long user messages plus answers) crosses it
		// while turn one's does not; `keepRecentTokens: 1` lets the cut fall
		// before the newest user message; `backgroundTokens: 0` keeps
		// compaction blocking-only so the faux response queue stays
		// deterministic (a background compaction would race the turn).
		const { contributor, faux } = fauxContributor("faux", "m", 128_000, [
			fauxAssistantMessage("first answer"),
		]);
		const config = loadConfig({
			SIGRUN_DEFAULT_MODEL: "faux/m",
			SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
			SIGRUN_COMPACTION_RESERVE_TOKENS: "127400",
			SIGRUN_COMPACTION_KEEP_RECENT_TOKENS: "1",
			SIGRUN_COMPACTION_BACKGROUND_TOKENS: "0",
		});
		const opened = await openHarness(config, {
			extensions: [contributor],
			env: {},
		});
		try {
			const root = await opened.harness.root(BACKGROUND_CONTEXT, {
				agent: { model: opened.defaultModel },
			});
			const secret = "the secret passphrase is sigrun-compactable";
			const longUser1 = `${secret}. ${"filler ".repeat(180)}`;
			const first = await root.submit(
				{ type: "input", content: longUser1 },
				BACKGROUND_CONTEXT,
			);
			expect((await first.wait(BACKGROUND_CONTEXT)).status).toBe("done");

			// Turn two: the blocking compaction consumes one faux response (the
			// summary), then the retried request consumes the answer.
			faux.appendResponses([
				fauxAssistantMessage("compacted history summary"),
				fauxAssistantMessage("second answer"),
			]);
			const second = await root.submit(
				{ type: "input", content: `second question ${"context ".repeat(160)}` },
				BACKGROUND_CONTEXT,
			);
			const settled = await second.wait(BACKGROUND_CONTEXT);
			expect(settled.status).toBe("done");

			// A pi.compaction summary entry exists and carries the summary text
			// upstream wraps (the entry's model is the wrapped user message).
			const page = await root.entries(
				{},
				100,
				undefined,
				BACKGROUND_CONTEXT,
			);
			const compactionEntry = page.items.find(
				(entry) => entry.kind === "pi.compaction",
			);
			expect(compactionEntry).toBeDefined();
			// The config-driven threshold path (blocking here), not overflow.
			expect(compactionEntry?.data).toEqual({ reason: "threshold" });
			expect(messageTextOf(compactionEntry)).toContain(
				"compacted history summary",
			);

			// The blocking compaction ran before the answer (generation held the
			// run, waited for the summary, re-prepared, then answered): the last
			// assistant message is the queued answer, not the summary text.
			const view = await root.context(BACKGROUND_CONTEXT);
			const lastAnswer = view.messages
				.filter((message) => message.role === "assistant")
				.at(-1);
			expect(messageText(lastAnswer as never)).toContain("second answer");
			// The live model context no longer contains the compacted prefix:
			// threshold compaction actually cut it.
			const liveUserText = view.messages
				.filter((message) => message.role === "user")
				.map(messageText)
				.join("\n");
			expect(liveUserText).not.toContain("sigrun-compactable");
		} finally {
			await opened.harness.close(BACKGROUND_CONTEXT);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("SIGRUN_COMPACTION_BACKGROUND_TOKENS > 0 starts a background compaction", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-compaction-"));
	try {
		// Two turns, forced thresholds: blocking = `contextWindow -
		// reserveTokens` = 700; a background compaction starts above
		// `blocking - backgroundTokens` = 300. Turn one (a short warm-up)
		// stays under 300; turn two's preparation (~550 estimated tokens)
		// lands inside the background band, so generation proceeds while a
		// conversation-owned compaction summarizes and places its summary as a
		// write submission at the next boundary — the spec §3.1 "Background
		// compaction on" path (`backgroundTokens > 0`). Turn two's answer and
		// the summary race for the faux queue, so the exact text of each is
		// not asserted — only that the summary entry exists with upstream's
		// summary wrapper.
		const { contributor } = fauxContributor("faux", "m", 128_000, [
			fauxAssistantMessage("warm-up answer"),
			fauxAssistantMessage("background summary"),
			fauxAssistantMessage("second answer"),
		]);
		const config = loadConfig({
			SIGRUN_DEFAULT_MODEL: "faux/m",
			SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
			SIGRUN_COMPACTION_RESERVE_TOKENS: "127300",
			SIGRUN_COMPACTION_KEEP_RECENT_TOKENS: "1",
			SIGRUN_COMPACTION_BACKGROUND_TOKENS: "400",
		});
		const opened = await openHarness(config, {
			extensions: [contributor],
			env: {},
		});
		try {
			const root = await opened.harness.root(BACKGROUND_CONTEXT, {
				agent: { model: opened.defaultModel },
			});
			const warmUp = await root.submit(
				{ type: "input", content: "warm up" },
				BACKGROUND_CONTEXT,
			);
			expect((await warmUp.wait(BACKGROUND_CONTEXT)).status).toBe("done");
			const second = await root.submit(
				{
					type: "input",
					content: `long question ${"filler ".repeat(200)}`,
				},
				BACKGROUND_CONTEXT,
			);
			expect((await second.wait(BACKGROUND_CONTEXT)).status).toBe("done");
			// The background compaction settles with the conversation's idle
			// scope; its write submission places the summary entry at the next
			// boundary. Poll briefly for the entry to appear after idle.
			await root.waitForIdle(BACKGROUND_CONTEXT);
			let compaction: EntryRecord | undefined;
			for (
				let attempt = 0;
				attempt < 100 && compaction === undefined;
				attempt++
			) {
				const page = await root.entries(
					{},
					100,
					undefined,
					BACKGROUND_CONTEXT,
				);
				compaction = page.items.find(
					(entry) => entry.kind === "pi.compaction",
				);
				if (compaction === undefined)
					await new Promise((resolve) => setTimeout(resolve, 10));
			}
			expect(compaction).toBeDefined();
			// The threshold path through the config knobs, and the conversation-
			// owned background placement (never the blocking generation-owned
			// one, which the blocking test covers).
			expect(compaction?.data).toEqual({ reason: "threshold" });
			// Upstream wraps every summary with this prefix; a real summary was
			// placed, not just a task marker.
			expect(messageTextOf(compaction)).toContain(
				"compacted into the following summary",
			);
		} finally {
			await opened.harness.close(BACKGROUND_CONTEXT);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("caller settings.compaction wins over config-provided policy", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-compaction-"));
	try {
		// Config forces the same overflow thresholds, but the caller's
		// settings.compaction disables compaction entirely: the overflowing
		// conversation must NOT compact (no summary entry).
		const { contributor } = fauxContributor("faux", "m", 128_000, [
			fauxAssistantMessage("first answer"),
			fauxAssistantMessage("second answer"),
		]);
		const config = loadConfig({
			SIGRUN_DEFAULT_MODEL: "faux/m",
			SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
			SIGRUN_COMPACTION_RESERVE_TOKENS: "127400",
			SIGRUN_COMPACTION_KEEP_RECENT_TOKENS: "1",
			SIGRUN_COMPACTION_BACKGROUND_TOKENS: "0",
		});
		const opened = await openHarness(config, {
			extensions: [contributor],
			env: {},
			settings: { compaction: { enabled: false } },
		});
		try {
			const root = await opened.harness.root(BACKGROUND_CONTEXT, {
				agent: { model: opened.defaultModel },
			});
			const first = await root.submit(
				{ type: "input", content: `one ${"filler ".repeat(180)}` },
				BACKGROUND_CONTEXT,
			);
			expect((await first.wait(BACKGROUND_CONTEXT)).status).toBe("done");
			const second = await root.submit(
				{ type: "input", content: `two ${"context ".repeat(160)}` },
				BACKGROUND_CONTEXT,
			);
			expect((await second.wait(BACKGROUND_CONTEXT)).status).toBe("done");

			const page = await root.entries(
				{},
				100,
				undefined,
				BACKGROUND_CONTEXT,
			);
			expect(
				page.items.some((entry) => entry.kind === "pi.compaction"),
			).toBe(false);
			// The full transcript stays live: nothing was cut.
			const view = await root.context(BACKGROUND_CONTEXT);
			expect(
				view.messages
					.filter((message) => message.role === "user")
					.map(messageText)
					.join("\n"),
			).toContain("filler");
		} finally {
			await opened.harness.close(BACKGROUND_CONTEXT);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
