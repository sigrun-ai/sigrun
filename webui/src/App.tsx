import { useEffect, useState } from "react";
import { createClient, type MetaResponse } from "./api";

/**
 * The M2 webui scaffold smoke surface (Task 20): the sigrun wordmark plus the
 * `/v1/meta` badges — enough to prove the bundle serves and the §5 client
 * works end to end. The real UI arrives with the later M2 tasks; the thin
 * hand-rolled style follows the mockup's direction (no CSS framework).
 */

const client = createClient();

const badgeStyle: React.CSSProperties = {
	display: "inline-block",
	margin: "0 0.5rem 0.5rem 0",
	padding: "0.25rem 0.6rem",
	border: "1px solid #444",
	borderRadius: "0.4rem",
	fontFamily: "monospace",
	fontSize: "0.85rem",
};

function Badge(props: { label: string; value: string }) {
	return (
		<span style={badgeStyle}>
			{props.label}: {props.value}
		</span>
	);
}

export function App() {
	const [meta, setMeta] = useState<MetaResponse | undefined>(undefined);
	const [error, setError] = useState<string | undefined>(undefined);

	useEffect(() => {
		let cancelled = false;
		client.getMeta().then(
			(loaded) => {
				if (!cancelled) setMeta(loaded);
			},
			(cause: unknown) => {
				if (!cancelled) {
					setError(cause instanceof Error ? cause.message : String(cause));
				}
			},
		);
		return () => {
			cancelled = true;
		};
	}, []);

	return (
		<main style={{ fontFamily: "system-ui, sans-serif", margin: "2rem" }}>
			<h1>sigrun</h1>
			{error !== undefined && <p role="alert">meta fetch failed: {error}</p>}
			{meta === undefined && error === undefined && <p>loading…</p>}
			{meta !== undefined && (
				<section aria-label="server meta">
					<Badge label="harness" value={meta.harnessVersion} />
					<Badge label="schema" value={meta.schemaVersion} />
					<Badge label="memory" value={meta.health.memory} />
					<Badge label="providers" value={meta.health.providers} />
					<Badge label="backup" value={meta.health.backup} />
					<Badge
						label="channels"
						value={
							meta.capabilities.channels.length === 0
								? "api-only"
								: meta.capabilities.channels.join(", ")
						}
					/>
				</section>
			)}
		</main>
	);
}
