/**
 * The auth posture shared by the server, the webui, and the CLI
 * (polish task 12; proxy-trust spec §5.2/§5.8).
 *
 * `isProxyOnly` had THREE private copies (src/server/auth/proxy-only.ts,
 * webui/src/auth/AuthGate.tsx, src/cli.ts) that could drift: a proxy-only
 * server mints no redeemable setup code, so every surface must agree on
 * what "proxy-only" means. One definition lives here now; the server's
 * own module re-exports it for its existing callers.
 */

/**
 * Whether the configured auth methods are exactly proxy-only: a `proxy`
 * method with no `token` method. A proxy-only server has no token
 * callers, so an unvouched setup-code prompt can never be redeemed —
 * onboarding happens through the proxy in a browser.
 *
 * UNKNOWN posture fails safe: an absent/empty method list (the 403
 * setup_required path carries no methods; a pre-methods server speaks
 * an older shape) counts as proxy-only — a stranger-facing server whose
 * auth methods cannot be seen must not invite an unredeemable claim.
 */
export function isProxyOnly(methods: readonly string[] | undefined): boolean {
	if (methods === undefined || methods.length === 0) return true;
	return methods.includes("proxy") && !methods.includes("token");
}
