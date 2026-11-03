/**
 * The model breadcrumb (polish pass Task 5, spec §5.1): how a client
 * displays "which model answered this message".
 *
 * User ruling: the provider is ALWAYS a breadcrumb segment. Every path
 * segment except the leaf collapses to its first character, the leaf
 * stays whole, and the provider joins as its own one-character segment —
 * `openai` + `gpt-4o-mini` reads `o/gpt-4o-mini`, an old bifrost chain
 * message (bare `acme-flash`) `b/acme-flash`, a new one (Task 4 restored
 * the display id, so `chain/acme-flash`) `b/c/acme-flash`. The untruncated
 * id rides along as `full` for a hover title, so the transcript stays
 * compact without losing what it abbreviated.
 *
 * A message with NO provider shows its plain model name: the archive has
 * rows recorded before a provider was stamped, and inventing a segment
 * for them would name a provider nobody recorded.
 *
 * Pure module (no imports at all): both clients render this from one
 * source, so it must never drag in a dependency one of them can't resolve.
 */

/** The id's path segments, empties dropped (`a//b/` → `["a","b"]`). */
function pathSegments(id: string): string[] {
	return id.split("/").filter((segment) => segment !== "");
}

/** The collapsed breadcrumb path: every non-leaf segment's first
 *  character + the whole leaf. Never called with an empty path. */
function collapse(path: readonly string[]): string {
	const leaf = path[path.length - 1] ?? "";
	const head = path.slice(0, -1).map((segment) => segment.slice(0, 1));
	return [...head, leaf].join("/");
}

/**
 * The two strings a client shows for one message's model: `short` is the
 * collapsed breadcrumb (the transcript label), `full` the untruncated
 * `provider/model` id (a hover title).
 */
export function modelBreadcrumb(
	provider: string | undefined,
	model: string,
): { readonly short: string; readonly full: string } {
	if (provider === undefined || provider === "") {
		return { short: model, full: model };
	}
	// The id may already carry its provider (`bifrost/chain/x`): strip the
	// prefix rather than folding it into a second segment, so the provider
	// is never named twice.
	const prefix = `${provider}/`;
	const rest = model.startsWith(prefix) ? model.slice(prefix.length) : model;
	const path = pathSegments(rest);
	if (path.length === 0) {
		// Nothing but the provider — show it whole, never a trailing slash.
		return { short: provider.slice(0, 1), full: provider };
	}
	return {
		short: `${provider.slice(0, 1)}/${collapse(path)}`,
		full: `${provider}/${path.join("/")}`,
	};
}
