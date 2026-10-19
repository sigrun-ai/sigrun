/**
 * Login (core hardening W1 Task 8, spec §5.4): the token screen behind
 * every 401. Posts `{token}` to `POST /v1/auth/login` — the server sets
 * the `sigrun_session` cookie in that response, so success simply
 * re-probes; a wrong token surfaces the wire's error inline.
 */

import { useState } from "react";
import type { SigrunClient } from "../api";
import { messageOf } from "./Onboarding";

export function Login(props: {
	readonly client: SigrunClient;
	/** Context line ("Signed out.", "Your session ended…"), when there is one. */
	readonly message?: string;
	/** The login landed (cookie set); the gate re-probes. */
	readonly onSuccess: () => void;
}) {
	const { client, message, onSuccess } = props;
	const [token, setToken] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

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
