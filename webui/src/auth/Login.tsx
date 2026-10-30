/**
 * Login: external providers above the existing token form. The provider
 * catalog is public; a failed catalog read leaves token login available.
 * Callback errors use fixed copy, never provider-supplied text.
 */

import { useEffect, useState } from "react";
import type { LoginProviderWire, SigrunClient } from "../api";
import { messageOf } from "./Onboarding";

const LOGIN_ERRORS: Readonly<Record<string, string>> = {
	invalid_state: "That sign-in link was already used or came from another browser. Start again.",
	login_expired: "This sign-in took too long or sigrun restarted. Start again.",
	not_allowed: "Your account isn't allowed to use this sigrun.",
	isolation_required: "This sigrun can't add another user yet. Ask the admin.",
	auth_required: "This sigrun can't add another user yet. Ask the admin.",
	account_link_conflict: "That account is already linked to another sigrun user.",
	provider_error: "The sign-in provider returned an error. Try again.",
	proxy_identity_required: "This sigrun signs people in through its sign-in proxy. Open it through the proxy.",
};

/** Map only known server codes; unknown input cannot inject provider text. */
export function loginErrorCopy(code: string): string {
	return LOGIN_ERRORS[code] ?? "Sign-in failed. Try again.";
}

export function Login(props: {
	readonly client: SigrunClient;
	/** Context line ("Signed out.", "Your session ended…"), when there is one. */
	readonly message?: string;
	/** The login landed (cookie set); the gate re-probes. */
	readonly onSuccess: () => void;
}) {
	const { client, message, onSuccess } = props;
	const [token, setToken] = useState("");
	const [error, setError] = useState<string | null>(() => {
		const search = (globalThis as { location?: { search?: string } }).location?.search ?? "";
		const code = new URLSearchParams(search).get("error");
		return code === null ? null : loginErrorCopy(code);
	});
	const [busy, setBusy] = useState(false);
	const [providers, setProviders] = useState<readonly LoginProviderWire[]>([]);

	useEffect(() => {
		let cancelled = false;
		client.providers().then((response) => {
			if (!cancelled) setProviders(response.providers);
		}).catch(() => {
			// The token form remains usable without the optional provider list.
		});
		return () => { cancelled = true; };
	}, [client]);

	useEffect(() => {
		const search = (globalThis as { location?: { search?: string } }).location?.search ?? "";
		if (new URLSearchParams(search).get("error") === null) return;
		const historyApi = (globalThis as {
			history?: { replaceState(data: unknown, title: string, url: string): void };
		}).history;
		const path = (globalThis as { location?: { pathname?: string } }).location?.pathname ?? "/login";
		historyApi?.replaceState(null, "", path);
	}, []);

	async function signIn(): Promise<void> {
		if (token.trim() === "") {
			setError("paste your API token");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			await client.login(token.trim());
			onSuccess();
		} catch (cause) {
			setError(messageOf(cause));
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="auth-card">
			<h1>Sign in to sigrun</h1>
			{message !== undefined && <p className="auth-message">{message}</p>}
			{providers.length > 0 && (
				<div className="auth-providers">
					{providers.map((provider) => (
						<a
							key={provider.provider}
							className="auth-provider"
							href={`/v1/auth/login/${encodeURIComponent(provider.provider)}?return=${encodeURIComponent("/")}`}
						>
							{provider.label}
						</a>
					))}
				</div>
			)}
			<label className="auth-field">
				API token
				<input
					data-auth-field="token"
					type="password"
					autoComplete="current-password"
					value={token}
					onChange={(event) => setToken(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							event.preventDefault();
							void signIn();
						}
					}}
				/>
			</label>
			<button
				type="button"
				className="auth-submit"
				disabled={busy}
				onClick={() => void signIn()}
			>
				{busy ? "Signing in…" : "Sign in"}
			</button>
			{error !== null && (
				<p className="auth-error" role="alert">
					{error}
				</p>
			)}
		</div>
	);
}
