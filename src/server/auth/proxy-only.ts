/**
 * The C2 vouch rule for account-creating public paths (proxy-trust
 * onboarding, spec Task 4): a proxy-only server bound beyond loopback
 * admits accounts ONLY through a trusted proxy vouch. On such a boot
 * every unvouched account-creating public path — the onboarding claim
 * (setup-code and invite branches alike) and the login code-resume —
 * refuses with 403 `proxy_identity_required`, and boot never mints or
 * logs a setup code (it would be an unvouched account-creation path).
 *
 * The rule is deliberately about the CONFIGURED posture, not the
 * request: the login code-resume has no proxy identity at all, so under
 * `requiresProxyVouch` it always refuses. Mixed `[proxy, token]`
 * deployments keep the setup-code/invite paths (token callers exist),
 * and loopback binds keep them too (loopback is its own trust).
 */

import { isLoopbackHost } from "./loopback.js";

/** Whether the configured auth methods are exactly proxy-only. */
export function isProxyOnly(methods: readonly string[]): boolean {
	return methods.includes("proxy") && !methods.includes("token");
}

/**
 * Whether this boot requires a proxy vouch for account creation:
 * proxy-only AND bound beyond loopback. The loopback test is the shared
 * one (`127.0.0.0/8`, `::1`, `localhost`; `::ffff:127.*` unwrapped).
 */
export function requiresProxyVouch(
	methods: readonly string[],
	listenHost: string,
): boolean {
	return isProxyOnly(methods) && !isLoopbackHost(listenHost);
}
