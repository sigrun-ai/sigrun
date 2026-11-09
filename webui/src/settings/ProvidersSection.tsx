import { useEffect, useState } from "react";
import type { AuthCheckProviderWire, SigrunClient } from "../api";

/** The user-facing kind badge label (wire kind → plural for non-chat). */
function kindLabel(kind?: string): string {
	if (kind === "decision") return "decisions";
	if (kind === "embedding") return "embeddings";
	return "chat";
}

/** Provider readiness in one compact list. Credentials and provider-specific
 * settings live on the owning extension's page (the kind rows here link to
 * it — main's per-row key editor moved there with this rework). */
export function ProvidersSection(props: {
	readonly client: SigrunClient;
	readonly pageOwners: ReadonlySet<string>;
	readonly onOpenPage: (owner: string) => void;
}): React.ReactElement {
	const { client, pageOwners, onOpenPage } = props;
	const [providers, setProviders] = useState<readonly AuthCheckProviderWire[]>();
	const [error, setError] = useState<string>();
	const [refreshError, setRefreshError] = useState<string>();

	useEffect(() => {
		let cancelled = false;
		client.listProviders()
			.then((response) => { if (!cancelled) setProviders(response.providers); })
			.catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); });
		return () => { cancelled = true; };
	}, [client]);

	const refresh = async (provider: AuthCheckProviderWire): Promise<void> => {
		try {
			const next = await client.refreshProvider(provider.provider);
			setProviders((current) => current?.map((row) => row.provider === next.provider && row.kind === next.kind ? next : row));
			setRefreshError(undefined);
		} catch (cause: unknown) {
			setRefreshError(cause instanceof Error ? cause.message : String(cause));
		}
	};

	if (error !== undefined) return <p className="settings-note" role="alert">{error}</p>;
	if (providers === undefined) return <p className="settings-note">loading providers…</p>;
	if (providers.length === 0) return <div className="settings-body"><p className="settings-note">no providers are loaded</p></div>;
	return (
		<div className="settings-body settings-provider-list">
			{refreshError !== undefined && <p className="settings-note" role="alert">{refreshError}</p>}
			{providers.map((provider) => {
				const linked = provider.owner !== undefined && pageOwners.has(provider.owner);
				return (
					<fieldset key={`${provider.kind ?? "chat"}/${provider.provider}`} className="settings-provider" data-provider={provider.provider}>
						<legend className="settings-provider-name">
							{provider.provider}
							<span className="settings-provider-meta">{kindLabel(provider.kind)}</span>
							<span className="settings-provider-status" data-status={provider.status}>{provider.status}</span>
							<span className="settings-provider-meta">{provider.models} model{provider.models === 1 ? "" : "s"}</span>
						</legend>
						{provider.detail !== undefined && <p className="settings-note">{provider.detail}</p>}
						<div className="settings-provider-row">
							{linked && (
								<button
									type="button"
									className="settings-provider-page-link"
									data-owner={provider.owner}
									onClick={() => onOpenPage(provider.owner!)}
								>
									{provider.owner}
								</button>
							)}
							<button type="button" className="settings-provider-refresh" onClick={() => void refresh(provider)}>Refresh</button>
						</div>
					</fieldset>
				);
			})}
		</div>
	);
}
