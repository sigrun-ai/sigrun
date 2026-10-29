/**
 * The onboarding routes (core hardening W1 Task 4, spec §5.8): the
 * unclaimed state's whole surface. The pipeline public-paths
 * `/v1/onboarding*` (stage 2), so these routes resolve trust THEMSELVES:
 * a trusted proxy identity (headers from a trusted peer) or a loopback
 * bind is trust enough to claim with no code; everything else must
 * present the setup code (the unclaimed boot's one-shot credential) or,
 * once claimed, a valid invite code.
 *
 * Claims and invite redemptions serialize on the ONE in-process claim
 * mutex (`claim-lock.ts`) with the directory write atomic — concurrent
 * correct claims yield exactly one 200; the rest get 409
 * `already_claimed`.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { isUsernameKey } from "@sigrun/shared/usernames";
import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ServerContext } from "../context.js";
import { withClaimLock } from "../auth/claim-lock.js";
import { ipAllowed } from "../auth/ip.js";
import { isLoopbackHost } from "../auth/loopback.js";
import { ownHostPeerPermitted } from "../auth/own-host.js";
import { previewProxyUser, provisionProxyUser } from "../auth/proxy-identity.js";
import {
	ProxyRejectReason,
	warnProxyRejected,
} from "../auth/proxy-diagnostic.js";
import { requiresProxyVouch } from "../auth/proxy-only.js";
import { readSetupCode, clearSetupCode } from "../../harness/identity/index.js";
import type { DirectoryUser } from "../../harness/identity/users.js";
import { setupCodeMatches } from "../../harness/identity/setup-code-check.js";
import { AdmissionRefusedError } from "../../harness/identity/users.js";
import { stampSessionOwner } from "../helpers.js";
import { buildSessionCookie } from "./auth.js";
import type { ClaimResponse, OnboardingState } from "../views.js";

/** One header read (Fastify headers are string | string[]; first wins). */
function headerOf(request: FastifyRequest, name: string): string | undefined {
	const value = request.headers[name.toLowerCase()];
	const single = Array.isArray(value) ? value[0] : value;
	return single?.trim() || undefined;
}

/** What a trusted proxy vouches for — its raw subject and would-be key. */
interface ProxyIdentity {
	readonly user: string;
	readonly subject: string;
	readonly name?: string;
	readonly email?: string;
}

/** Constant-time string equality (the pipeline's discipline). */
function timingSafeStringEqual(a: string, b: string): boolean {
	const left = Buffer.from(a, "utf8");
	const right = Buffer.from(b, "utf8");
	if (left.length !== right.length) return false;
	return timingSafeEqual(left, right);
}

/**
 * Resolve the request's trusted proxy identity WITHOUT provisioning: the
 * proxy method must be configured, the peer trusted, and the user header
 * present (and a shape the directory could hold — the pipeline's
 * invalid-username posture). When a shared secret is configured, it is
 * required here TOO — the pipeline never runs on public paths (stage 2
 * returns before the proxy method), so these routes own the same secret
 * discipline, and the header is deleted from the request after the check
 * exactly as the pipeline would have done. Name/email ride their headers
 * when present.
 */
function resolveProxyIdentity(
	request: FastifyRequest,
	ctx: ServerContext,
): ProxyIdentity | undefined {
	if (!ctx.methods.includes("proxy")) return undefined;
	// The rejection diagnostic (proxy-trust C1): while the instance is
	// UNCLAIMED, every rejection branch reports WHY via the shared,
	// throttled warn — these routes sit on the public path the pipeline
	// never visits, so without this their proxy rejections are silent.
	// Once claimed the onboarding surface no longer needs the signal.
	const diagnose = !ctx.opened.identity.users.isClaimed();
	const { proxy } = ctx.config.auth;
	if (!ipAllowed(request.socket.remoteAddress, proxy.trustedProxies)) {
		if (diagnose) warnProxyRejected(request, ProxyRejectReason.UNTRUSTED);
		return undefined;
	}
	// C5: the same own-host discipline as the pipeline — an own-host
	// peer reached through a range without the shared secret never
	// vouches (any local process could claim the first admin).
	if (
		!ownHostPeerPermitted(
			request.socket.remoteAddress,
			proxy.trustedProxies,
			proxy.secret !== undefined && proxy.secretHeader !== undefined,
		)
	) {
		if (diagnose) warnProxyRejected(request, ProxyRejectReason.OWN_HOST);
		return undefined;
	}
	if (proxy.secret !== undefined && proxy.secretHeader !== undefined) {
		const name = proxy.secretHeader.toLowerCase();
		const presented = headerOf(request, name);
		delete request.headers[name];
		if (
			presented === undefined ||
			!timingSafeStringEqual(presented, proxy.secret)
		) {
			if (diagnose) {
				warnProxyRejected(
					request,
					ProxyRejectReason.secretReason(proxy.secretHeader),
				);
			}
			return undefined;
		}
	}
	const user = headerOf(request, proxy.userHeader);
	// An absent OR EMPTY (headerOf trims to undefined) user header is the
	// missing-header reason; a present-but-unrepresentable claim is the
	// unusable-claim reason. Neither line carries the claimed VALUE.
	if (user === undefined) {
		if (diagnose) {
			warnProxyRejected(
				request,
				ProxyRejectReason.missingHeaderReason(proxy.userHeader.toLowerCase()),
			);
		}
		return undefined;
	}
	const preview = previewProxyUser(ctx.opened.identity, user);
	if (preview === undefined) {
		if (diagnose) warnProxyRejected(request, ProxyRejectReason.UNUSABLE);
		return undefined;
	}
	const name = headerOf(request, proxy.nameHeader);
	const email = headerOf(request, proxy.emailHeader);
	return {
		...preview,
		...(name === undefined ? {} : { name }),
		...(email === undefined ? {} : { email }),
	};
}

