import type { DiffBlock } from "@sigrun/shared/blocks";
import { lineDiff } from "@sigrun/shared/diff";
import type { TuiTheme } from "../theme.js";

/** The shape the diff primitive carries. */
export interface InteractionDiff {
	before: string;
	after: string;
	path?: string;
}

/** Render a diff as `[diff] path` plus line operations and collapse markers. */
export function diffLines(diff: InteractionDiff, theme: TuiTheme): string[] {
	const lines: string[] = [
		diff.path === undefined ? "[diff]" : `[diff] ${diff.path}`,
	];
	for (const line of lineDiff(diff.before, diff.after)) {
		if (line.op === "skip") {
			lines.push(theme.dim(`… ${line.count} unchanged lines`));
		} else if (line.op === "del") {
			lines.push(theme.fg("bad")(`- ${line.text}`));
		} else if (line.op === "add") {
			lines.push(theme.fg("ok")(`+ ${line.text}`));
		} else {
			lines.push(`  ${line.text}`);
		}
	}
	return lines;
}

/** The `diff` block's diff (same wire fields). */
export function blockDiff(block: DiffBlock): InteractionDiff {
	return { before: block.before, after: block.after, path: block.path };
}
