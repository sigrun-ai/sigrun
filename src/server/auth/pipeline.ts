/**
 * The §5 request pipeline (core hardening W1 Task 3, spec §5.2/§5.3):
 * ONE onRequest hook, registered before every route, that resolves the
 * caller into `request.principal`. The stages, in order:
 *
 *  1. **Host/Origin checks.** On a loopback listen host, the `Host`
 *     hostname (port stripped) must be loopback or in
 *     `auth.allowedHosts`, else 421 (DNS-rebinding defense); a
 *     non-loopback bind checks only when `allowedHosts` is set. A
 *     non-GET/HEAD request with an `Origin` must match the effective
 *     host (`X-Forwarded-Host` from a trusted proxy peer, else `Host`)
 *     or `auth.allowedOrigins`, else 403 `origin_mismatch`.
 *  2. **Public paths.** Decided from the MATCHED ROUTE PATTERN
 *     (`request.routeOptions.url`), never the raw URL (Fastify decodes
 *     before routing — `/%761/...` routes to `/v1/...`): `/healthz`,
 *     `/readyz`, `/metrics` when `config.metricsPublic`,
 *     `/v1/onboarding` (+ subpaths), `POST /v1/auth/login`,
 *     `POST /v1/auth/logout`, and the browser surface — a GET/HEAD that
 *     matched the static wildcard (`/*`) or no route at all (the
 *     not-found handler serves the SPA for non-/v1 paths).
 *  3. **Env service token.** A `Bearer` equal (constant-time) to
 *     `SIGRUN_API_TOKEN` resolves the service principal and skips the
 *     setup gate.
 *  4. **Unclaimed gate.** `!users.isClaimed()` → 403 `setup_required`
 *     (onboarding is the only usable surface until the first claim).
 *  4b. **Extension-route public skip** (W5 Task 2, spec §9.2). A request
 *     ROUTED to a mounted `/v1/ext/<slug>/<path>` route whose
 *     contribution declared `auth: "public"` skips stage 5 — webhooks
 *     and OAuth callbacks verify their own caller. Stages 1-4 still
 *     applied (an unclaimed server answers a public route 403
 *     `setup_required`, spec §5.8); the request carries no principal.
 *  5. **Methods, in `ctx.methods` order.** `proxy`: trusted peer CIDR +
 *     (when configured) the shared-secret header (deleted from the
 *     request before handlers run) + a non-empty user header; a
 *     directory miss auto-provisions (`source:"proxy"`, admin:false)
 *     unless `autoProvision:false` → 403 `user_not_provisioned`.
 *     `token`: Bearer or the `sigrun_session` cookie → `tokens.verify`;
 *     the token's user must exist in the directory, else 401.
 *  6. **Empty list** (the naive workstation path): the trimmed
 *     `X-Sigrun-User` header verbatim, `admin: true`, method `"none"`.
 */

import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ServerContext } from "../context.js";
import { ipAllowed } from "./ip.js";
import { isLoopbackHost } from "./loopback.js";
import type { Principal } from "./principal.js";
import { AdmissionRefusedError } from "../../harness/identity/users.js";
import { effectiveAdmin } from "../../harness/identity/groups.js";

/** One header read: Fastify headers may be string | string[]; first wins. */
function headerOf(
	request: FastifyRequest,
	name: string,
): string | undefined {
	const value = request.headers[name.toLowerCase()];
	const single = Array.isArray(value) ? value[0] : value;
	return single?.trim() || undefined;
}

/** Constant-time string equality (credentials never compare with `===`). */
function timingSafeStringEqual(a: string, b: string): boolean {
	const left = Buffer.from(a, "utf8");
	const right = Buffer.from(b, "utf8");
	if (left.length !== right.length) return false;
	return timingSafeEqual(left, right);
}

/** The request's Bearer credential, if the Authorization header carries one. */
export function bearerOf(request: FastifyRequest): string | undefined {
	const value = headerOf(request, "authorization");
	if (value === undefined) return undefined;
	const match = /^Bearer\s+(.+)$/i.exec(value);
	return match?.[1]?.trim() || undefined;
}

