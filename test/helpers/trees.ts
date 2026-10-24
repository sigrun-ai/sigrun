/**
 * Minimal block-tree literals for the seam tests (UI-blocks U6 Task 1):
 * interaction bodies are root `form` trees (placement `interaction`) and
 * ambient bodies are one-line trees (placement `ambient`).
 *
 * Tests own their literals: these helpers build the smallest trees that
 * pass `validateTree`, so each test's seed stays readable.
 */

import { BLOCK_SET_VERSION } from "@sigrun/shared/blocks";
import type { Tree } from "@sigrun/shared/blocks";

/**
 * The minimal interaction body (spec §9.1): a root `form` holding one
 * `choice` field named `decision` (options `allow`/`deny`, tones
 * `good`/`bad` — the tone renames) plus a `longtext` named `reason`.
 * This is the fixture-gate shape Task 2 pins.
 */
export function askTree(): Tree {
	return {
		v: BLOCK_SET_VERSION,
		root: {
			type: "form",
			id: "ask",
			bind: "/values",
			mode: "submit",
			children: [
				{
					type: "choice",
					name: "decision",
					label: "Proceed?",
					options: [
						{ id: "allow", label: "Allow", tone: "good" },
						{ id: "deny", label: "Deny", tone: "bad" },
					],
				},
				{
					type: "longtext",
					name: "reason",
					label: "Reason",
				},
			],
		},
	};
}

/** The minimal one-line ambient body (spec §9.2): one `markdown`. */
export function lineTree(text: string): Tree {
	return {
		v: BLOCK_SET_VERSION,
		root: { type: "markdown", text },
	};
}
