/**
 * Onboarding (core hardening W1 Task 8, spec §5.8): the unclaimed
 * server's first screen. A trusted proxy vouch (the boot probe's
 * `proxyIdentity`) renders a CONFIRM screen — the claim posts an empty
 * body and the headers' identity wins. Otherwise the form collects the
 * setup code (only when `codeRequired`), username, name, and email, and
 * claims with `issueToken: true, tokenName: "webui"`: the SERVER sets
 * the `sigrun_session` cookie, and the minted token in the response is
 * discarded — the webui never persists a token (spec §5.4).
 */

import { useState } from "react";
import { ApiError, type OnboardingState, type SigrunClient } from "../api";

export function Onboarding(props: {
	readonly client: SigrunClient;
	readonly state: OnboardingState;
	/** The claim landed (cookie set); the gate re-probes. */
	readonly onClaimed: () => void;
}) {
	const { client, state, onClaimed } = props;
	const [code, setCode] = useState("");
	const [user, setUser] = useState("");
	const [name, setName] = useState("");
	const [email, setEmail] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const proxy = state.proxyIdentity;

	async function claimProxyVouch(): Promise<void> {
		setBusy(true);
		setError(null);
		try {
			await client.claim({});
			onClaimed();
		} catch (cause) {
			setError(messageOf(cause));
		} finally {
			setBusy(false);
		}
	}

	async function submitForm(): Promise<void> {
		const username = user.trim();
		if (state.codeRequired && code.trim() === "") {
			setError("enter the setup code (find it in the server log)");
			return;
		}
		if (username === "") {
			setError("choose a username (lowercase letters, digits, . _ -)");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			await client.claim({
				...(state.codeRequired ? { code: code.trim() } : {}),
				user: username,
				...(name.trim() === "" ? {} : { name: name.trim() }),
				...(email.trim() === "" ? {} : { email: email.trim() }),
				issueToken: true,
				tokenName: "webui",
			});
			onClaimed();
		} catch (cause) {
			setError(messageOf(cause));
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="auth-card">
			<h1>Set up sigrun</h1>
			{proxy !== undefined ? (
				<>
					<p className="auth-message">
						Your proxy vouches for your identity. Continuing claims this
						server as:
					</p>
					<p className="auth-identity">
						<strong>{proxy.user}</strong>
						{proxy.name === undefined ? "" : ` — ${proxy.name}`}
						{proxy.email === undefined ? "" : ` · ${proxy.email}`}
					</p>
					<button
						type="button"
						className="auth-submit"
						disabled={busy}
						onClick={() => void claimProxyVouch()}
					>
						{`Continue as ${proxy.user}`}
					</button>
				</>
			) : (
				<>
					<p className="auth-message">
						Claim this server: the first user is its administrator.
					</p>
					{state.codeRequired && (
						<label className="auth-field">
							Setup code
							<input
								data-auth-field="code"
								autoComplete="one-time-code"
								value={code}
								onChange={(event) => setCode(event.target.value)}
							/>
						</label>
					)}
					<label className="auth-field">
						Username
						<input
							data-auth-field="user"
							autoComplete="username"
							value={user}
							onChange={(event) => setUser(event.target.value)}
						/>
					</label>
					<label className="auth-field">
						Name <span className="auth-optional">(optional)</span>
						<input
							data-auth-field="name"
							autoComplete="name"
							value={name}
							onChange={(event) => setName(event.target.value)}
						/>
					</label>
					<label className="auth-field">
						Email <span className="auth-optional">(optional)</span>
						<input
							data-auth-field="email"
							type="email"
							autoComplete="email"
							value={email}
							onChange={(event) => setEmail(event.target.value)}
						/>
					</label>
					<button
						type="button"
						className="auth-submit"
						disabled={busy}
						onClick={() => void submitForm()}
					>
						{busy ? "Claiming…" : "Set up sigrun"}
					</button>
				</>
			)}
			{error !== null && (
				<p className="auth-error" role="alert">
					{error}
				</p>
			)}
		</div>
	);
}

/** The user-facing spelling of a rejection: known wire codes get fixed copy;
 *  other errors retain their existing message. This proxy code is never raw. */
export function messageOf(cause: unknown): string {
	if (cause instanceof ApiError && cause.error === "proxy_identity_required") {
		return "This sigrun signs people in through its sign-in proxy. Open it through the proxy.";
	}
	if (cause instanceof ApiError && cause.error !== undefined) {
		return cause.error;
	}
	return cause instanceof Error ? cause.message : String(cause);
}
