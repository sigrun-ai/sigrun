/**
 * The §5.4/§5.8 auth routes (core hardening W1 Tasks 3 + 4): browser
 * login (API token → session cookie), logout (cookie expiry), whoami
 * (the resolved principal), and the token management surface (`GET/POST
 * /v1/auth/tokens`, `DELETE /v1/auth/tokens/:id`). The pipeline marks
 * login/logout public (stage 2); whoami and the token routes are
 * authenticated routes like any other.
 *
 * Login's contract: a valid token replies 200 `{user}` and sets
 * `sigrun_session=<token>; HttpOnly; SameSite=Strict; Path=/` (plus
 * `; Secure` when the request is https directly or via
 * `X-Forwarded-Proto: https` from a trusted proxy peer). An invalid
 * token waits 1 000 ms (blunting online guessing) before 401; the
 * per-IP limiter's 429 is checked FIRST, before the credential and the
 * wait.
 *
 * Token routes (Task 4): creation is SELF-ONLY — a body carrying a `user`
 * field is 403 `forbidden` (minting credentials for another user is
 * never a delegated act); listing serves the caller's tokens, with
 * `?user=` the admin-only window into another's; revocation deletes the
 * caller's own tokens, or any for an admin.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ServerContext } from "../context.js";
import { ipAllowed } from "../auth/ip.js";
import { LoginLimiter } from "../auth/login-limiter.js";
import type { TokenCreateResponse, TokenWire } from "../views.js";
import type { TokenRecord } from "../../harness/identity/index.js";

/** The session cookie name (spec §5.4). */
export const SESSION_COOKIE = "sigrun_session";
/** The failed-login delay (ms), per the brief. */
const LOGIN_FAILURE_DELAY_MS = 1_000;

/**
 * Build the `sigrun_session` cookie for `token`. `Secure` only on https —
 * direct TLS or a trusted proxy's X-Forwarded-Proto (an untrusted peer's
 * header is ignored). Shared by login and the onboarding claim's
 * `issueToken` (Task 4).
 */
export function buildSessionCookie(
	token: string,
	request: FastifyRequest,
	ctx: ServerContext,
): string {
	const trusted = ipAllowed(
		request.socket.remoteAddress,
		ctx.config.auth.proxy.trustedProxies,
	);
	const forwarded = request.headers["x-forwarded-proto"];
	const forwardedProto = Array.isArray(forwarded) ? forwarded[0] : forwarded;
	const secure =
		request.protocol === "https" || (trusted && forwardedProto === "https");
	return (
		`${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/` +
		(secure ? "; Secure" : "")
	);
}

/** The wire form of one token record — never the digest. */
function tokenWire(record: TokenRecord): TokenWire {
	return {
		id: record.id,
		name: record.name,
		user: record.user,
		createdAt: record.createdAt,
	};
}

/** Register the auth routes: login, logout, whoami, and token management. */
export function registerAuthRoutes(
	app: FastifyInstance,
	ctx: ServerContext,
): void {
	const limiter = new LoginLimiter();

	app.post("/v1/auth/login", async (request, reply) => {
		const source = request.socket.remoteAddress ?? "unknown";
		// The limiter answers BEFORE the credential is touched — a locked
		// source never learns whether its token was right.
		if (!limiter.allowed(source)) {
			return await reply.code(429).send({ error: "rate_limited" });
		}
		const body = request.body;
		const presented =
			typeof body === "object" && body !== null && "token" in body
				? (body as { token?: unknown }).token
				: undefined;
		const token = typeof presented === "string" ? presented : undefined;
		const record =
			token === undefined
				? undefined
				: ctx.opened.identity.tokens.verify(token);
		const user =
			record === undefined
				? undefined
				: ctx.opened.identity.users.get(record.user);
		if (record === undefined || user === undefined || token === undefined) {
			limiter.recordFailure(source);
			await new Promise((resolve) =>
				setTimeout(resolve, LOGIN_FAILURE_DELAY_MS),
			);
			return await reply.code(401).send({ error: "invalid_token" });
		}
		limiter.recordSuccess(source);
		return await reply
			.code(200)
			.header("set-cookie", buildSessionCookie(token, request, ctx))
			.send({ user: user.user });
	});

	app.post("/v1/auth/logout", async (_request, reply) => {
		return await reply
			.code(204)
			.header(
				"set-cookie",
				`${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
			)
			.send();
	});

	app.get("/v1/auth/whoami", async (request) => {
		const principal = request.principal;
		return {
			...(principal.user === undefined ? {} : { user: principal.user }),
			...(principal.name === undefined ? {} : { name: principal.name }),
			...(principal.email === undefined ? {} : { email: principal.email }),
			admin: principal.admin,
			service: principal.service,
			method: principal.method,
		};
	});

	// ─── Token management (Task 4) ─────────────────────────────────────

	app.get("/v1/auth/tokens", async (request, reply) => {
		const principal = request.principal;
		const query = request.query as { user?: string };
		// `?user=` is the admin-only window into another's tokens; a
		// non-admin asking for anyone (even themselves — same answer as no
		// query) is refused before the store is read.
			if (query.user !== undefined) {
			if (!principal.admin && query.user !== principal.user) {
				return await reply.code(403).send({ error: "forbidden" });
			}
			return { tokens: ctx.opened.identity.tokens.list(query.user).map(tokenWire) };
		}
		// The caller's own list — undefined (the naive single-operator
		// superuser, userless service principal) means "no directory user to
		// filter by": the whole store, which for that posture IS the
		// operator's own (single-operator deploy).
		return {
			tokens: ctx.opened.identity.tokens.list(principal.user).map(tokenWire),
		};
	});

	app.post("/v1/auth/tokens", async (request, reply) => {
		const body = request.body;
		if (
			typeof body !== "object" ||
			body === null ||
			Array.isArray(body)
		) {
			return await reply.code(400).send({ error: "invalid_body" });
		}
		const record = body as Record<string, unknown>;
		for (const key of Object.keys(record)) {
			if (key !== "name" && key !== "user") {
				return await reply.code(400).send({ error: "invalid_field", field: key });
			}
		}
		// Self only, ever: an authenticated principal never mints for
		// another user — the body's `user` is refused, not honored.
		if (record.user !== undefined) {
			return await reply.code(403).send({ error: "forbidden" });
		}
		if (typeof record.name !== "string" || record.name.trim() === "") {
			return await reply.code(400).send({ error: "invalid_body" });
		}
		const owner = request.principal.user;
		// The naive superuser with no header has no directory identity to
		// mint for — a mintable token needs a user whose rights it carries.
		if (owner === undefined) {
			return await reply.code(400).send({ error: "no_user" });
		}
		const minted = await ctx.opened.identity.tokens.create(
			record.name,
			owner,
		);
		const response: TokenCreateResponse = {
			token: minted.token,
			record: tokenWire(minted.record),
		};
		return await reply.code(201).send(response);
	});

	app.delete("/v1/auth/tokens/:id", async (request, reply) => {
		const { id } = request.params as { id: string };
		const record = ctx.opened.identity.tokens
			.list()
			.find((entry) => entry.id === id);
		if (record === undefined) {
			return await reply.code(404).send({ error: "unknown_token" });
		}
		const principal = request.principal;
		if (record.user !== principal.user && !principal.admin) {
			return await reply.code(403).send({ error: "forbidden" });
		}
		await ctx.opened.identity.tokens.revoke(id);
		return await reply.code(204).send();
	});
}
