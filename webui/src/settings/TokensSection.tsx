/**
 * The API-tokens core cove (0.4.0 follow-up Task 5): per-user bearer
 * credential management over `/v1/auth/tokens`. Per-user, never
 * admin-gated — minting is self-only server-side, and the section lists
 * only the CALLER's tokens.
 *
 * The create flow shows the minted secret ONCE (the store keeps only its
 * digest — it can never be re-read) with a copy button and two CLI
 * snippets: the env form (`SIGRUN_TOKEN=<token> sigrun attach --server
 * <origin>`) and the tui.json alternative (`{"server", "token"}` at
 * `$SIGRUN_CONFIG_DIR/tui.json`, default `~/.config/sigrun/tui.json` —
 * `defaultConfigDir` in src/cli.ts). The origin is `location.origin`:
 * the webui has no publicUrl, and the origin the user reached sigrun
 * through IS the right CLI target. After dismissal the secret is gone
 * from the DOM; re-opening shows only the list (the route never returns
 * secrets).
 *
 * Browser session records (`kind: "session"`) are the login flow's own
 * session surface, not API tokens — they are filtered out of the list.
 */

import { useEffect, useRef, useState } from "react";
import type { SigrunClient, TokenWire } from "../api";
import { copyText } from "../entries/MessageActions";
import { messageOf } from "../auth/Onboarding";

/** The once-only mint display: the secret + the CLI snippets. */
interface RevealedToken {
	/** The minted record's id (revoking its row clears the reveal). */
	readonly id: string;
	readonly token: string;
	readonly name: string;
}

/** The revoke row pending its confirmation click. */
interface PendingRevoke {
	readonly id: string;
	readonly name: string;
}

export function TokensSection(props: { readonly client: SigrunClient }) {
	const { client } = props;
	const [tokens, setTokens] = useState<readonly TokenWire[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	const [revealed, setRevealed] = useState<RevealedToken | null>(null);
	const [pendingRevoke, setPendingRevoke] = useState<PendingRevoke | null>(null);
	const [copied, setCopied] = useState(false);
	// The Copied-label reset timer: cleared on unmount (the same cleanup
	// discipline as MessageActions's copy timer).
	const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(() => {
		return () => {
			if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
		};
	}, []);

	useEffect(() => {
		let cancelled = false;
		client
			.listTokens()
			.then((list) => {
				if (!cancelled) setTokens(list);
			})
			.catch((cause: unknown) => {
				if (!cancelled) setError(messageOf(cause));
			});
		return () => {
			cancelled = true;
		};
	}, [client]);

	async function create(): Promise<void> {
		if (name.trim() === "" || busy) return;
		setBusy(true);
		setError(null);
		try {
			const minted = await client.createToken(name.trim());
			setRevealed({
				id: minted.record.id,
				token: minted.token,
				name: minted.record.name,
			});
			// The new record joins the list (the secret never rides it).
			setTokens((current) =>
				current === null ? current : [...current, minted.record],
			);
			setName("");
		} catch (cause) {
			// The name input keeps its value — the operator fixes and retries.
			setError(messageOf(cause));
		} finally {
			setBusy(false);
		}
	}

	async function revoke(id: string): Promise<void> {
		if (pendingRevoke === null || busy) return;
		setBusy(true);
		setError(null);
		try {
			await client.revokeToken(id);
			setTokens((current) =>
				current === null ? current : current.filter((token) => token.id !== id),
			);
			// Revoking the row whose secret is still on screen clears the
			// reveal too — the credential is dead; its text must not linger.
			setRevealed((current) => (current?.id === id ? null : current));
			setPendingRevoke(null);
		} catch (cause) {
			setError(messageOf(cause));
		} finally {
			setBusy(false);
		}
	}

	function copy(): void {
		if (revealed === null) return;
		copyText(revealed.token);
		setCopied(true);
		if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
		copiedTimer.current = setTimeout(() => setCopied(false), 1500);
	}

	if (tokens === null) {
		return (
			<p className="settings-note" role={error === null ? undefined : "alert"}>
				{error ?? "loading tokens…"}
			</p>
		);
	}
	// Browser sessions never list (the login flow's own surface).
	const apiTokens = tokens.filter((token) => token.kind !== "session");
	const rawOrigin =
		(globalThis as { location?: { origin?: string } }).location?.origin ?? "";
	// A no-location host (tests, exotic embeds) must not dangle
	// `--server ` with nothing: a visible placeholder beats a broken
	// snippet.
	const origin = rawOrigin === "" ? "<your sigrun URL>" : rawOrigin;
	return (
		<div className="settings-body" data-settings-section="tokens">
			<p className="settings-note">
				Bearer tokens for the CLI, scripts, and sign-in. A token is shown once
				at creation — the server stores only its digest.
			</p>
			{error !== null && <p className="settings-note" role="alert">{error}</p>}
			{revealed !== null && (
				<fieldset className="settings-field token-reveal">
					<legend className="settings-label">Token created: {revealed.name}</legend>
					<p className="settings-note">
						Copy it now — it is never shown again.
					</p>
					<code className="token-secret">{revealed.token}</code>
					<div className="settings-ext-row">
						<button
							type="button"
							className="token-copy"
							onClick={copy}
						>
							{copied ? "Copied" : "Copy"}
						</button>
						<button
							type="button"
							className="token-dismiss"
							onClick={() => setRevealed(null)}
						>
							Done
						</button>
					</div>
					<label className="settings-field">
						<span className="settings-label">CLI</span>
						<code className="token-snippet">{`SIGRUN_TOKEN=${revealed.token} sigrun attach --server ${origin}`}</code>
					</label>
					<label className="settings-field">
						<span className="settings-label">
							tui.json — $SIGRUN_CONFIG_DIR/tui.json (default
							~/.config/sigrun/tui.json)
						</span>
						<code
							className="token-snippet"
						>{`{"server": "${origin}", "token": "${revealed.token}"}`}</code>
					</label>
				</fieldset>
			)}
			{apiTokens.length === 0 && <p className="settings-note">No API tokens.</p>}
			{apiTokens.map((token) => (
				<div className="settings-ext-row" key={token.id}>
					{pendingRevoke?.id === token.id ? (
						<>
							<span className="settings-ext-key">Revoke {token.name}?</span>
							<button
								type="button"
								className="token-revoke-confirm"
								disabled={busy}
								onClick={() => void revoke(token.id)}
							>
								Confirm revoke
							</button>
							<button
								type="button"
								className="token-revoke-cancel"
								disabled={busy}
								onClick={() => setPendingRevoke(null)}
							>
								Cancel
							</button>
						</>
					) : (
						<>
							<span className="settings-ext-key">{token.name}</span>
							<button
								type="button"
								className="token-revoke"
								disabled={busy}
								onClick={() =>
									setPendingRevoke({ id: token.id, name: token.name })
								}
							>
								Revoke
							</button>
						</>
					)}
				</div>
			))}
			<div className="settings-field">
				<span className="settings-label">Create a token</span>
				<div className="settings-ext-row">
					<input
						type="text"
						className="token-name-input"
						aria-label="Token name"
						placeholder="name (e.g. laptop, ci)"
						value={name}
						onChange={(event) => setName(event.target.value)}
					/>
					<button
						type="button"
						className="token-create"
						disabled={busy || name.trim() === ""}
						onClick={() => void create()}
					>
						Create token
					</button>
				</div>
			</div>
		</div>
	);
}
