/**
 * The user-facing spelling of an auth-surface rejection (polish task 12 —
 * extracted from Onboarding; shared by Login, ShareMenu, and
 * AccountLinksSection so the four surfaces never drift on wire-code
 * copy). Known wire codes get fixed copy; other errors retain their
 * existing message. These codes are never shown raw.
 */
import { ApiError } from "../api";

export function messageOf(cause: unknown): string {
	if (cause instanceof ApiError) {
		const copy: Record<string, string> = {
			proxy_identity_required:
				"This sigrun signs people in through its sign-in proxy. Open it through the proxy.",
			username_taken: "That username is taken. Choose another.",
			invalid_username:
				"That name has no usable characters — use at least one letter or digit.",
		};
		const key = cause.error ?? "";
		if (Object.hasOwn(copy, key)) return copy[key];
		if (cause.error !== undefined) return cause.error;
	}
	return cause instanceof Error ? cause.message : String(cause);
}