/** The `sigrun_session` cookie value (naive parse; the cookie is ours). */
export function sessionCookieOf(request: FastifyRequest): string | undefined {
	const raw = headerOf(request, "cookie");
	if (raw === undefined) return undefined;
	for (const pair of raw.split(";")) {
		const eq = pair.indexOf("=");
		if (eq === -1) continue;
		if (pair.slice(0, eq).trim() === "sigrun_session") {
			return pair.slice(eq + 1).trim() || undefined;
		}
	}
	return undefined;
}

/** The Host hostname with any port stripped (`[::1]:3000` → `[::1]`). */
function hostNameOf(host: string): string {
	if (host.startsWith("[")) {
		const close = host.indexOf("]");
		return close === -1 ? host : host.slice(0, close + 1);
	}
	const colon = host.indexOf(":");
	return colon === -1 ? host : host.slice(0, colon);
}

/** Stage 1a: the Host check. Returns the rejection status, or undefined. */
function checkHost(
	request: FastifyRequest,
	ctx: ServerContext,
): number | undefined {
	const host = headerOf(request, "host");
	if (host === undefined) return 421;
	const allowed = ctx.config.auth.allowedHosts ?? [];
	if (allowed.some((entry) => entry.toLowerCase() === host.toLowerCase())) {
		return undefined;
	}
	const name = hostNameOf(host);
	if (allowed.some((entry) => entry.toLowerCase() === name.toLowerCase())) {
		return undefined;
	}
	if (!isLoopbackHost(ctx.listenHost)) {
		// A non-loopback bind checks only when the allowlist exists.
		return allowed.length === 0 ? undefined : 421;
	}
	return isLoopbackHost(name) ? undefined : 421;
}

/** Stage 1b: the Origin check (non-GET/HEAD only). Returns true when rejected. */
function checkOrigin(request: FastifyRequest, ctx: ServerContext): boolean {
	if (request.method === "GET" || request.method === "HEAD") return false;
	const origin = headerOf(request, "origin");
	if (origin === undefined) return false;
	for (const allowed of ctx.config.auth.allowedOrigins ?? []) {
		if (allowed.toLowerCase() === origin.toLowerCase()) return false;
	}
	// The effective host the browser claims to be serving: X-Forwarded-Host
	// from a trusted peer (a forward-auth proxy fronts us), else Host.
	const trusted = ipAllowed(
		request.socket.remoteAddress,
		ctx.config.auth.proxy.trustedProxies,
	);
	const forwarded = trusted ? headerOf(request, "x-forwarded-host") : undefined;
	const host = headerOf(request, "host");
	const expectedHosts = new Set<string>();
	for (const candidate of [forwarded, host]) {
		if (candidate === undefined) continue;
		expectedHosts.add(candidate.toLowerCase());
		expectedHosts.add(hostNameOf(candidate).toLowerCase());
	}
	let originHost: string | undefined;
	try {
		originHost = new URL(origin).host.toLowerCase();
	} catch {
		return true; // an unparseable Origin never matches
	}
	return !expectedHosts.has(originHost);
}

/**
 * Stage 2: whether the request answers without a principal.
 *
 * Computed from the MATCHED ROUTE PATTERN (`request.routeOptions.url`,
 * e.g. `/v1/settings`, `/v1/conversations/:id`, `/*`), never the raw
 * URL: Fastify decodes the path BEFORE routing, so `GET /%761/settings`
 * (`%76` = `v`) routes to `/v1/settings` while the raw URL fails a
 * `/v1/` prefix check — the encoded-path auth bypass. A GET is public
 * only when it matched the static plugin's wildcard (`/*`) or matched
 * nothing (the not-found handler serves the SPA for non-/v1 paths).
 */
