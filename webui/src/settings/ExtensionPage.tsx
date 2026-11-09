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

/** Keep the generated form one save unit, but group its non-secret fields
 * under the page's Settings heading; its Credentials section stays first. */
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
 * settings, and read-only stored JSON on a single scrolling page. */
export function ExtensionPage(props: {
	readonly client: SigrunClient;
	readonly extension: ExtensionInfoWire;
	readonly sections: readonly SettingsSectionEntryWire[];
	readonly admin: boolean;
}): React.ReactElement {
	const { client, extension, sections, admin } = props;
	const [providers, setProviders] = useState<readonly AuthCheckProviderWire[]>([]);
	const [stored, setStored] = useState<Record<string, unknown>>({});
	const [unknownKeys, setUnknownKeys] = useState<readonly string[]>([]);
	const [loadError, setLoadError] = useState<string>();
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
		client.listProviders()
			.then((response) => {
				if (!cancelled) setProviders(response.providers.filter((provider) => provider.owner === extension.name));
			})
			.catch((cause: unknown) => {
				if (!cancelled) setLoadError(cause instanceof Error ? cause.message : String(cause));
			});
		if (admin) {
			client.getExtensionSettings(extension.name)
				.then((response) => { if (!cancelled) setStored(response.settings); })
				.catch((cause: unknown) => {
					if (!cancelled) setLoadError(cause instanceof Error ? cause.message : String(cause));
				});
		}
		return () => { cancelled = true; };
	}, [client, extension.name, admin, shared]);

	const owned = providers.filter((provider) => provider.kind !== "decision");
	const declared = shared !== undefined || personal !== undefined;
	return (
		<div className="settings-body settings-extension-page" data-extension-page={extension.name}>
			<header className="settings-extension-header">
				<h2>{extension.name}</h2>
				<span className="settings-ext-meta">
					{extension.version === undefined ? "" : `v${extension.version} · `}{extension.status}
					{providers.map((provider) => ` · ${provider.provider}: ${provider.status}`).join("")}
				</span>
			</header>
			{loadError !== undefined && <p className="settings-note" role="alert">{loadError}</p>}
			{!declared && <p className="settings-note">This extension doesn't describe its settings.</p>}
			{admin && owned.length > 0 && (
				<section className="settings-extension-credentials" data-extension-part="credentials">
					<h3>Credentials</h3>
					{owned.map((provider) => (
						<ProviderCredential
							key={`${provider.kind ?? "chat"}/${provider.provider}`}
							client={client}
							provider={provider}
							onChange={(next) => setProviders((current) => current.map((row) => row.provider === next.provider && row.kind === next.kind ? next : row))}
						/>
					))}
				</section>
			)}
			{admin && shared !== undefined && (
				<section data-extension-part="settings" aria-label="Settings">
					<h3>Settings</h3>
					<ExtensionSurface client={client} section={shared} onData={handleData} />
				</section>
			)}
			{personal !== undefined && (
				<section data-extension-part="user-settings" aria-label="Your settings">
					<h3>Your settings</h3>
					<ExtensionSurface client={client} section={personal} onData={ignoreData} />
				</section>
			)}
			{admin && (
				<details className="settings-extension-advanced" data-extension-part="advanced">
					<summary>Advanced</summary>
					{unknownKeys.length > 0 && (
						<p className="settings-note">{unknownKeys.join(", ")} — not in this version's settings</p>
					)}
					<pre>{JSON.stringify(stored, null, 2)}</pre>
				</details>
			)}
		</div>
	);
}
