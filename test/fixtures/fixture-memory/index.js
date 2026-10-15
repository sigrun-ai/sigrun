/**
 * Test-fixture extension package (publish prep 2.2): the memory-surface
 * stand-in for the real `sigrun-ext-memory-markdown` package — the repo no
 * longer pins the personal git+ssh package, so this fixture mirrors its
 * contract and the degenerate-memory semantics the sigrun tests exercise:
 * the loader-install name (`sigrun.memory`), the `memory_recall` tool, the
 * `long-term-memory` section, and the factory-result `submit` pass-through
 * that binds the conversation as the recall source at the submit boundary.
 *
 * LEGACY CONTRACT: the real package (sigrun-ext-memory-markdown 0.2+) retired
 * its `submit` pass-through — capture rides the host's `runSettled` seam event
 * and the recall source arrives with that delivery. This fixture KEEPS the
 * legacy `{ extension, submit }` factory shape on purpose: it pins the
 * loader's legacy submit pass-through contract (`OpenedHarness.memorySubmit`),
 * which the loader still supports for pre-seam extensions.
 *
 * Plain JavaScript so `import(specifier)` resolves it directly — the same
 * dynamic-import path the loader uses for installed packages. Contract: the
 * default export is a factory returning `{ extension, submit }` (LEGACY).
 *
 * Mirrors: sigrun-ext-memory-markdown dist/degenerate.js pre-seam (the
 * current real package captures via runSettled — do not port that here).
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
 * Default export: factory returning the memory extension + its submit
 * pass-through (the recall-source binding the §5 submissions route needs).
 */
export default function createFixtureMemory() {
	/** The conversation `recall` scans; bound at the submit boundary. */
	let recallSource;

	const recallTool = defineTool({
		name: "memory_recall",
		description:
			"Search this conversation's durable transcript for messages containing the query.",
		parameters: Type.Object({
			query: Type.String({ description: "Text to search for." }),
		}),
			async execute(args, _api, context) {
				if (recallSource === undefined) {
					return {
						content: [
							{ type: "text", text: "No conversation bound to memory recall yet." },
						],
						isError: true,
					};
				}
				// Mirrors the real degenerate recall: newest-first transcript scan.
				const needle = args.query.toLowerCase();
				const hits = [];
				let cursor = undefined;
				let scanned = 0;
				for (;;) {
					const page = await recallSource.entries(
						{},
						100,
						cursor,
						context,
					);
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
					return { content: [{ type: "text", text: "No matches found." }] };
				}
				const body = hits
					.map((hit) => `[${hit.role}] ${hit.text} (entry ${hit.entryId})`)
					.join("\n");
				return { content: [{ type: "text", text: body }] };
			},
	});

	const extension = defineExtension({
		name: "sigrun.memory",
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
		async submit(root, submission, context) {
			recallSource = root;
			return await root.submit(submission, context);
		},
	};
}