function isPublicPath(request: FastifyRequest, ctx: ServerContext): boolean {
	const pattern = request.routeOptions.url;
	if (pattern === "/healthz" || pattern === "/readyz") return true;
	if (pattern === "/metrics" && ctx.config.metricsPublic) return true;
	if (pattern === "/v1/auth/login" && request.method === "POST") return true;
	if (pattern === "/v1/auth/logout" && request.method === "POST") return true;
	if (pattern === "/v1/auth/providers" && request.method === "GET") return true;
	if (pattern === "/v1/auth/login/:provider" && request.method === "GET") return true;
	if (pattern === "/v1/auth/login/code" && request.method === "POST") return true;
	if (
		pattern === "/v1/auth/callback/:provider" &&
		(request.method === "GET" || request.method === "POST")
	) return true;
	if (pattern === "/v1/onboarding" || pattern?.startsWith("/v1/onboarding/")) {
		return true;
	}
	// The browser surface: GET/HEAD that matched the static wildcard or
	// no route at all (the not-found handler serves the SPA). Anything
	// that matched a real API route — under ANY spelling of its path — is
	// not public.
	if (request.method === "GET" || request.method === "HEAD") {
		if (pattern === "/*" || pattern === undefined) return true;
	}
	return false;
}

/**
 * Stage 5a (proxy): resolve the forward-auth headers, or reply with the
 * rejection. The secret header is DELETED from the request before any
 * handler (or test hook) can observe it.
 */
async function resolveProxy(
	request: FastifyRequest,
	ctx: ServerContext,
): Promise<Principal | { status: number; error?: string }> {
	const { proxy, adminGroups } = ctx.config.auth;
	if (!ipAllowed(request.socket.remoteAddress, proxy.trustedProxies)) {
		return { status: 401 };
	}
	if (proxy.secret !== undefined && proxy.secretHeader !== undefined) {
		const name = proxy.secretHeader.toLowerCase();
		const presented = headerOf(request, name);
		delete request.headers[name];
		if (presented === undefined || !timingSafeStringEqual(presented, proxy.secret)) {
			return { status: 401 };
		}
	}
	const user = headerOf(request, proxy.userHeader);
	if (user === undefined) return { status: 401 };
	const groups =
		headerOf(request, proxy.groupsHeader)
			?.split(",")
			.map((group) => group.trim())
			.filter((group) => group !== "") ?? [];
	const { users } = ctx.opened.identity;
	// The invalid-username case (a proxy header that can't be a directory
	// user) is a loud 403, not a 500: the proxy vouched for an identity
	// this server can never represent.
	if (!/^[a-z0-9][a-z0-9._-]*$/.test(user)) {
		return { status: 403, error: "invalid_username" };
	}
	const existing = users.get(user);
	if (existing === undefined && !proxy.autoProvision) {
		return { status: 403, error: "user_not_provisioned" };
	}
	let record;
	try {
		record = existing ??
			(await users.add({
				user,
				...(headerOf(request, proxy.nameHeader) === undefined
					? {}
					: { name: headerOf(request, proxy.nameHeader) as string }),
				...(headerOf(request, proxy.emailHeader) === undefined
					? {}
					: { email: headerOf(request, proxy.emailHeader) as string }),
				admin: false,
				source: "proxy",
			}));
	} catch (error) {
		if (error instanceof AdmissionRefusedError) {
			return { status: 403, error: error.code };
		}
		throw error;
	}
	// Persist the authenticated source's groups on every proxy request;
	// setGroups avoids the write when the values are unchanged. Effective
	// admin is computed over the UPDATED record, so a group exit revokes
	// the request's grant immediately and host-side checks agree.
	record = await users.setGroups(user, "proxy", groups);
	return {
		user: record.user,
		...(record.name === undefined ? {} : { name: record.name }),
		...(record.email === undefined ? {} : { email: record.email }),
		admin: effectiveAdmin(record, adminGroups),
		service: false,
		method: "proxy",
	};
}

