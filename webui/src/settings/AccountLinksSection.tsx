/** Per-user external account links (the U4 Account links core cove). */

import { useEffect, useState } from "react";
import type { AccountLinkWire, LoginProviderWire, SigrunClient } from "../api";
import { messageOf } from "../auth/Onboarding";

export function AccountLinksSection(props: { readonly client: SigrunClient }) {
	const { client } = props;
	const [accounts, setAccounts] = useState<readonly AccountLinkWire[] | null>(null);
	const [providers, setProviders] = useState<readonly LoginProviderWire[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		Promise.all([client.accounts(), client.providers()]).then(([links, catalog]) => {
			if (cancelled) return;
			setAccounts(links.accounts);
			setProviders(catalog.providers);
		}).catch((cause: unknown) => {
			if (!cancelled) setError(messageOf(cause));
		});
		return () => { cancelled = true; };
	}, [client]);

	async function remove(account: AccountLinkWire): Promise<void> {
		setBusy(`${account.provider}\u0000${account.subject}`);
		setError(null);
		try {
			await client.removeAccount(account.provider, account.subject);
			setAccounts((current) => current?.filter((candidate) =>
				candidate.provider !== account.provider || candidate.subject !== account.subject,
			) ?? null);
		} catch (cause) {
			setError(messageOf(cause));
		} finally {
			setBusy(null);
		}
	}

	if (error !== null) return <p className="settings-note" role="alert">{error}</p>;
	if (accounts === null) return <p className="settings-note">loading account links…</p>;
	return (
		<div className="settings-body" data-settings-section="accounts">
			<p className="settings-note">External identities linked to your sigrun account.</p>
			{accounts.length === 0 && <p className="settings-note">No account links.</p>}
			{accounts.map((account) => (
				<div className="settings-ext-row" key={`${account.provider}\u0000${account.subject}`}>
					<span className="settings-ext-key">
						{providers.find((provider) => provider.provider === account.provider)?.label ?? account.provider}
						{" · "}{account.subject}
					</span>
					<button
						type="button"
						className="account-remove"
						disabled={busy !== null}
						onClick={() => void remove(account)}
					>
						Remove
					</button>
				</div>
			))}
			{providers.length > 0 && (
				<div className="settings-field">
					<span className="settings-label">Connect an account</span>
					{providers.map((provider) => (
						<a
							key={provider.provider}
							className="account-connect"
							href={`/v1/auth/login/${encodeURIComponent(provider.provider)}?link=1&return=${encodeURIComponent("/settings?section=accounts")}`}
						>
							Connect
						</a>
					))}
				</div>
			)}
		</div>
	);
}
