/**
 * AuthGate (core hardening W1 Task 8, spec §5.4/§5.8): the webui's front
 * door, wrapping {@link App}. The boot probe is `GET /v1/onboarding`
 * (public): unclaimed → the onboarding screen (spec §5.8); claimed →
 * `GET /v1/auth/whoami` proves the browser actually holds a session — a
 * 401 renders the token login screen (spec §5.4), anything else renders
 * the shell with the resolved identity.
 *
 * The 401 listener is CLIENT-wide: every §5 call flows through a proxy
 * that watches rejections, so a session revoked MID-SHELL (cookie expired,
 * token deleted server-side) flips the whole UI back to the login screen
 * on the next failed call — the spec's "the webui prompts for a token on
 * the first 401". The login/claim screens themselves sit BELOW the flip
 * (their own 401s are form errors, not session loss).
 *
 * The identity feeds the shell: the rail renders the user + a sign-out
 * action under the token method, and the sidebar's Share action gates on
 * `identity.user` matching the row's owner.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
	ApiError,
	createClient,
	type OnboardingState,
	type SigrunClient,
	type WhoamiResponse,
} from "../api";
import { App } from "../App";
import type { EventSourceFactory } from "../stream";
import { Login } from "./Login";
import { LoginCode } from "./LoginCode";
import { Onboarding } from "./Onboarding";

/** The gate's state machine: probe → onboarding | login → ready. */
type Gate =
	| { readonly status: "probing" }
	| { readonly status: "failed"; readonly message: string }
	| { readonly status: "onboarding"; readonly state: OnboardingState }
	| { readonly status: "login"; readonly message?: string }
	| { readonly status: "ready"; readonly identity: WhoamiResponse };

/** The same-origin §5 client (the AuthGate default; tests inject one). */
const defaultClient = createClient();

/**
 * Wrap a client so every method's rejection passes the 401 listener:
 * only a READY gate flips (the login screen's own 401 is a form error,
 * the onboarding claim 403s never reach here).
 */
function watchingClient(
	base: SigrunClient,
	onUnauthorized: () => void,
): SigrunClient {
	return new Proxy(base, {
		get(target, property) {
			const value = target[property as keyof SigrunClient];
			if (typeof value !== "function") return value;
			return (...args: unknown[]) =>
				Promise.resolve()
					.then(() =>
						(value as (...callArgs: unknown[]) => unknown).apply(target, args),
					)
					.catch((cause: unknown) => {
						if (cause instanceof ApiError && cause.status === 401) {
							onUnauthorized();
						}
						throw cause;
					});
		},
	}) as SigrunClient;
}

export interface AuthGateOptions {
	/** Injected for tests; defaults to the same-origin §5 client. */
	readonly client?: SigrunClient;
	/** Injected for tests; defaults to the browser's native EventSource. */
	readonly createEventSource?: EventSourceFactory;
}

export function AuthGate(options: AuthGateOptions = {}) {
	const [gate, setGate] = useState<Gate>({ status: "probing" });
	// The probe nonce: claim/login/logout completion re-runs the boot probe
	// (one code path decides onboarding vs login vs ready, always fresh).
	const [probeNonce, setProbeNonce] = useState(0);

	const flipToLogin = useCallback(() => {
		setGate((current) =>
			current.status === "ready"
				? {
						status: "login",
						message: "Your session ended. Sign in again.",
					}
				: current,
		);
	}, []);

	const client = useMemo(
		() => watchingClient(options.client ?? defaultClient, flipToLogin),
		[options.client, flipToLogin],
	);

	useEffect(() => {
		let cancelled = false;
		void (async () => {
			try {
				const onboarding = await client.getOnboarding();
				if (cancelled) return;
				if (onboarding.state === "unclaimed") {
					setGate({ status: "onboarding", state: onboarding });
					return;
				}
				const identity = await client.whoami();
				if (cancelled) return;
				setGate({ status: "ready", identity });
			} catch (cause) {
				if (cancelled) return;
				if (cause instanceof ApiError && cause.status === 401) {
					setGate({ status: "login" });
					return;
				}
				setGate({
					status: "failed",
					message:
						cause instanceof Error ? cause.message : String(cause),
				});
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [client, probeNonce]);

	if (gate.status === "probing") {
		return (
			<div className="app-boot" data-auth-screen="probing">
				<p>sigrun — signing in…</p>
			</div>
		);
	}
	if (gate.status === "failed") {
		return (
			<div className="app-refused" role="alert" data-auth-screen="failed">
				<h1>sigrun — auth check failed</h1>
				<p>{gate.message}</p>
				<button type="button" onClick={() => setProbeNonce((n) => n + 1)}>
					Retry
				</button>
			</div>
		);
	}
	const location = (globalThis as { location?: { pathname?: string; search?: string; href?: string } }).location;
	if (location?.pathname === "/login/code") {
		const params = new URLSearchParams(location.search ?? "");
		const key = params.get("key");
		if (key !== null) {
			return (
				<div className="auth-screen" data-auth-screen="login-code">
					<LoginCode
						client={client}
						flowKey={key}
						reason={params.get("reason") ?? "invite"}
						navigate={(path) => {
							if (location.href !== undefined) location.href = path;
						}}
					/>
				</div>
			);
		}
	}
	if (gate.status === "onboarding") {
		return (
			<div className="auth-screen" data-auth-screen="onboarding">
				<Onboarding
					client={client}
					state={gate.state}
					onClaimed={() => setProbeNonce((n) => n + 1)}
				/>
			</div>
		);
	}
	if (gate.status === "login") {
		return (
			<div className="auth-screen" data-auth-screen="login">
				<Login
					client={client}
					message={gate.message}
					onSuccess={() => setProbeNonce((n) => n + 1)}
				/>
			</div>
		);
	}
	return (
		<App
			client={client}
			createEventSource={options.createEventSource}
			identity={gate.identity}
			onLogout={() => setGate({ status: "login", message: "Signed out." })}
		/>
	);
}
