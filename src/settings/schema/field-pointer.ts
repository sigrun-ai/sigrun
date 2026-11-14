/**
 * Map a schema validator's JSON pointer onto the generated form's field.
 *
 * Nested objects use dotted form-field names, so the longest matching
 * prefix wins; table-row and item segments after it remain the row path.
 */
export function fieldForPointer(
	pointer: string,
	fields: readonly { name: string; label: string }[],
): { name: string; label: string; rest: readonly string[] } | undefined {
	const segments = pointer.split("/").filter(Boolean);
	for (let end = segments.length; end > 0; end -= 1) {
		const name = segments.slice(0, end).join(".");
		const field = fields.find((candidate) => candidate.name === name);
		if (field !== undefined) {
			return { ...field, rest: segments.slice(end) };
		}
	}
	return undefined;
}
