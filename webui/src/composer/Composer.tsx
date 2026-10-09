/**
 * Composer (Task 23b): the footer of the chat column.
 *
 * - Textarea backed by {@link useDraft} (the per-session persistent draft —
 *   restored from `/meta` on switch, saved debounced, cleared after submit
 *   without a late flush resurrecting it).
 * - Model picker from `client.listModels()` (the §5 catalog). v1 is
 *   display-only: the selection names the model the usage ring reads and
 *   the composer label — the wire-level model change is `configure`, a
 *   later task.
 * - Context-usage ring: the selected model's `docs["pi.usage"].models`
 *   ledger entry (input+output+cacheRead+cacheWrite — `totalTokens` is
 *   upstream-drift-prone) over its `contextWindow`, rendered as a compact
 *   SVG ring + percent.
 * - Send/steer toggle: `view.steer.busy` flips the button and the submit
 *   carries `whenBusy: "steer"`; queued depth shows next to the button.
 * - Approval strip: `client.listApprovals(conversationId)` refreshed per
 *   view frame (the stream drives the cadence — this component refetches on
 *   every new `view` object reference). THE T22 P1 CORRECTION: the cards
 *   come from the ENDPOINT, which evaluates the gating join server-side —
 *   NOT from `view.docs["pi.live"].tools` slots (pi-durable marks
 *   not-yet-started calls `pending` regardless of gating; a slot-derived
 *   card would render for an ungated tool and 404 on click).
 *
 * NO attach button: uploads are T24.
 */

import { useEffect, useState } from "react";
import {
	type ApprovalWire,
	type ConversationViewWire,
	type ModelEntry,
	type SigrunClient,
} from "../api";
import { ApprovalCard } from "../entries/ApprovalCard";
import { useDraft } from "./useDraft";

/** The `pi.usage` doc (pi-durable's UsageState), narrowed to what the ring reads. */
interface UsageDocWire {
	readonly models?: Readonly<
		Record<
			string,
			{
				readonly input?: number;
				readonly output?: number;
				readonly cacheRead?: number;
				readonly cacheWrite?: number;
				readonly totalTokens?: number;
			}
		>
	>;
}

/** The selected model's context usage, 0–1; null when unknown. */
function usageFraction(
	view: ConversationViewWire | null,
	model: ModelEntry | undefined,
): number | null {
	if (view === null || model === undefined) return null;
	const usage = view.docs["pi.usage"] as UsageDocWire | undefined;
	const entry = usage?.models?.[model.id];
	if (entry === undefined || model.contextWindow <= 0) return null;
	// input+output+cacheRead+cacheWrite, NOT totalTokens (upstream drift).
	const used =
		(entry.input ?? 0) +
		(entry.output ?? 0) +
		(entry.cacheRead ?? 0) +
		(entry.cacheWrite ?? 0);
	return Math.max(0, Math.min(1, used / model.contextWindow));
}

/** The compact context-usage ring (an SVG arc + percent label). */
function UsageRing(props: { fraction: number | null }) {
	const percent =
		props.fraction === null ? null : Math.round(props.fraction * 100);
	const radius = 9;
	const circumference = 2 * Math.PI * radius;
	const filled =
		props.fraction === null ? 0 : props.fraction * circumference;
	return (
		<span
			className="composer-ring"
			data-usage-percent={percent === null ? undefined : percent}
			title={
				percent === null
					? "context usage unknown"
					: `context usage ${percent}%`
			}
		>
			<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
				<circle
					cx="12"
					cy="12"
					r={radius}
					className="composer-ring-track"
				/>
				<circle
					cx="12"
					cy="12"
					r={radius}
					className="composer-ring-fill"
					strokeDasharray={`${filled} ${circumference}`}
					transform="rotate(-90 12 12)"
				/>
			</svg>
			{percent !== null && (
				<span className="composer-ring-label">{percent}%</span>
			)}
		</span>
	);
}

