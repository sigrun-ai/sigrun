/** One rendered diff row: a line operation or a collapsed unchanged run. */
export type DiffLine =
	| { readonly op: "same" | "del" | "add"; readonly text: string }
	| { readonly op: "skip"; readonly count: number };

const MAX_LCS_LINES = 5000;

function splitLines(text: string): string[] {
	return text === "" ? [] : text.split("\n");
}

function collapseSame(lines: DiffLine[], context: number): DiffLine[] {
	const out: DiffLine[] = [];
	let start = 0;
	while (start < lines.length) {
		if (lines[start]?.op !== "same") {
			out.push(lines[start]!);
			start += 1;
			continue;
		}
		let end = start + 1;
		while (end < lines.length && lines[end]?.op === "same") end += 1;
		const count = end - start;
		if (count <= 2 * context + 1) {
			out.push(...lines.slice(start, end));
		} else {
			out.push(...lines.slice(start, start + context));
			out.push({ op: "skip", count: count - 2 * context });
			out.push(...lines.slice(end - context, end));
		}
		start = end;
	}
	return out;
}

/** Diff two texts by line, collapsing long unchanged runs to `context` edges. */
export function lineDiff(
	before: string,
	after: string,
	opts?: { context?: number },
): DiffLine[] {
	const oldLines = splitLines(before);
	const newLines = splitLines(after);
	if (oldLines.length > MAX_LCS_LINES || newLines.length > MAX_LCS_LINES) {
		return [
			...oldLines.map((text): DiffLine => ({ op: "del", text })),
			...newLines.map((text): DiffLine => ({ op: "add", text })),
		];
	}

	const width = newLines.length + 1;
	const lengths = new Uint32Array((oldLines.length + 1) * width);
	for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
		for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
			lengths[oldIndex * width + newIndex] =
				oldLines[oldIndex] === newLines[newIndex]
					? lengths[(oldIndex + 1) * width + newIndex + 1]! + 1
					: Math.max(
							lengths[(oldIndex + 1) * width + newIndex]!,
							lengths[oldIndex * width + newIndex + 1]!,
						);
		}
	}

	const diff: DiffLine[] = [];
	let oldIndex = 0;
	let newIndex = 0;
	while (oldIndex < oldLines.length || newIndex < newLines.length) {
		if (
			oldIndex < oldLines.length &&
			newIndex < newLines.length &&
			oldLines[oldIndex] === newLines[newIndex]
		) {
			diff.push({ op: "same", text: oldLines[oldIndex]! });
			oldIndex += 1;
			newIndex += 1;
		} else if (
			oldIndex < oldLines.length &&
			(newIndex === newLines.length ||
				lengths[(oldIndex + 1) * width + newIndex]! >=
					lengths[oldIndex * width + newIndex + 1]!)
		) {
			diff.push({ op: "del", text: oldLines[oldIndex]! });
			oldIndex += 1;
		} else {
			diff.push({ op: "add", text: newLines[newIndex]! });
			newIndex += 1;
		}
	}
	return collapseSame(diff, opts?.context ?? 3);
}
