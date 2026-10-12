/**
 * Composer (Task 23b + T24 attachments): the footer of the chat column.
 *
 * - Textarea backed by {@link useDraft} (the per-session persistent draft —
 *   restored from `/meta` on switch, saved debounced, cleared after submit
 *   without a late flush resurrecting it).
 * - Attach path (Task 24): the attach control (a `<label>` wrapping a hidden
 *   `<input type="file" multiple>` — native activation, no ref-click)
 *   uploads each selected file via `client.upload` → the returned
 *   workspace-relative path lands in `draft.attachments` (session-meta —
 *   the tray survives a reload). The tray renders one chip per path with a
 *   remove control. Submit sends one `{type:"image"|"file", path, mime?}`
 *   part per attachment + the text part; a known image extension maps to
 *   `image` + its mime, anything else to `file` (the server resolves
 *   path-parts at submit time, spec §5).
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
 */

import { useEffect, useState, type ChangeEvent } from "react";
import {
	type ApprovalWire,
	type ConversationViewWire,
	type ModelEntry,
	type SigrunClient,
	type SubmissionInputPart,
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

/** Known image extensions → mime (the submit part's `image` discriminator). */
const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
	svg: "image/svg+xml",
	avif: "image/avif",
};

/** The last path segment (the tray chip label / extension source). */
function basename(path: string): string {
	const slash = path.lastIndexOf("/");
	return slash === -1 ? path : path.slice(slash + 1);
}

/**
 * An attachment path → its §5 submission part: a known image extension
 * yields `{type:"image", path, mime}` (the mime is derivable from the path,
 * so the tray — which persists only paths — needs nothing else); anything
 * else yields `{type:"file", path}` and the server resolves the content.
 */
function attachmentPart(path: string): SubmissionInputPart {
	const name = basename(path);
	const dot = name.lastIndexOf(".");
	const extension = dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
	const mime = IMAGE_MIME_BY_EXTENSION[extension];
	if (mime === undefined) return { type: "file", path };
	return { type: "image", path, mime };
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
	const [uploading, setUploading] = useState(false);
	const [compacting, setCompacting] = useState(false);

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

	async function attach(files: Iterable<File>): Promise<void> {
		if (conversationId === null || uploading) return;
		setUploading(true);
		setError(null);
		try {
			// Sequential: the per-file PATCHes build on each other, and the
			// tray order matches the picker order.
			for (const file of files) {
				const uploaded = await client.upload(conversationId, file);
				draft.addAttachment(uploaded.path);
			}
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setUploading(false);
		}
	}

	function onFilesSelected(event: ChangeEvent<HTMLInputElement>): unknown {
		const files = event.target.files;
		const picked = files === null ? [] : Array.from(files);
		// Reset so picking the SAME file again re-fires the change event.
		event.target.value = "";
		if (picked.length === 0) return undefined;
		return attach(picked);
	}

	async function send(): Promise<void> {
		const text = draft.text.trim();
		// T26b-iii (ship-gate item 3): the submissions route awaits full
		// settlement server-side, so `sending` stays true for the WHOLE busy
		// turn — gating on `sending` alone made Steer unclickable exactly while
		// a session runs. While busy, a click is a STEER (a distinct
		// submission), never a double-send of the in-flight draft: allow it.
		if (conversationId === null || (sending && !busy)) return;
		if (text === "" && draft.attachments.length === 0) return;
		setSending(true);
		setError(null);
		try {
			const parts: SubmissionInputPart[] = [
				...draft.attachments.map(attachmentPart),
				...(text === "" ? [] : [{ type: "text", text }]),
			];
			await client.submit(
				conversationId,
				parts,
				busy ? { whenBusy: "steer" } : undefined,
			);
			// Cleared WITH persisting: the submitted text AND the tray must not
			// resurrect from a late debounce flush OR a reload (the server meta
			// keeps the draft until it's overwritten — persist the clear).
			draft.clear(true);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSending(false);
		}
	}

	/**
	 * Manual compaction (Task 4, pi parity): POST the compact endpoint —
	 * the task is admitted server-side and its `pi.compaction` summary
	 * entry arrives as a view revision (the stream refreshes the ring).
	 * Pending state until the POST resolves; errors surface in the strip.
	 */
	async function compact(): Promise<void> {
		if (conversationId === null || compacting) return;
		setCompacting(true);
		setError(null);
		try {
			await client.compact(conversationId);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setCompacting(false);
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
			{draft.attachments.length > 0 && (
				<ul className="composer-attachments">
					{draft.attachments.map((path) => (
						<li
							key={path}
							className="composer-attachment"
							data-path={path}
						>
							<span className="composer-attachment-name">
								{basename(path)}
							</span>
							<button
								type="button"
								className="composer-attachment-remove"
								aria-label={`remove ${basename(path)}`}
								onClick={() => draft.removeAttachment(path)}
							>
								×
							</button>
						</li>
					))}
				</ul>
			)}
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
					<label
						className="composer-attach"
						data-uploading={uploading || undefined}
					>
						{uploading ? "Uploading…" : "Attach"}
						<input
							type="file"
							className="composer-file-input"
							multiple
							hidden
							disabled={conversationId === null || uploading}
							onChange={onFilesSelected}
						/>
					</label>
					{/* THE PICKER CONVENTION (spec §6.1): a picker renders ONLY
					    when its list has more than one item — a single-model
					    deployment hides the picker (the single model stays
					    selected, so the ring still reads its ledger entry). */}
					{models.length > 1 && (
						<select
							className="composer-model"
							value={selectedModel ?? ""}
							onChange={(event) => setSelectedModel(event.target.value)}
						>
							{models.map((m) => (
								<option key={m.id} value={m.id}>
									{m.name}
								</option>
							))}
						</select>
					)}
					<UsageRing fraction={fraction} />
					<button
						type="button"
						className="composer-compact"
						disabled={conversationId === null || compacting}
						data-compacting={compacting || undefined}
						onClick={() => void compact()}
					>
						{compacting ? "Compacting…" : "Compact"}
					</button>
					<button
						type="button"
						className="composer-send"
						disabled={
							conversationId === null ||
							(sending && !busy) ||
							(draft.text.trim() === "" &&
								draft.attachments.length === 0)
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