/** Stage 5b (token): verify a presented credential against the token store. */
export function resolveToken(
	request: FastifyRequest,
	ctx: ServerContext,
): Principal | { status: number; error?: string } {
	const presented = bearerOf(request) ?? sessionCookieOf(request);
	if (presented === undefined) return { status: 401 };
	const record = ctx.opened.identity.tokens.verify(presented);
	if (record === undefined) return { status: 401 };
	const user = ctx.opened.identity.users.get(record.user);
	// A token for a removed user is dead weight — the user must exist.
	if (user === undefined) return { status: 401 };
	return {
		user: user.user,
		...(user.name === undefined ? {} : { name: user.name }),
		...(user.email === undefined ? {} : { email: user.email }),
		// Token/session credentials are not group sources: derive from the
		// stored record without writing groups on this request path.
		admin: effectiveAdmin(user, ctx.config.auth.adminGroups),
		service: false,
		method: record.kind === "session" ? "session" : "token",
		...(record.kind === "session" && record.provider !== undefined
			? { provider: record.provider }
			: {}),
	};
}

/** The ONE request hook. Stages 1→5 in brief order; a stage replies or falls through. */
export function registerAuthPipeline(
	app: FastifyInstance,
	ctx: ServerContext,
): void {
	app.addHook("onRequest", async (request, reply) => {
		// Stage 1: Host + Origin.
		const hostStatus = checkHost(request, ctx);
		if (hostStatus !== undefined) {
			return await reply.code(hostStatus).send({ error: "host_not_allowed" });
		}
		if (checkOrigin(request, ctx)) {
			return await reply.code(403).send({ error: "origin_mismatch" });
		}

		// Stage 2: the public surface (resolved but never blocked).
		if (isPublicPath(request, ctx)) return;

		// Stage 3: the env service token (constant-time; skips stage 4).
		const service = ctx.config.auth.serviceToken;
		const bearer = bearerOf(request);
		if (
			service !== undefined &&
			bearer !== undefined &&
			timingSafeStringEqual(bearer, service.token)
		) {
			request.principal = {
				user: service.user,
				admin: true,
				service: true,
				method: "token",
			};
			return;
		}

		// Stage 4: the setup gate (the brief's "never 401 before 403").
		if (!ctx.opened.identity.users.isClaimed()) {
			return await reply.code(403).send({ error: "setup_required" });
		}
		// Stage 4b: the extension-route public skip (W5 Task 2, spec §9.2).
		// The request is already ROUTED — Fastify resolved it to a route
		// before lifecycle hooks run — so `routeOptions.config.extAuth` is
		// the mounted route's declared auth, exactly (and `routeOptions.url`
		// is the MATCHED PATTERN, immune to encoded-path spellings). A
		// `public` route (a webhook, an OAuth callback) skips stage 5; its
		// handler sees no principal and verifies its own caller. Everything
		// else (`user`/`admin`, core routes, unrouted paths) falls through to
		// the normal authentication stages.
		if (
			request.routeOptions.url?.startsWith("/v1/ext/") &&
			request.routeOptions.config.extAuth === "public"
		) {
			return;
		}
		// Stage 5/6: the configured methods, in order; the empty list is
		// the naive loopback path.
		if (ctx.methods.length === 0) {
			request.principal = {
				user: headerOf(request, "x-sigrun-user"),
				admin: true,
				service: false,
				method: "none",
			};
			return;
		}
		for (const method of ctx.methods) {
			const resolved =
				method === "proxy"
					? await resolveProxy(request, ctx)
					: resolveToken(request, ctx);
			if ("user" in resolved && resolved.user !== undefined) {
				request.principal = resolved;
				return;
			}
			// A configured-deny (403 user_not_provisioned) is terminal: the
			// proxy VOUCHED for a user the directory refuses — trying weaker
			// methods would widen, not narrow, the failure surface.
			if (!("user" in resolved) && resolved.status === 403) {
				return await reply
					.code(403)
					.send({ error: resolved.error ?? "forbidden" });
			}
		}
		return await reply.code(401).send({ error: "unauthenticated" });
	});
}
