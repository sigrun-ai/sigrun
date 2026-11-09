import { useState } from "react";
import type { AuthCheckProviderWire, SigrunClient } from "../api";

/** One provider's auth.json key editor. Keys are write-only; a successful
 * save clears the input, while a rejected save keeps it for retry. */
export function ProviderCredential(props: {
	readonly client: SigrunClient;
	readonly provider: AuthCheckProviderWire;
	readonly onChange?: (provider: AuthCheckProviderWire) => void;
}): React.ReactElement {
	const { client, provider, onChange } = props;
	const [key, setKey] = useState("");
	const [note, setNote] = useState<{ kind: "ok" | "error"; message: string }>();
	const apply = (next: AuthCheckProviderWire): void => onChange?.(next);
	const error = (cause: unknown): void => setNote({
		kind: "error",
		message: cause instanceof Error ? cause.message : String(cause),
	});
	const save = async (): Promise<void> => {
		if (key === "") return;
		try {
			apply(await client.putProviderCredential(provider.provider, key));
			setKey("");
			setNote({ kind: "ok", message: "saved" });
		} catch (cause: unknown) { error(cause); }
	};
	const clear = async (): Promise<void> => {
		try {
			apply(await client.deleteProviderCredential(provider.provider));
			setNote({ kind: "ok", message: "cleared" });
		} catch (cause: unknown) { error(cause); }
	};
	const refresh = async (): Promise<void> => {
		try { apply(await client.refreshProvider(provider.provider)); }
		catch (cause: unknown) { error(cause); }
	};
	return (
		<fieldset className="settings-provider" data-provider={provider.provider}>
			<legend className="settings-provider-name">
				{provider.provider}
				<span className="settings-provider-status" data-status={provider.status}>{provider.status}</span>
				<span className="settings-provider-meta">{provider.models} model{provider.models === 1 ? "" : "s"}</span>
			</legend>
			{provider.detail !== undefined && <p className="settings-note">{provider.detail}</p>}
			<div className="settings-provider-row">
				<input
					type="password"
					className="settings-provider-key"
					placeholder="api key"
					aria-label={`${provider.provider} api key`}
					value={key}
					autoComplete="off"
					onChange={(event) => setKey(event.target.value)}
				/>
				<button type="button" className="settings-provider-save" disabled={key === ""} onClick={() => void save()}>Save</button>
				<button type="button" className="settings-provider-clear" onClick={() => void clear()}>Clear</button>
				<button type="button" className="settings-provider-refresh" onClick={() => void refresh()}>Refresh</button>
				{note !== undefined && <span className="settings-note" role={note.kind === "ok" ? "status" : "alert"}>{note.message}</span>}
			</div>
		</fieldset>
	);
}
