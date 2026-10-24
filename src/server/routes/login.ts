import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { LoginFlow, LoginResult } from "../../extension.js";
import { ipAllowed } from "../auth/ip.js";
import { bearerOf, resolveToken, sessionCookieOf } from "../auth/pipeline.js";
import type { ServerContext } from "../context.js";
import { LoginFlows, type StoredFlow } from "../login/flows.js";

export const LOGIN_STATE_COOKIE = "sigrun_login_state";

/** Task 5's resolver seam: it owns account links, provisioning and sessions. */
export type LoginResolver = (input: {
	provider: string;
	result: LoginResult;
	flow: StoredFlow;
	request: FastifyRequest;
	reply: FastifyReply;
}) => Promise<unknown> | unknown;

/** Only local absolute paths may survive the external-identity round trip. */
export function safeReturnTo(value: unknown): string {
	if (
		typeof value !== "string" ||
		!value.startsWith("/") ||
		value.startsWith("//") ||
		value.includes("\\") ||
		/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)
	) return "/";
	return value;
}

function cookieValue(request: FastifyRequest, name: string): string | undefined {
	const header = request.headers.cookie;
	if (typeof header !== "string") return undefined;
	for (const pair of header.split(";")) {
		const eq = pair.indexOf("=");
		if (eq !== -1 && pair.slice(0, eq).trim() === name) {
			return pair.slice(eq + 1).trim() || undefined;
		}
	}
	return undefined;
}

function stateCookie(key: string, request: FastifyRequest, ctx: ServerContext): string {
	const trusted = ipAllowed(
		request.socket.remoteAddress,
		ctx.config.auth.proxy.trustedProxies,
	);
	const forwarded = request.headers["x-forwarded-proto"];
	const secure = request.protocol === "https" ||
		(trusted && (Array.isArray(forwarded) ? forwarded[0] : forwarded) === "https");
	return `${LOGIN_STATE_COOKIE}=${key}; HttpOnly; SameSite=Lax; Path=/v1/auth/callback` +
		(secure ? "; Secure" : "");
}

function browserError(
	reply: FastifyReply,
	statusCode: number,
	error: string,
): FastifyReply {
	return reply.code(statusCode).header("location", `/login?error=${encodeURIComponent(error)}`).send();
}

function queryOf(request: FastifyRequest): Record<string, string> {
	const query: Record<string, string> = {};
	for (const [key, value] of Object.entries(request.query as Record<string, unknown>)) {
		if (typeof value === "string") query[key] = value;
		else if (Array.isArray(value) && typeof value[0] === "string") query[key] = value[0];
	}
	return query;
}

/** Register core-owned login flows over extension-contributed identity proofs. */
export function registerLoginRoutes(
	app: FastifyInstance,
	ctx: ServerContext,
	options: { flows?: LoginFlows; resolver?: LoginResolver } = {},
): void {
	// Deliberately per-server, never a harness singleton: restart invalidates
	// in-flight logins and separate server instances never share browser state.
	const flows = options.flows ?? new LoginFlows();
	const providers = new Map(ctx.opened.loginProviders.map((entry) => [entry.provider, entry]));

	app.get("/v1/auth/providers", async () => ({
		providers: ctx.opened.loginProviders.map(({ provider, contribution }) => ({
			provider,
			label: contribution.label,
			...(contribution.icon === undefined ? {} : { icon: contribution.icon }),
		})),
	}));

	app.get("/v1/auth/login/:provider", async (request, reply) => {
		const { provider } = request.params as { provider: string };
		const binding = providers.get(provider);
		if (binding === undefined) return browserError(reply, 404, "unknown_provider");
		const query = queryOf(request);
		let link: string | undefined;
		if (query.link === "1") {
			const presented = bearerOf(request) ?? sessionCookieOf(request);
			const principal = presented === undefined ? { status: 401 } : resolveToken(request, ctx);
			if ("status" in principal) return await reply.code(401).send({ error: "unauthenticated" });
			if (principal.user === undefined) return await reply.code(401).send({ error: "unauthenticated" });
			link = principal.user;
		}
		const returnTo = safeReturnTo(query.return);
		const started = flows.start(provider, { returnTo, ...(link === undefined ? {} : { link }) });
		const callbackUrl = `${ctx.config.publicUrl ?? `${request.protocol}://${request.headers.host ?? "localhost"}`}/v1/auth/callback/${encodeURIComponent(provider)}`;
		const flow: LoginFlow = {
			state: started.state,
			callbackUrl,
			data: started.data,
		};
		try {
			const begun = await binding.contribution.begin(flow, {
				abortSignal: request.raw.signal,
			});
			flows.save(started.state, flow);
			return await reply
				.code(302)
				.header("location", begun.redirectUrl)
				.header("set-cookie", stateCookie(started.browserKey, request, ctx))
				.send();
		} catch (error) {
			console.error(
				`sigrun: login provider ${provider} begin failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			flows.take(started.state, started.browserKey);
			return browserError(reply, 500, "provider_error");
		}
	});

	const callback = async (request: FastifyRequest, reply: FastifyReply) => {
		const { provider } = request.params as { provider: string };
		const binding = providers.get(provider);
		if (binding === undefined) return browserError(reply, 404, "unknown_provider");
		const query = queryOf(request);
		const state = query.state ?? "";
		const browserKey = cookieValue(request, LOGIN_STATE_COOKIE) ?? "";
		const flow = flows.take(state, browserKey);
		if (flow === undefined) return browserError(reply, 400, flows.failure(state, browserKey));
		// State names ONE provider. A flow remains consumed on mismatch, so it
		// cannot be replayed through the original provider after this attempt.
		if (flow.provider !== provider) return browserError(reply, 400, "invalid_state");
		// Validate again at the trust boundary: a resolver must never receive an
		// open redirect even if the stored flow was constructed elsewhere.
		const safeFlow = { ...flow, returnTo: safeReturnTo(flow.returnTo) };
		let result: LoginResult;
		try {
			result = await binding.contribution.complete(
				{ state: flow.state, callbackUrl: flow.callbackUrl, data: flow.data },
				{ query, ...(request.body === undefined ? {} : { body: request.body }) },
				{ abortSignal: request.raw.signal },
			);
		} catch (error) {
			console.error(
				`sigrun: login provider ${provider} complete failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			return browserError(reply, 400, "provider_error");
		}
		if (options.resolver === undefined) {
			// Task 5 supplies the resolver. State remains consumed; the caller
			// must restart rather than replay a completed identity proof.
			return await reply.code(501).send({ error: "not_implemented" });
		}
		try {
			return await options.resolver({ provider, result, flow: safeFlow, request, reply });
		} catch (error) {
			if (reply.sent) throw error;
			console.error(
				`sigrun: login resolver failed for ${provider}: ${error instanceof Error ? error.message : String(error)}`,
			);
			return browserError(reply, 500, "login_failed");
		}
	};
	app.get("/v1/auth/callback/:provider", callback);
	app.post("/v1/auth/callback/:provider", callback);
}
