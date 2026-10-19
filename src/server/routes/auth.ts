/**
 * The §5.4/§5.8 auth routes (core hardening W1 Task 3): browser login
 * (API token → session cookie), logout (cookie expiry), and whoami
 * (the resolved principal). The pipeline marks login/logout public
 * (stage 2); whoami is an authenticated route like any other.
 *
 * Login's contract: a valid token replies 200 `{user}` and sets
 * `sigrun_session=<token>; HttpOnly; SameSite=Strict; Path=/` (plus
 * `; Secure` when the request is https directly or via
 * `X-Forwarded-Proto: https` from a trusted proxy peer). An invalid
 * token waits 1 000 ms (blunting online guessing) before 401; the
 * per-IP limiter's 429 is checked FIRST, before the credential and the
 * wait.
 */

import type { FastifyInstance } from "fastify";
import type { ServerContext } from "../context.js";
import { ipAllowed } from "../auth/ip.js";
import { LoginLimiter } from "../auth/login-limiter.js";

/** The session cookie name (spec §5.4). */
export const SESSION_COOKIE = "sigrun_session";
/** The failed-login delay (ms), per the brief. */
const LOGIN_FAILURE_DELAY_MS = 1_000;

/** Register the three auth routes. */
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
		const token =
			typeof body === "object" && body !== null && "token" in body
				? (body as { token?: unknown }).token
				: undefined;
		const record =
			typeof token === "string"
				? ctx.opened.identity.tokens.verify(token)
				: undefined;
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
		// `Secure` only on https — direct TLS or a trusted proxy's
		// X-Forwarded-Proto (an untrusted peer's header is ignored).
		const trusted = ipAllowed(
			request.socket.remoteAddress,
			ctx.config.auth.proxy.trustedProxies,
		);
		const forwarded = request.headers["x-forwarded-proto"];
		const forwardedProto = Array.isArray(forwarded) ? forwarded[0] : forwarded;
		const secure =
			request.protocol === "https" ||
			(trusted && forwardedProto === "https");
		const cookie =
			`${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/` +
			(secure ? "; Secure" : "");
		return await reply
			.code(200)
			.header("set-cookie", cookie)
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
}
