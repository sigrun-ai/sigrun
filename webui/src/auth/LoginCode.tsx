/** The setup/invite code interstitial for a parked external login. */

import { useState } from "react";
import { ApiError, type SigrunClient } from "../api";

/** Accept only a local absolute path from the JSON response. */
export function safeLoginReturn(value: string): string {
	if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
	if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return "/";
	return value;
}

export function LoginCode(props: {
	readonly client: SigrunClient;
	readonly flowKey: string;
	readonly reason: string;
	readonly navigate: (path: string) => void;
}) {
	const { client, flowKey, reason, navigate } = props;
	const [code, setCode] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function submit(): Promise<void> {
		if (code.trim() === "") {
			setError("Enter your code.");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const result = await client.submitLoginCode(flowKey, code.trim());
			navigate(safeLoginReturn(result.returnTo));
		} catch (cause) {
			if (cause instanceof ApiError && cause.error === "invalid_code") {
				setError("That code didn't work. Check it and try again.");
			} else if (cause instanceof ApiError && cause.error === "login_expired") {
				setError("This sign-in took too long or sigrun restarted. Start again.");
			} else if (cause instanceof ApiError && cause.error === "not_allowed") {
				setError("Your account isn't allowed to use this sigrun.");
			} else if (cause instanceof ApiError && (cause.error === "isolation_required" || cause.error === "auth_required")) {
				setError("This sigrun can't add another user yet. Ask the admin.");
			} else {
				setError("Sign-in failed. Try again.");
			}
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="auth-card">
			<h1>Finish signing in</h1>
			<p className="auth-message">
				{reason === "setup" ? "Enter the setup code to claim this sigrun." : "Enter your invite code to finish signing in."}
			</p>
			<label className="auth-field">
				{reason === "setup" ? "Setup code" : "Invite code"}
				<input
					data-auth-field="login-code"
					type="text"
					autoComplete="one-time-code"
					value={code}
					onChange={(event) => setCode(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							event.preventDefault();
							void submit();
						}
					}}
				/>
			</label>
			<button type="button" className="auth-submit" disabled={busy} onClick={() => void submit()}>
				{busy ? "Signing in…" : "Continue"}
			</button>
			{error !== null && <p className="auth-error" role="alert">{error}</p>}
		</div>
	);
}
