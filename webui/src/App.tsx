import { useCallback, useState } from "react";
import {
	createClient,
	type ConversationViewWire,
	type SigrunClient,
} from "./api";
import { Composer } from "./composer/Composer";
import { EntryList } from "./entries/EntryList";
import { SessionList } from "./sessions/SessionList";
import type { EventSourceFactory } from "./stream";
import { useConversationView } from "./useConversationView";

/**
 * The app shell: three panels — SessionList left, the chat center
 * (EntryList over `useConversationView(activeId)`), a right-panel
 * placeholder (T24 replaces it with the details surface) — and the
 * composer footer (Task 23b: textarea, model picker, context-usage ring,
 * send/steer toggle, endpoint-sourced approval strip).
 *
 * The active conversation id is App state: `SessionList.onSelect` flips it,
 * and the view hook re-drives (a fresh stream opens; the stale one closes —
 * the hook's cleanup owns that). The Composer receives the latest view
 * frame: `steer.busy` flips its send→steer toggle, `docs["pi.usage"]` feeds
 * the ring, and each new frame reference refreshes the approvals strip.
 *
 * Styling: thin hand-rolled CSS in app.css (the mockup's direction, no
 * framework), continuing the T20 scaffold's no-dependency stance.
 */

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
	const [activeId, setActiveId] = useState<number | null>(null);
	const { view, status, error } = useConversationView(activeId, {
		createEventSource: options.createEventSource,
	});
	const onSelect = useCallback((id: number) => setActiveId(id), []);

	return (
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
					/>
				</footer>
			</div>
			<aside className="right-panel">details</aside>
		</main>
	);
}