/** The validated claim body (every field optional; the paths below pick). */
interface ClaimBody {
	readonly code?: string;
	readonly user?: string;
	readonly name?: string;
	readonly email?: string;
	readonly issueToken?: boolean;
	readonly tokenName?: string;
}

/** The failure shape of {@link validateClaimBody} (an optional field name). */
interface ClaimBodyError {
	error: string;
	field?: string;
}

/**
 * Validate the claim body strictly: unknown keys and wrong types are
 * client errors (the repo's fail-loud validator posture).
 */
function validateClaimBody(body: unknown): ClaimBody | ClaimBodyError {
	if (body === undefined) return {};
	if (typeof body !== "object" || Array.isArray(body)) {
		return { error: "invalid_body" };
	}
	const record = body as Record<string, unknown>;
	const result: {
		code?: string;
		user?: string;
		name?: string;
		email?: string;
		issueToken?: boolean;
		tokenName?: string;
	} = {};
	for (const key of Object.keys(record)) {
		const value = record[key];
		switch (key) {
			case "code":
			case "user":
			case "name":
			case "email":
			case "tokenName":
				if (typeof value !== "string") return { error: "invalid_body" };
				result[key] = value;
				break;
			case "issueToken":
				if (typeof value !== "boolean") return { error: "invalid_body" };
				result.issueToken = value;
				break;
			default:
				return { error: "invalid_field", field: key };
		}
	}
	return result;
}

