import { useCallback, useEffect, useState } from "react";
import {
	createClient,
	type ConversationViewWire,
	type MetaResponse,
	type SigrunClient,
} from "./api";
import { Composer } from "./composer/Composer";
import { EntryList } from "./entries/EntryList";
import { TopBar } from "./layout/TopBar";
import { PINNED_SCHEMA_VERSION } from "./schema-version";
import { SessionList } from "./sessions/SessionList";
import type { EventSourceFactory } from "./stream";
import { useTheme } from "./theme/useTheme";
import { useConversationView } from "./useConversationView";
import { WorkspaceBrowser } from "./workspace/WorkspaceBrowser";

/**
 * The app shell: three panels — SessionList left, the chat center
 * (EntryList over `useConversationView(activeId)`), the WorkspaceBrowser
 * right panel (Task 24: file tree + read-only preview over the §5 files
 * endpoints) — and the composer footer (Task 23b: textarea, model picker,
 * context-usage ring, send/steer toggle, endpoint-sourced approval strip;
 * Task 24: the attach path).
 *
 * The active conversation id is App state: `SessionList.onSelect` flips it,
 * and the view hook re-drives (a fresh stream opens; the stale one closes —
 * the hook's cleanup owns that). The Composer receives the latest view
 * frame: `steer.busy` flips its send→steer toggle, `docs["pi.usage"]` feeds
 * the ring, and each new frame reference refreshes the approvals strip.
 *
 * Task 25 added the boot gate + the top bar: on boot the app fetches
 * `GET /v1/meta` and REFUSES to render the shell when the served
 * `schemaVersion` differs from the bundle's pinned copy (spec §5 fail-loud —
 * a mismatch means the bundle and the server disagree on the wire shape).
 * A matching meta renders the TopBar (brand, extension-set badge, degraded-
 * health badges, theme controls) over the three panels. The theme hook
 * (light/dark + accent) is owned here and handed down.
 *
 * Styling: thin hand-rolled CSS in app.css (the mockup ported, no
 * framework), continuing the T20 scaffold's no-dependency stance.
 */

/** The boot state machine: meta fetch → schema gate → shell. */
type Boot =
	| { readonly status: "loading" }
	| { readonly status: "refused"; readonly message: string }
	| { readonly status: "ready"; readonly meta: MetaResponse };

/** The default client (same-origin); tests inject a stub-backed one. */
const defaultClient = createClient();

export interface AppOptions {
	/** Injected for tests; defaults to the same-origin §5 client. */
	readonly client?: SigrunClient;
	/** Injected for tests; defaults to the browser's native EventSource. */
	readonly createEventSource?: EventSourceFactory;
}

function ChatCenter(props: {
	activeId: number | null;
	view: ConversationViewWire | null;
	status: string;
	error: string | null;
}) {
	const { activeId, view, status, error } = props;
	if (activeId === null) {
		return (
			<section className="chat-center">
				<p className="chat-empty">Select or create a conversation</p>
			</section>
		);
	}
	return (
		<section
			className="chat-center"
			data-view-status={status}
			aria-label="chat transcript"
		>
			{error !== null && <p role="alert">{error}</p>}
			{view === null ? (
				<p className="chat-loading">loading…</p>
			) : (
				<EntryList view={view} />
			)}
		</section>
	);
}

export function App(options: AppOptions = {}) {
	const client = options.client ?? defaultClient;
	const theme = useTheme();
	const [boot, setBoot] = useState<Boot>({ status: "loading" });
	const [activeId, setActiveId] = useState<number | null>(null);
	const { view, status, error } = useConversationView(activeId, {
		createEventSource: options.createEventSource,
	});
	const onSelect = useCallback((id: number) => setActiveId(id), []);

	// Boot-time default: select the root conversation (the §5 default session)
	// once the schema gate passes, so the composer is live without a click.
	// Runs once per boot (after the gate); a user's own selection wins.
	useEffect(() => {
		if (boot.status !== "ready" || activeId !== null) return;
		let cancelled = false;
		client
			.listConversations()
			.then((list) => {
				if (cancelled) return;
				const root = list.conversations.find((c) => c.root);
				const first = root ?? list.conversations[0];
				// Re-check activeId inside the callback: a user click that landed
				// while the list was in flight wins over the boot default (the
				// T26b review's clobber race).
				setActiveId((current) => current ?? first?.id ?? null);
			})
			.catch(() => undefined); // a list failure leaves the composer gated; the sidebar shows the error
		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [boot.status, client]);

	// The schema-version gate (spec §5): no shell renders until /v1/meta
	// answers with the pinned schema. A mismatch — or an unverifiable fetch —
	// is an explicit refusal, never a half-rendered wrong-contract UI.
	useEffect(() => {
		let cancelled = false;
		client
			.getMeta()
			.then((meta) => {
				if (cancelled) return;
				if (meta.schemaVersion !== PINNED_SCHEMA_VERSION) {
					setBoot({
						status: "refused",
						message:
							`schema mismatch: the server speaks schema ${meta.schemaVersion} ` +
							`but this webui bundle is pinned to ${PINNED_SCHEMA_VERSION}. ` +
							"Rebuild and redeploy the bundle against this server (spec §5).",
					});
				} else {
					setBoot({ status: "ready", meta });
				}
			})
			.catch((cause: unknown) => {
				if (cancelled) return;
				const detail =
					cause instanceof Error ? cause.message : String(cause);
				setBoot({
					status: "refused",
					message:
						`schema check failed: ${detail}. ` +
						"The wire schema is unverifiable, so the webui refuses to render (spec §5).",
				});
			});
		return () => {
			cancelled = true;
		};
	}, [client]);

	if (boot.status === "loading") {
		return (
			<div className="app-boot">
				<p>sigrun — checking the wire schema…</p>
			</div>
		);
	}
	if (boot.status === "refused") {
		return (
			<div className="app-refused" role="alert">
				<h1>sigrun — refusing to render</h1>
				<p>{boot.message}</p>
			</div>
		);
	}

	return (
		<div className="app-root">
			<TopBar meta={boot.meta} theme={theme} client={client} />
			<main className="app-shell">
				<SessionList
					client={client}
					activeId={activeId}
					onSelect={onSelect}
				/>
				<div className="chat-column">
					<ChatCenter
						activeId={activeId}
						view={view}
						status={status}
						error={error}
					/>
					<footer className="composer-slot">
						<Composer
							client={client}
							conversationId={activeId}
							view={view}
							onNavigate={onSelect}
						/>
					</footer>
				</div>
				<aside className="right-panel">
					<WorkspaceBrowser client={client} conversationId={activeId} />
				</aside>
			</main>
		</div>
	);
}
