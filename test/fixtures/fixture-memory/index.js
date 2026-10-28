/**
 * Test-fixture extension package: the memory-surface stand-in for the real
 * `@sigrun/memory-markdown` package — the repo no longer pins a git
 * dependency, so this fixture mirrors its CURRENT contract and the
 * degenerate-memory semantics the sigrun tests exercise: the loader-install
 * name (`sigrun-memory`), the `memory_recall` tool, and the
 * `long-term-memory` section.
 *
 * CURRENT CONTRACT (memory-seam port, M4): capture rides the host's
 * `runSettled` seam event — the factory result carries NO `submit`
 * pass-through (the retired `{extension, submit}` shape lives ONLY in
 * fixture-legacy-submit, the loader retirement pin's dedicated vehicle).
 * Recall is PER-CONVERSATION: each `runSettled` delivery records that
 * conversation's transcript reader (keyed by the event's conversationId),
 * and the recall tool reads the CALLING conversation via the separate
 * `ToolExecutionApi.conversationId` — there is NO module-global recall
 * source and NO retired "No conversation bound" behavior. A conversation
 * that never settled has no source and answers "No matches found.", never
 * another conversation's history.
 *
 * Test observability: the fixture records, module-side, (a) every settled
 * event's `conversationId` and (b) every recall tool call's
 * `ToolExecutionApi.conversationId` — two INDEPENDENT records the
 * integration test cross-checks (MemoryEventApi intentionally carries no
 * conversation id, so only the event and the tool api carry the two ids).
 * The test imports this module by the same file:// URL the loader imports,
 * so both see ONE module instance.
 *
 * Plain JavaScript so `import(specifier)` resolves it directly — the same
 * dynamic-import path the loader uses for installed packages.
 *
 * Mirrors: @sigrun/memory-markdown src/degenerate.ts (current, post-seam).
 */

import {
	AssistantEntry,
	defineExtension,
	defineTool,
	GenerationTask,
	hook,
	section,
	UserEntry,
} from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";

/** The stable placeholder text (mirrors the real package byte-for-byte). */
export const MEMORY_PLACEHOLDER = "long-term memory backend not configured";

/**
 * Settled-event conversation ids, in delivery order (independent record A).
 * @type {number[]}
 */
export const settledConversationIds = [];

/**
 * Recall-tool `ToolExecutionApi.conversationId`s, in call order
 * (independent record B — populated by a DIFFERENT code path than record A:
 * the tool api, not the event).
 * @type {number[]}
 */
export const recallToolConversationIds = [];

/** Clear both records (tests own their fixtures' state). */
export function resetMemoryFixture() {
	settledConversationIds.length = 0;
	recallToolConversationIds.length = 0;
}

/** Plain text of one content value (`string | block[]`). */
function contentText(content) {
	if (typeof content === "string") return content;
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("");
}

/** Plain text across an entry's model messages (user + assistant). */
function entryText(entry) {
	return (entry.model ?? [])
		.map((message) => {
			if (message.role === "user") return contentText(message.content);
			if (message.role === "assistant") {
				return message.content
					.filter((block) => block.type === "text")
					.map((block) => (block.type === "text" ? block.text : ""))
					.join("");
			}
			return "";
		})
		.filter((text) => text !== "")
		.join("\n");
}

/**
 * Default export: factory returning the memory extension plus the
 * `runSettled` seam handler. Per-conversation recall sources are held in
 * the factory closure (one backend per loaded extension, mirroring the
 * real package's `#sources` map).
 */
export default function createFixtureMemory() {
	/** Per-conversation transcript readers: id → the event's entries surface. */
	const sources = new Map();

	const recallTool = defineTool({
		name: "memory_recall",
		description:
			"Search this conversation's durable transcript for messages containing the query.",
		parameters: Type.Object({
			query: Type.String({ description: "Text to search for." }),
		}),
		async execute(args, api, context) {
			// Independent record B: the tool api's OWN conversation id.
			recallToolConversationIds.push(api.conversationId);
			// Per-conversation recall: the CALLING conversation's transcript
			// only. No source yet (never settled) → no matches, never another
			// conversation's history.
			const source = sources.get(api.conversationId);
			if (source === undefined) {
				return { output: [{ type: "text", text: "No matches found." }] };
			}
			// Mirrors the real degenerate recall: newest-first transcript scan.
			const needle = args.query.toLowerCase();
			const hits = [];
			let cursor = undefined;
			let scanned = 0;
			for (;;) {
				const page = await source.entries({}, 100, cursor, context);
				for (const entry of page.items) {
					scanned++;
					const role = UserEntry.is(entry)
						? "user"
						: AssistantEntry.is(entry)
							? "assistant"
							: undefined;
					if (role === undefined || entry.id === undefined) continue;
					const text = entryText(entry);
					if (text.toLowerCase().includes(needle)) {
						hits.push({ role, entryId: entry.id, text });
						if (hits.length >= 20) break;
					}
				}
				if (hits.length >= 20 || scanned >= 10_000) break;
				cursor = page.next;
				if (cursor === undefined) break;
			}
			if (hits.length === 0) {
				return { output: [{ type: "text", text: "No matches found." }] };
			}
			const body = hits
				.map((hit) => `[${hit.role}] ${hit.text} (entry ${hit.entryId})`)
				.join("\n");
			return { output: [{ type: "text", text: body }] };
		},
	});

	const extension = defineExtension({
		name: "sigrun-memory",
		tools: [recallTool],
		sections: [section("long-term-memory", () => MEMORY_PLACEHOLDER)],
		hooks: [
			hook(GenerationTask, {
				// The observe side effect is irrelevant to the sigrun tests; the
				// hook exists to mirror the real package's shape (a hook-bearing
				// factory-result extension loads through the same path).
				async afterResponse(_message, _api, _context) {
					/* fixture: no-op observe */
				},
			}),
		],
	});

	return {
		extension,
		runSettled(event, api, _context) {
			// Independent record A: the SETTLED EVENT's conversation id.
			settledConversationIds.push(event.conversationId);
			// Bind THIS conversation's transcript reader (the event's entries
			// surface) — never a module-global latest-wins source.
			sources.set(event.conversationId, { entries: api.entries });
		},
	};
}
