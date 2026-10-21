/**
 * The Providers settings section (release 0.1 Task 2b, spec §7.6): the
 * per-provider readiness report (`GET /v1/providers`) with a WRITE-ONLY
 * credential field per provider — Save PUTs `{apiKey}` (admin), Clear
 * DELETEs it (admin), Refresh POSTs the one bounded refresh. The API
 * never returns key material, so the input starts empty, no stored
 * value exists to show, and a successful save clears the field. Every
 * write/refresh response carries the provider's entry, so the badge and
 * count update from the server's own derivation — never a client guess.
 *
 * Admin gating is by VISIBILITY: a known non-admin session never sees
 * the section (SettingsPanel hides it). The server 403s the writes for
 * a non-admin regardless — a failed save surfaces that error instead of
 * pretending success, so the client never claims a write the server
 * refused.
 *
 * The section lives in its own file (the first split-out section): the
 * panel keeps its hardcoded-sections posture — extension-registered
 * sections remain a recorded future spec, so there is no registry here
 * either, just a component the panel renders.
 */

import { useEffect, useState } from "react";
import type { AuthCheckProviderWire, SigrunClient } from "../api";

/** One provider row's editor state (the write-only key + a note). */
interface ProviderDraft {
	/** The typed key — write-only: never populated from any response. */
	readonly key: string;
	/** Per-provider note (write/refresh outcome / a server error). */
	readonly note?: { readonly kind: "ok" | "error"; readonly message: string };
}

type LoadState =
	| { readonly status: "loading" }
	| { readonly status: "error"; readonly message: string }
	| { readonly status: "ready"; readonly providers: readonly AuthCheckProviderWire[] };

export function ProvidersSection(props: { readonly client: SigrunClient }) {
	const { client } = props;
	const [load, setLoad] = useState<LoadState>({ status: "loading" });
	const [drafts, setDrafts] = useState<Record<string, ProviderDraft>>({});

	useEffect(() => {
		let cancelled = false;
		client
			.listProviders()
			.then((report) => {
				if (cancelled) return;
				setLoad({ status: "ready", providers: report.providers });
			})
			.catch((error: unknown) => {
				if (cancelled) return;
				setLoad({
					status: "error",
					message: error instanceof Error ? error.message : String(error),
				});
			});
		return () => {
			cancelled = true;
		};
	}, [client]);

	/** Apply a write/refresh response's entry to the served list (one row). */
	const applyEntry = (entry: AuthCheckProviderWire): void => {
		setLoad((prev) =>
			prev.status !== "ready"
				? prev
				: {
						status: "ready",
						providers: prev.providers.map((row) =>
							row.provider === entry.provider ? entry : row,
						),
					},
		);
	};

	/** Patch one provider's draft (a shallow per-id merge). */
	const patchDraft = (id: string, patch: Partial<ProviderDraft>): void => {
		setDrafts((prev) => ({
			...prev,
			[id]: { ...{ key: "" }, ...prev[id], ...patch },
		}));
	};

	/** Save the typed key (PUT, admin): the response's entry + a cleared field. */
	const save = async (id: string): Promise<void> => {
		const draft = drafts[id];
		if (draft === undefined || draft.key === "") return;
		try {
			applyEntry(await client.putProviderCredential(id, draft.key));
			patchDraft(id, { key: "", note: { kind: "ok", message: "saved" } });
		} catch (error: unknown) {
			// The typed key SURVIVES a failure (the operator retries); the
			// field clears on success only.
			patchDraft(id, {
				note: {
					kind: "error",
					message: error instanceof Error ? error.message : String(error),
				},
			});
		}
	};

	/** Clear the credential (DELETE, admin). */
	const clear = async (id: string): Promise<void> => {
		try {
			applyEntry(await client.deleteProviderCredential(id));
			patchDraft(id, { note: { kind: "ok", message: "cleared" } });
		} catch (error: unknown) {
			patchDraft(id, {
				note: {
					kind: "error",
					message: error instanceof Error ? error.message : String(error),
				},
			});
		}
	};

	/** One bounded refresh (POST — not admin-gated server-side). */
	const refresh = async (id: string): Promise<void> => {
		try {
			applyEntry(await client.refreshProvider(id));
		} catch (error: unknown) {
			patchDraft(id, {
				note: {
					kind: "error",
					message: error instanceof Error ? error.message : String(error),
				},
			});
		}
	};

	if (load.status === "loading") {
		return <p className="settings-note">loading providers…</p>;
	}
	if (load.status === "error") {
		return (
			<p className="settings-note" role="alert">
				{load.message}
			</p>
		);
	}
	if (load.providers.length === 0) {
		return (
			<div className="settings-body">
				<p className="settings-note">no providers are loaded</p>
			</div>
		);
	}
	return (
		<div className="settings-body settings-provider-list">
			<p className="settings-note">
				readiness and credentials per provider — the key field is
				write-only (the server never returns it); saving applies
				immediately, no restart
			</p>
			{load.providers.map((provider) => {
				const draft: ProviderDraft = drafts[provider.provider] ?? { key: "" };
				return (
					<fieldset
						key={provider.provider}
						className="settings-provider"
						data-provider={provider.provider}
					>
						<legend className="settings-provider-name">
							{provider.provider}
							<span
								className="settings-provider-status"
								data-status={provider.status}
							>
								{provider.status}
							</span>
							<span className="settings-provider-meta">
								{provider.models} model{provider.models === 1 ? "" : "s"}
							</span>
						</legend>
						{provider.detail !== undefined && (
							<p className="settings-note">{provider.detail}</p>
						)}
						<div className="settings-provider-row">
							<input
								type="password"
								className="settings-provider-key"
								placeholder="api key"
								value={draft.key}
								autoComplete="off"
								onChange={(event) =>
									patchDraft(provider.provider, { key: event.target.value })
								}
							/>
							<button
								type="button"
								className="settings-provider-save"
								disabled={draft.key === ""}
								onClick={() => void save(provider.provider)}
							>
								Save
							</button>
							<button
								type="button"
								className="settings-provider-clear"
								onClick={() => void clear(provider.provider)}
							>
								Clear
							</button>
							<button
								type="button"
								className="settings-provider-refresh"
								onClick={() => void refresh(provider.provider)}
							>
								Refresh
							</button>
							{draft.note !== undefined && (
								<span
									className="settings-note"
									role={draft.note.kind === "ok" ? "status" : "alert"}
								>
									{draft.note.message}
								</span>
							)}
						</div>
					</fieldset>
				);
			})}
		</div>
	);
}
