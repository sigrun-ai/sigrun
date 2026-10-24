import type { FastifyReply, FastifyRequest } from "fastify";
import type { ServerContext } from "../context.js";
import { buildSessionCookie, sessionTtlMs } from "../routes/auth.js";
import type { LoginResolution } from "./resolve.js";

/** Translate one policy outcome into the browser's redirect/cookie response. */
export async function sendLoginResolution(
	outcome: LoginResolution,
	input: {
		provider: string;
		returnTo: string;
		request: FastifyRequest;
		reply: FastifyReply;
		ctx: ServerContext;
		/** JSON code interstitial clients redirect themselves after the cookie lands. */
		asJson?: boolean;
	},
): Promise<FastifyReply> {
	if (outcome.kind === "refused") {
		if (input.asJson === true) return input.reply.code(403).send({ error: outcome.error });
		return input.reply.code(403)
			.header("location", `/login?error=${encodeURIComponent(outcome.error)}`)
			.send();
	}
	if (outcome.kind === "needs_code") {
		if (input.asJson === true) return input.reply.code(403).send({ error: "invalid_code" });
		return input.reply.code(403).header("location", "/login?error=invalid_code").send();
	}
	if (outcome.kind === "linked") {
		const returnTo = "/settings?section=accounts";
		if (input.asJson === true) return input.reply.send({ returnTo });
		return input.reply.code(302).header("location", returnTo).send();
	}
	const session = await input.ctx.opened.identity.tokens.createSession(
		outcome.user,
		input.provider,
		sessionTtlMs(input.ctx),
	);
	const cookie = buildSessionCookie(session.token, input.request, input.ctx);
	if (input.asJson === true) {
		return input.reply.header("set-cookie", cookie).send({ returnTo: input.returnTo });
	}
	return input.reply.code(302)
		.header("location", input.returnTo)
		.header("set-cookie", cookie)
		.send();
}
