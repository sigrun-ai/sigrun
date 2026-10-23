/**
 * The shared `pi.live` narrowing (gateway plan 1, Task 1): the
 * `liveDoc`/`liveGenerationPartial`/`liveGenerationText`/
 * `liveToolSlots`/`liveCompactions`/`liveCompactionFailure` family from
 * `@sigrun/shared/live`.
 *
 * The functions moved here from the webui's private narrowing
 * (webui/src/entries/liveDoc.ts) so a gateway engine and every channel
 * share ONE implementation. The fixtures are hand-built views (the doc
 * is just `docs["pi.live"]` — no server boot needed); every case pins
 * the fail-soft contract: absent doc / unexpected shape reads as
 * idle-empty, never a throw.
 */

import { describe, expect, it } from "vitest";
import {
	liveCompactionFailure,
	liveCompactions,
	liveDoc,
	liveGenerationPartial,
	liveGenerationText,
	liveToolSlots,
} from "@sigrun/shared/live";
import type { ConversationViewBase } from "@sigrun/shared/views";

/** A minimal view carrying only the named docs (the functions read nothing else). */
function viewWith(docs: ConversationViewBase["docs"]): ConversationViewBase {
	return { conversation: { id: 1 }, entries: [], docs };
}

describe("liveGenerationText", () => {
	it("joins the partial's text blocks and skips non-text blocks", () => {
		const view = viewWith({
			"pi.live": {
				generation: {
					message: {
						content: [
							{ type: "text", text: "Hello " },
							{ type: "thinking", thinking: "x" },
							{ type: "text", text: "world" },
						],
					},
				},
			},
		});
		expect(liveGenerationText(view)).toBe("Hello world");
	});

	it("returns \"\" when the doc is absent (idle)", () => {
		expect(liveGenerationText(viewWith({}))).toBe("");
	});

	it("returns a string content as-is", () => {
		const view = viewWith({
			"pi.live": {
				generation: { message: { content: "plain" } },
			},
		});
		expect(liveGenerationText(view)).toBe("plain");
	});
});

describe("liveToolSlots", () => {
	it("returns [] when pi.live is absent", () => {
		expect(liveToolSlots(viewWith({}))).toEqual([]);
	});

	it("returns the doc's tools", () => {
		const view = viewWith({
			"pi.live": {
				tools: [
					{
						callId: "call-1",
						name: "read",
						status: "running",
						output: "so far",
					},
				],
			},
		});
		expect(liveToolSlots(view)).toEqual([
			{ callId: "call-1", name: "read", status: "running", output: "so far" },
		]);
	});
});

describe("liveCompactionFailure", () => {
	it("returns undefined for {error: \"\"}", () => {
		const view = viewWith({
			"pi.live": { compactionFailure: { error: "" } },
		});
		expect(liveCompactionFailure(view)).toBeUndefined();
	});

	it("returns the error text when one is surfaced", () => {
		const view = viewWith({
			"pi.live": { compactionFailure: { error: "summarize failed" } },
		});
		expect(liveCompactionFailure(view)).toBe("summarize failed");
	});
});

describe("liveDoc / liveGenerationPartial / liveCompactions", () => {
	it("liveDoc returns the doc when present and undefined when absent", () => {
		const doc = { run: { id: 1 } };
		const view = viewWith({ "pi.live": doc });
		expect(liveDoc(view)).toBe(doc);
		expect(liveDoc(viewWith({}))).toBeUndefined();
	});

	it("liveGenerationPartial returns undefined for a non-object message", () => {
		const view = viewWith({
			"pi.live": { generation: { message: "not-a-message" } },
		});
		expect(liveGenerationPartial(view)).toBeUndefined();
	});

	it("liveCompactions counts the doc's compaction tasks (0 when absent)", () => {
		expect(liveCompactions(viewWith({}))).toBe(0);
		const view = viewWith({
			"pi.live": { compactions: [{ id: 1 }, { id: 2 }] },
		});
		expect(liveCompactions(view)).toBe(2);
	});
});
