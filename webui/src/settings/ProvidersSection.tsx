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

/** One provider row's editor state (the write-only key + a note).
 *  Drafts are keyed by `${provider}\u0000${kind ?? "chat"}`: the key field
 *  is per ROW, but the credential it writes is the shared per-id one. */
interface ProviderDraft {
	/** The typed key — write-only: never populated from any response. */
	readonly key: string;
	/** Per-provider note (write/refresh outcome / a server error). */
	readonly note?: { readonly kind: "ok" | "error"; readonly message: string };
}

/** One row's identity: provider id + kind (absent kind = "chat"). */
function rowKey(provider: string, kind?: string): string {
	return `${provider}\u0000${kind ?? "chat"}`;
}

/** The user-facing kind badge label (wire kind → plural for non-chat). */
function kindLabel(kind?: string): string {
	if (kind === "decision") return "decisions";
	if (kind === "embedding") return "embeddings";
	return "chat";
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

	/** Apply a write/refresh response's entry to the served list (the
	 *  ONE row matching its provider AND kind — siblings of other kinds
	 *  are untouched). */
	const applyEntry = (entry: AuthCheckProviderWire): void => {
		const key = rowKey(entry.provider, entry.kind);
		setLoad((prev) =>
			prev.status !== "ready"
				? prev
				: {
						status: "ready",
						providers: prev.providers.map((row) =>
							rowKey(row.provider, row.kind) === key ? entry : row,
						),
					},
		);
	};

	/** Re-fetch the report after a credential write (BEST-EFFORT): the
	 *  credential is shared per id, so every row of the id should pick up
	 *  the new state — but a failed refetch must NOT fail the write (the
	 *  PUT/DELETE already landed; the response's entry was applied). */
	const reloadProviders = async (): Promise<void> => {
		const report = await client.listProviders();
		setLoad((prev) =>
			prev.status !== "ready"
				? prev
				: { status: "ready", providers: report.providers },
		);
	};

	/** Patch one row's draft (a shallow merge keyed by the row's
	 *  `${provider}\u0000${kind}` key). */
	const patchDraft = (key: string, patch: Partial<ProviderDraft>): void => {
		setDrafts((prev) => ({
			...prev,
			[key]: { ...{ key: "" }, ...prev[key], ...patch },
		}));
	};

	/** Save the typed key (PUT, admin): the response's entry + a cleared
	 *  field. The credential is shared per id, so after the write the
	 *  report is re-fetched (best-effort) so every row of the id updates;
	 *  a failed refetch never fails the save. */
	const save = async (providerId: string, key: string): Promise<void> => {
		const draft = drafts[key];
		if (draft === undefined || draft.key === "") return;
		try {
			applyEntry(await client.putProviderCredential(providerId, draft.key));
		} catch (error: unknown) {
			// The typed key SURVIVES a failure (the operator retries); the
			// field clears on success only.
			patchDraft(key, {
				note: {
					kind: "error",
					message: error instanceof Error ? error.message : String(error),
				},
			});
			return;
		}
		// The write landed: clear the field + report success BEFORE the
		// best-effort refetch, so a refetch failure can't masquerade as a
		// failed save (or keep the plaintext key in the input).
		patchDraft(key, { key: "", note: { kind: "ok", message: "saved" } });
		try {
			await reloadProviders();
		} catch {
			// Best-effort: the entry from the PUT response is already applied;
			// the next load/refresh reconciles the sibling rows.
		}
	};

	/** Clear the credential (DELETE, admin) — the shared per-id one, so
	 *  the report is re-fetched (best-effort) and every row of the id
	 *  updates; a failed refetch never fails the clear. */
	const clear = async (providerId: string, key: string): Promise<void> => {
		try {
			applyEntry(await client.deleteProviderCredential(providerId));
		} catch (error: unknown) {
			patchDraft(key, {
				note: {
					kind: "error",
					message: error instanceof Error ? error.message : String(error),
				},
			});
			return;
		}
		patchDraft(key, { note: { kind: "ok", message: "cleared" } });
		try {
			await reloadProviders();
		} catch {
			// Best-effort: see save().
		}
	};

	/** One bounded refresh (POST — not admin-gated server-side). */
	const refresh = async (providerId: string, key: string): Promise<void> => {
		try {
			applyEntry(await client.refreshProvider(providerId));
		} catch (error: unknown) {
			patchDraft(key, {
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
				const kind = provider.kind ?? "chat";
				const key = rowKey(provider.provider, provider.kind);
				const draft: ProviderDraft = drafts[key] ?? { key: "" };
				return (
					<fieldset
						key={key}
						className="settings-provider"
						data-provider={provider.provider}
						data-kind={kind}
					>
						<legend className="settings-provider-name">
							{provider.provider}
							<span className="settings-provider-kind" data-kind={kind}>
								{kindLabel(provider.kind)}
							</span>
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
									patchDraft(key, { key: event.target.value })
								}
							/>
							<button
								type="button"
								className="settings-provider-save"
								disabled={draft.key === ""}
								onClick={() => void save(provider.provider, key)}
							>
								Save
							</button>
							<button
								type="button"
								className="settings-provider-clear"
								onClick={() => void clear(provider.provider, key)}
							>
								Clear
							</button>
							{kind === "chat" && (
								<button
									type="button"
									className="settings-provider-refresh"
									onClick={() => void refresh(provider.provider, key)}
								>
									Refresh
								</button>
							)}
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
