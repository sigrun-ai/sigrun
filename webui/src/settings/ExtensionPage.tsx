import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormBlock, JsonObject, SurfaceLoad, Tree } from "@sigrun/shared/blocks";
import type {
	AuthCheckProviderWire,
	ExtensionInfoWire,
	SettingsSectionEntryWire,
	SigrunClient,
} from "../api";
import { createExtTransport } from "../blocks/extTransport";
import { SurfaceView } from "../blocks/SurfaceView";
import { ProviderCredential } from "./ProviderCredential";

/** Give the generated form a default Save label. Its generated Credentials
 * section stays inside the page's Settings section, after provider auth.json
 * credentials, preserving one save unit for schema-declared fields. */
function withSaveLabel(tree: Tree | undefined): Tree | undefined {
	if (tree === undefined || tree.root.type !== "form") return tree;
	const root = tree.root as FormBlock;
	return { ...tree, root: { ...root, submitLabel: root.submitLabel ?? "Save" } };
}

function ExtensionSurface(props: {
	readonly client: SigrunClient;
	readonly section: SettingsSectionEntryWire;
	readonly onData: (data: JsonObject) => void;
}): React.ReactElement {
	const { client, section, onData } = props;
	const transport = useMemo(() => {
		const base = createExtTransport({ slug: section.slug, id: section.id, fetch: client.rawFetch });
		return {
			...base,
			async load(): Promise<SurfaceLoad> {
				const loaded = await base.load();
				onData(loaded.data);
				return { ...loaded, tree: withSaveLabel(loaded.tree) ?? loaded.tree };
			},
		};
	}, [client, section.slug, section.id, onData]);
	return <SurfaceView transport={transport} />;
}

/** One loaded extension's status, credentials, shared settings, personal
 * settings, and read-only stored JSON on a single scrolling page. Provider
 * pages add locality and a read-only, per-kind model inventory. */
