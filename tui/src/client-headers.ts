/**
 * The TUI's request headers (2026-11-10): ONE builder for every HTTP path
 * (the API client, both SSE watchers, the chat and ext surface
 * transports), so no request can miss a header.
 *
 * `x-sigrun-client: tui` labels the request as the TUI. It is a ROUTING
 * label, never a credential: a deployment may match it exactly to send
 * TUI traffic around browser forward auth, and sigrun still authenticates
 * the bearer token. The value is fixed (no version) so an exact-match
 * rule survives releases.
 *
 * `x-sigrun-user` and `authorization: Bearer` follow the trim-then-omit
 * rule: undefined, empty, or whitespace-only values send no header.
 */

/** The client-label header name. */
export const CLIENT_HEADER = "x-sigrun-client";

/** The client-label value: fixed, never versioned. */
export const CLIENT_NAME = "tui";

/** The headers every TUI request carries. */
export function clientHeaders(options: {
	readonly accept: string;
	readonly user?: string;
	readonly token?: string;
}): Record<string, string> {
	const user = options.user?.trim();
	const token = options.token?.trim();
	return {
		accept: options.accept,
		[CLIENT_HEADER]: CLIENT_NAME,
		...(user === undefined || user === "" ? {} : { "x-sigrun-user": user }),
		...(token === undefined || token === ""
			? {}
			: { authorization: `Bearer ${token}` }),
	};
}
