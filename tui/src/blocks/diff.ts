/**
 * The interaction diff renderer, extracted (UI-blocks U2 Task 1): the
 * prompt strip's before/after lines — `[diff] path` then `- `/`+ `
 * prefixed lines — reused VERBATIM by the `diff` block so chat diffs
 * and interaction diffs render identically.
 *
 * The extraction is byte-identical to the lines
 * `InteractionPrompter.render` produced inline (tui/src/ui/interactions.ts);
 * that component now calls {@link diffLines}.
 */

import type { DiffBlock } from "@sigrun/shared/blocks";

/** The shape the interaction seam's diff primitive carries. */
export interface InteractionDiff {
	before: string;
	after: string;
	path?: string;
}

/** Render a diff as `[diff] path` plus `- `/`+ ` lines. */
export function diffLines(diff: InteractionDiff): string[] {
	const lines: string[] = [
		diff.path === undefined ? "[diff]" : `[diff] ${diff.path}`,
	];
	for (const line of diff.before.split("\n")) lines.push(`- ${line}`);
	for (const line of diff.after.split("\n")) lines.push(`+ ${line}`);
	return lines;
}

/** The `diff` block's diff (same wire fields). */
export function blockDiff(block: DiffBlock): InteractionDiff {
	return { before: block.before, after: block.after, path: block.path };
}