export function Composer(props: {
	conversationId: number | null;
	client: SigrunClient;
	/**
	 * The latest view frame — or null when no conversation is active or the
	 * stream has not delivered yet. A new object REFERENCE drives the
	 * approvals refetch (the stream's cadence).
	 */
	view: ConversationViewWire | null;
}) {
	const { client, conversationId, view } = props;
	const draft = useDraft(client, conversationId);
	const [models, setModels] = useState<readonly ModelEntry[]>([]);
	const [selectedModel, setSelectedModel] = useState<string | null>(null);
	const [approvals, setApprovals] = useState<readonly ApprovalWire[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [sending, setSending] = useState(false);

	// The model catalog: fetched once per mount (the §5 catalog is a server
	// boot constant for M2's purposes).
	useEffect(() => {
		let cancelled = false;
		client
			.listModels()
			.then((response) => {
				if (cancelled) return;
				setModels(response.models);
				setSelectedModel((current) =>
					current !== null &&
					response.models.some((m) => m.id === current)
						? current
						: (response.models[0]?.id ?? null),
				);
			})
			.catch((cause: unknown) => {
				if (cancelled) return;
				setError(cause instanceof Error ? cause.message : String(cause));
			});
		return () => {
			cancelled = true;
		};
	}, [client]);

	// THE T22 P1 SOURCING: approvals come from the endpoint, refreshed per
	// view frame. `view` is a fresh immutable object per accepted frame, so
	// it is the refetch cadence. A clear frame (endpoint empty) clears the
	// strip; the view's pi.live tool slots NEVER feed this list.
	useEffect(() => {
		if (conversationId === null) {
			setApprovals([]);
			return;
		}
		let cancelled = false;
		client
			.listApprovals(conversationId)
			.then((response) => {
				if (cancelled) return;
				setApprovals(
					response.approvals.filter((a) => a.status === "pending"),
				);
			})
			.catch((cause: unknown) => {
				if (cancelled) return;
				setError(cause instanceof Error ? cause.message : String(cause));
			});
		return () => {
			cancelled = true;
		};
	}, [client, conversationId, view]);

	const busy = view?.steer.busy ?? false;
	const queued = view?.steer.queued ?? 0;
	const model = models.find((m) => m.id === selectedModel);
	const fraction = usageFraction(view, model);

	async function send(): Promise<void> {
		const text = draft.text.trim();
		if (conversationId === null || text === "" || sending) return;
		setSending(true);
		setError(null);
		try {
			await client.submit(
				conversationId,
				[{ type: "text", text }],
				busy ? { whenBusy: "steer" } : undefined,
			);
			// Cleared WITHOUT persisting: the submitted text must not
			// resurrect from a late debounce flush. The next view frame shows
			// the submitted turn.
			draft.clear();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSending(false);
		}
	}

	return (
		<div className="composer">
			{approvals.length > 0 && (
				<div className="composer-approvals">
					{approvals.map((approval) => (
						<ApprovalCard
							key={approval.callId}
							conversationId={conversationId as number}
							approval={approval}
							client={client}
						/>
					))}
				</div>
			)}
			{error !== null && <p role="alert">{error}</p>}
			<div className="composer-row">
				<textarea
					className="composer-input"
					rows={3}
					placeholder={
						conversationId === null
							? "Select a conversation"
							: busy
								? "Steer the running session…"
								: "Message…"
					}
					value={draft.text}
					disabled={conversationId === null}
					onChange={(event) => draft.setText(event.target.value)}
				/>
				<div className="composer-side">
					<select
						className="composer-model"
						value={selectedModel ?? ""}
						disabled={models.length === 0}
						onChange={(event) => setSelectedModel(event.target.value)}
					>
						{models.map((m) => (
							<option key={m.id} value={m.id}>
								{m.name}
							</option>
						))}
					</select>
					<UsageRing fraction={fraction} />
					<button
						type="button"
						className="composer-send"
						disabled={
							conversationId === null ||
							sending ||
							draft.text.trim() === ""
						}
						onClick={() => void send()}
					>
						{busy ? "Steer" : "Send"}
					</button>
					{queued > 0 && (
						<span className="composer-queued">+{queued} queued</span>
					)}
				</div>
			</div>
		</div>
	);
}
