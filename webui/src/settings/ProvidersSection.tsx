import { useEffect, useMemo, useState } from "react";
import type { AuthCheckProviderWire, ExtensionInfoWire, SigrunClient } from "../api";
import { createExtTransport } from "../blocks/extTransport";
import { SurfaceView } from "../blocks/SurfaceView";

/** The user-facing kind label; an absent wire kind is chat. */
function kindLabel(kind?: string): string {
	if (kind === "decision") return "decisions";
	if (kind === "embedding") return "embeddings";
	return "chat";
}

/** One provider extension and every kind it contributes. */
interface ProviderOwner {
	readonly slug: string;
	readonly title: string;
	readonly rows: readonly AuthCheckProviderWire[];
}

/** Group rows by their owning extension. Ownerless env providers share the
 * reserved core pseudo-slug and one display row. */
function providerOwners(
	providers: readonly AuthCheckProviderWire[],
	extensions: readonly ExtensionInfoWire[],
): readonly ProviderOwner[] {
	const groups = new Map<string, AuthCheckProviderWire[]>();
	for (const provider of providers) {
		const slug = provider.owner ?? "core";
		groups.set(slug, [...(groups.get(slug) ?? []), provider]);
	}
	return [...groups].map(([slug, rows]) => ({
		slug,
		title: slug === "core"
			? "Default provider (environment)"
			: extensions.find((extension) => extension.name === slug)?.title ?? slug,
		rows,
	}));
}

/** The core providers form stays the same core/providers surface (saveCore),
 * with extension rows below it instead of a second settings-write path. */
export function ProvidersSection(props: {
	readonly client: SigrunClient;
	readonly extensions: readonly ExtensionInfoWire[];
	readonly onOpenPage: (owner: string) => void;
}): React.ReactElement {
	const { client, extensions, onOpenPage } = props;
	const [providers, setProviders] = useState<readonly AuthCheckProviderWire[]>();
	const [error, setError] = useState<string>();
	const [refreshError, setRefreshError] = useState<string>();
	const transport = useMemo(() => createExtTransport({ slug: "core", id: "providers", fetch: client.rawFetch }), [client]);

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
			setProviders((current) => current?.map((row) => row.provider === next.provider && (row.kind ?? "chat") === (next.kind ?? "chat") ? next : row));
			setRefreshError(undefined);
		} catch (cause: unknown) {
			setRefreshError(cause instanceof Error ? cause.message : String(cause));
		}
	};

	return (
		<div className="settings-body settings-provider-list">
			<SurfaceView transport={transport} />
			{error !== undefined && <p className="settings-note" role="alert">{error}</p>}
			{refreshError !== undefined && <p className="settings-note" role="alert">{refreshError}</p>}
			{providers === undefined && error === undefined && <p className="settings-note">loading providers…</p>}
			{providers?.length === 0 && <p className="settings-note">no providers are loaded</p>}
			{providers !== undefined && providerOwners(providers, extensions).map((owner) => (
				<fieldset key={owner.slug} className="settings-provider-owner" data-provider-owner={owner.slug}>
					<legend>
						<button type="button" className="settings-provider-page-link" data-owner={owner.slug} onClick={() => onOpenPage(owner.slug)}>{owner.title}</button>
					</legend>
					{owner.rows.map((provider) => {
						const kind = provider.kind ?? "chat";
						return (
							<div key={`${kind}/${provider.provider}`} className="settings-provider" data-provider={provider.provider} data-kind={kind}>
								<span className="settings-provider-name">{provider.provider}</span>
								<span className="settings-provider-kind">{kindLabel(provider.kind)}</span>
								<span className="settings-provider-status" data-status={provider.status}>{provider.status}</span>
								<span className="settings-provider-meta">{provider.models} model{provider.models === 1 ? "" : "s"}</span>
								{kind === "chat" && owner.slug !== "core" && <button type="button" className="settings-provider-refresh" data-provider={provider.provider} onClick={() => void refresh(provider)}>Refresh</button>}
								{provider.detail !== undefined && <p className="settings-note">{provider.detail}</p>}
							</div>
						);
					})}
				</fieldset>
			))}
		</div>
	);
}