export function ExtensionPage(props: {
	readonly client: SigrunClient;
	readonly extension: ExtensionInfoWire;
	readonly sections: readonly SettingsSectionEntryWire[];
	readonly admin: boolean;
	/** "mine" draws only Your settings; "system" draws administration. */
	readonly group?: "mine" | "system";
}): React.ReactElement {
	const { client, extension, sections, admin, group = "system" } = props;
	const [providers, setProviders] = useState<readonly AuthCheckProviderWire[]>([]);
	const [stored, setStored] = useState<Record<string, unknown>>({});
	const [unknownKeys, setUnknownKeys] = useState<readonly string[]>([]);
	const [loadError, setLoadError] = useState<string>();
	const providerPage = extension.provider === true || extension.name === "core";
	const ownedByPage = useCallback((provider: AuthCheckProviderWire): boolean =>
		extension.name === "core" ? provider.owner === undefined : provider.owner === extension.name,
	[extension.name]);
	const refreshProviders = useCallback((): void => {
		client.listProviders()
			.then((response) => setProviders(response.providers.filter(ownedByPage)))
			.catch(() => { /* The write landed; the next page load reconciles. */ });
	}, [client, ownedByPage]);
	const shared = sections.find((section) => section.id === "settings");
	const personal = sections.find((section) => section.id === "user-settings");
	const handleData = useCallback((data: JsonObject): void => {
		const keys = data.unknownKeys;
		if (Array.isArray(keys)) setUnknownKeys(keys.filter((key): key is string => typeof key === "string"));
	}, []);
	const ignoreData = useCallback(() => {}, []);

	useEffect(() => {
		let cancelled = false;
		setProviders([]);
		setStored({});
		setUnknownKeys([]);
		setLoadError(undefined);
		if (group === "system") {
			client.listProviders()
				.then((response) => { if (!cancelled) setProviders(response.providers.filter(ownedByPage)); })
				.catch((cause: unknown) => { if (!cancelled) setLoadError(cause instanceof Error ? cause.message : String(cause)); });
		}
		if (group === "system" && admin && extension.name !== "core") {
			client.getExtensionSettings(extension.name)
				.then((response) => { if (!cancelled) setStored(response.settings); })
				.catch((cause: unknown) => { if (!cancelled) setLoadError(cause instanceof Error ? cause.message : String(cause)); });
		}
		return () => { cancelled = true; };
	}, [client, extension.name, admin, shared, group, ownedByPage]);

	const credentials = providers.filter((provider, index) =>
		providers.findIndex((candidate) => candidate.provider === provider.provider) === index,
	);
	const declared = shared !== undefined || personal !== undefined;
	const visibleUnknownKeys = declared ? unknownKeys : Object.keys(stored);
	const systemPage = group === "system";
	const locality = providers.length > 0 && providers.every((provider) => provider.local === true);
	const toggleLocality = async (local: boolean): Promise<void> => {
		try {
			await client.setProviderLocal(extension.name, local);
			refreshProviders();
			setLoadError(undefined);
		} catch (cause: unknown) {
			setLoadError(cause instanceof Error ? cause.message : String(cause));
		}
	};
	return (
		<div className="settings-body settings-extension-page" data-extension-page={extension.name}>
			{systemPage && (
				<header className="settings-extension-header">
					<h2>{extension.title ?? extension.name}</h2>
					<span className="settings-ext-meta">
						{extension.version === undefined ? "" : `v${extension.version} · `}{extension.status}
						{providers.map((provider) => ` · ${provider.provider}: ${provider.status}`).join("")}
					</span>
				</header>
			)}
			{loadError !== undefined && <p className="settings-note" role="alert">{loadError}</p>}
			{systemPage && !declared && !providerPage && <p className="settings-note">This extension doesn't describe its settings.</p>}
			{!systemPage && personal === undefined && <p className="settings-note">This extension doesn't describe its settings.</p>}
			{systemPage && admin && providerPage && (
				<section data-extension-part="locality" aria-label="Locality">
					<label className="settings-field settings-checkbox">
						<input type="checkbox" className="settings-provider-local" checked={locality} onChange={(event) => void toggleLocality(event.target.checked)} />
						<span className="settings-label">Runs locally</span>
					</label>
				</section>
			)}
			{systemPage && admin && providers.length > 0 && providerPage && (
				<section data-extension-part="models" aria-label="Models">
					<h3>Models</h3>
					{(["chat", "decision", "embedding"] as const).map((kind) => {
						const rows = providers.filter((provider) => (provider.kind ?? "chat") === kind);
						if (rows.length === 0) return null;
						return (
							<div key={kind} data-model-kind={kind}>
								<h4>{kind}</h4>
								<ul>{rows.flatMap((provider) => (provider.modelIds ?? []).map((model) => <li key={`${provider.provider}/${model}`}>{provider.provider}/{model}</li>))}</ul>
							</div>
						);
					})}
				</section>
			)}
			{systemPage && admin && extension.name !== "core" && credentials.length > 0 && (
				<section className="settings-extension-credentials" data-extension-part="credentials">
					<h3>Credentials</h3>
					{credentials.map((provider) => (
						<ProviderCredential key={provider.provider} client={client} provider={provider} onChange={() => refreshProviders()} />
					))}
				</section>
			)}
			{systemPage && admin && shared !== undefined && (
				<section data-extension-part="settings" aria-label="Settings">
					<h3>Settings</h3>
					<ExtensionSurface key={`${shared.slug}/${shared.id}`} client={client} section={shared} onData={handleData} />
				</section>
			)}
			{!systemPage && personal !== undefined && (
				<section data-extension-part="user-settings" aria-label="Your settings">
					<h3>Your settings</h3>
					<ExtensionSurface key={`${personal.slug}/${personal.id}`} client={client} section={personal} onData={ignoreData} />
				</section>
			)}
			{systemPage && admin && extension.name !== "core" && (
				<details className="settings-extension-advanced" data-extension-part="advanced">
					<summary>Advanced</summary>
					{visibleUnknownKeys.length > 0 && <p className="settings-note">{visibleUnknownKeys.join(", ")} — not in this version's settings</p>}
					<pre>{JSON.stringify(stored, null, 2)}</pre>
				</details>
			)}
		</div>
	);
}
