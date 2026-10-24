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
	},
): Promise<FastifyReply> {
	if (outcome.kind === "refused") {
		return input.reply.code(403)
			.header("location", `/login?error=${encodeURIComponent(outcome.error)}`)
			.send();
	}
	if (outcome.kind === "needs_code") {
		return input.reply.code(403).header("location", "/login?error=invalid_code").send();
	}
	if (outcome.kind === "linked") {
		return input.reply.code(302).header("location", "/settings?section=accounts").send();
	}
	const session = await input.ctx.opened.identity.tokens.createSession(
		outcome.user,
		input.provider,
		sessionTtlMs(input.ctx),
	);
	return input.reply.code(302)
		.header("location", input.returnTo)
		.header("set-cookie", buildSessionCookie(session.token, input.request, input.ctx))
		.send();
}