/** Register the onboarding state + claim routes. */
export function registerOnboardingRoutes(
	app: FastifyInstance,
	ctx: ServerContext,
): void {
	const { identity } = ctx.opened;

	app.get("/v1/onboarding", async (request): Promise<OnboardingState> => {
		const proxyIdentity = resolveProxyIdentity(request, ctx);
		// Loopback is the trust itself; a trusted proxy identity likewise.
		const codeRequired =
			!isLoopbackHost(ctx.listenHost) && proxyIdentity === undefined;
		return {
			state: identity.users.isClaimed() ? "claimed" : "unclaimed",
			methods: ctx.methods,
			codeRequired,
			...(proxyIdentity === undefined ? {} : { proxyIdentity }),
		};
	});

	app.post("/v1/onboarding/claim", async (request, reply) => {
		const validated = validateClaimBody(request.body);
		if ("error" in validated) {
			return await reply.code(400).send(validated);
		}
		const proxyIdentity = resolveProxyIdentity(request, ctx);
		const loopback = isLoopbackHost(ctx.listenHost);
		// C2: a proxy-only non-loopback server creates accounts ONLY
		// through a proxy vouch — refuse BEFORE code evaluation, so even
		// a valid setup code or invite code cannot mint an account
		// unvouched on this posture. Mixed [proxy, token] and loopback
		// binds keep the code paths.
		if (
			requiresProxyVouch(ctx.methods, ctx.listenHost) &&
			proxyIdentity === undefined
		) {
			return await reply.code(403).send({ error: "proxy_identity_required" });
		}
		// The code's validity is evaluated ONCE, BEFORE the mutex: the winner
		// clears the setup-code file inside its critical section, so a claim
		// that loses the race must still be recognizable as having held a
		// valid code — it gets 409 `already_claimed` (the brief's "one
		// claimant wins and the rest get 409"), never a misleading 403.
		const codeWasSetup =
			validated.code !== undefined &&
			setupCodeMatches(validated.code, readSetupCode(identity.cacheDir));

		// The claim critical section: read state, decide, add — all inside
		// the one mutex, so concurrent claims cannot both pass the gate.
		const outcome = await withClaimLock(async () => {
			try {
			const claimed = identity.users.isClaimed();
			if (!claimed) {
				// The first admin: proxy headers, loopback bind, or the setup
				// code ("the first invite" — same shape, admin grant).
				let grant: DirectoryUser | { user: string; name?: string; email?: string; source: "cli" };
				if (proxyIdentity !== undefined) {
					// Body identity fields are ignored — the proxy vouched. This
					// route already holds the claim lock, so call the lock-free
					// resolver body, never the pipeline entry.
					const resolved = await provisionProxyUser(
						identity,
						proxyIdentity.subject,
						{
							...(proxyIdentity.name === undefined ? {} : { name: proxyIdentity.name }),
							...(proxyIdentity.email === undefined ? {} : { email: proxyIdentity.email }),
						},
						{ provision: true, admin: true },
					);
					if (resolved.kind === "invalid") {
						return { status: 400, error: "invalid_username" } as const;
					}
					if (resolved.kind === "not_provisioned") {
						return { status: 409, error: "already_claimed" } as const;
					}
					grant = resolved.record;
				} else if (loopback) {
					if (validated.user === undefined) return { status: 400, error: "invalid_body" } as const;
					grant = {
						user: validated.user,
						...(validated.name === undefined ? {} : { name: validated.name }),
						...(validated.email === undefined ? {} : { email: validated.email }),
						source: "cli",
					};
				} else if (codeWasSetup) {
					if (validated.user === undefined) return { status: 400, error: "invalid_body" } as const;
					grant = {
						user: validated.user,
						...(validated.name === undefined ? {} : { name: validated.name }),
						...(validated.email === undefined ? {} : { email: validated.email }),
						source: "cli",
					};
				} else {
					// Wrong or absent code where one is required.
					return { status: 403, error: "invalid_code" } as const;
				}
				if (!isUsernameKey(grant.user)) {
					return { status: 400, error: "invalid_username" } as const;
				}
				// The proxy resolver already added and linked its record.
				const record: DirectoryUser = "createdAt" in grant ? grant : await identity.users.add({
					user: grant.user,
					...(grant.name === undefined ? {} : { name: grant.name }),
					...(grant.email === undefined ? {} : { email: grant.email }),
					admin: true,
					source: grant.source,
				});
				// The setup code dies with the claim (single-shot); the
				// pinned env form re-materializes at the next unclaimed
				// boot, which no longer exists once claimed.
				await clearSetupCode(identity.cacheDir);
				// The reserved root conversation belongs to the claimant —
				// the server's first configured resource.
				const root = await ctx.opened.harness.conversation(
					ctx.rootId,
					BACKGROUND_CONTEXT,
				);
				if (root !== undefined) {
					await stampSessionOwner(root, record.user, ctx.opened);
				}
				return { status: 200, record } as const;
			}
			// Claimed: an invite code admits one more user; a codeless
			// proxy/loopback caller auto-provisions (or re-surfaces); a code
			// that WAS the setup code lost the race — 409, per the mutex
			// contract (one winner, the rest already_claimed).
			if (codeWasSetup) {
				return { status: 409, error: "already_claimed" } as const;
			}
			if (validated.code !== undefined) {
				const invite =
					validated.user === undefined
						? undefined
						: await identity.invites.redeem(validated.code, validated.user);
				if (invite === undefined) {
					return { status: 403, error: "invalid_code" } as const;
				}
				const record = await identity.users.add({
					user: validated.user!,
					...(validated.name === undefined ? {} : { name: validated.name }),
					...(validated.email === undefined ? {} : { email: validated.email }),
					admin: invite.admin,
					source: "invite",
				});
				return { status: 200, record } as const;
			}
			// Claimed + no code: only a trusted proxy identity still
			// admits (auto-provision, or the existing record back) — a
			// loopback/token caller has “nothing valid” and gets 409.
			if (proxyIdentity === undefined) {
				return { status: 409, error: "already_claimed" } as const;
			}
			const resolved = await provisionProxyUser(
				identity,
				proxyIdentity.subject,
				{
					...(proxyIdentity.name === undefined ? {} : { name: proxyIdentity.name }),
					...(proxyIdentity.email === undefined ? {} : { email: proxyIdentity.email }),
				},
				// A codeless onboarding claim has always auto-provisioned the
				// vouched identity, independent of the pipeline's policy.
				{ provision: true, admin: false },
			);
			if (resolved.kind !== "user") {
				return { status: 409, error: "already_claimed" } as const;
			}
			return { status: 200, record: resolved.record } as const;
			} catch (error) {
				if (error instanceof AdmissionRefusedError) {
					return { status: 409, error: error.code } as const;
				}
				throw error;
			}
		});

		if (outcome.status !== 200) {
			return await reply.code(outcome.status).send({ error: outcome.error });
		}
		const response: ClaimResponse = {
			user: {
				user: outcome.record.user,
				...(outcome.record.name === undefined ? {} : { name: outcome.record.name }),
				...(outcome.record.email === undefined ? {} : { email: outcome.record.email }),
				admin: outcome.record.admin,
				createdAt: outcome.record.createdAt,
				source: outcome.record.source,
			},
			...(validated.issueToken
				? {
						token: (
							await identity.tokens.create(
								validated.tokenName ?? "onboarding",
								outcome.record.user,
							)
						).token,
					}
				: {}),
		};
		// issueToken also logs the browser in: the session cookie is the
		// webui's (and the TUI attach flow's) carry-home credential.
		if (validated.issueToken && response.token !== undefined) {
			return await reply
				.code(200)
				.header(
					"set-cookie",
					buildSessionCookie(response.token, request, ctx),
				)
				.send(response);
		}
		return await reply.code(200).send(response);
	});
}
