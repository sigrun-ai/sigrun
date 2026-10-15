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
 * - Interaction cards + ambient panels: the seam surfaces (docs/
 *   approval-ux-seams.md), endpoint-sourced, refreshed per view frame.
 * - Send/steer toggle: `view.steer.busy` flips the button and the submit
 *   carries `whenBusy: "steer"`; queued depth shows next to the button.
 * - Slash commands (Task 7, pi parity): typing `/` as the first character
 *   opens a menu over `GET /v1/commands` (fetched once per mount — the
 *   catalog is a server boot constant, cache-friendly); typing filters by
 *   name prefix; Enter/click selects — an argless command executes
 *   immediately, an arg-taking command inserts `/name ` for its args.
 *   Submitting a `/command args` line performs the corresponding client
 *   call; an UNKNOWN command is a clear alert-strip error, never a silent
 *   no-op. `/new` and `/fork` navigate to the created conversation via the
 *   optional `onNavigate` prop (App wires it to the active-id flip).
 */

import { useEffect, useState, type ChangeEvent, type KeyboardEvent } from "react";
import {
	type CommandWire,
	type ConversationViewWire,
	type ModelEntry,
	type SigrunClient,
	type SubmissionInputPart,
} from "../api";
import { AmbientPanels } from "../entries/AmbientPanels";
import { InteractionCards } from "../entries/InteractionCards";
import type {
	AmbientWire,
	InteractionWire,
} from "../api";
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
 * The `thinking` values `/thinking` accepts (mirrors the server's
 * THINKING_LEVELS — itself pi-ai `ModelThinkingLevel`; the webui cannot
 * import server sources). Duplicated so an invalid level errors CLEARLY in
 * the composer instead of the generic non-2xx message.
 */
const THINKING_LEVELS: readonly string[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

/**
 * Parse a submitted composer line into `(name, args)` — `args` is
 * EVERYTHING after the command word (spaces and newlines intact, so
 * `/import` takes multi-line pasted JSONL); both are "" for a non-command
 * line.
 */
function parseCommandLine(text: string): { name: string; args: string } {
	if (!text.startsWith("/")) return { name: "", args: "" };
	const rest = text.slice(1);
	const cut = rest.search(/\s/);
	if (cut === -1) return { name: rest, args: "" };
	return { name: rest.slice(0, cut), args: rest.slice(cut + 1).trim() };
}

/**
 * Trigger the browser download of an `/export` body as
 * `conversation-<id>.jsonl` (the anchor + object-URL dance; a no-op outside
 * a DOM — tests assert the fetch, not the download). This is the cheapest
 * honest `/export` UX over the existing endpoints: the download IS the
 * endpoint result.
 */
function downloadJsonl(conversationId: number, jsonl: string): void {
	const document_ = globalThis.document;
	if (document_ === undefined || typeof document_.createElement !== "function") {
		return;
	}
	const anchor = document_.createElement("a");
	anchor.href = URL.createObjectURL(new Blob([jsonl], { type: "application/x-ndjson" }));
	anchor.download = `conversation-${conversationId}.jsonl`;
	anchor.click();
	URL.revokeObjectURL(anchor.href);
}

/** Entry count of an export body — one JSON object per line (trailing newline tolerated). */
function countJsonlLines(jsonl: string): number | null {
	const lines = jsonl.split("\n");
	const trimmed = lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
	return trimmed.length;
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
	/** The latest view frame — or null when no conversation is active or the
	 *  stream has not delivered yet. */
	view: ConversationViewWire | null;
	/**
	 * Navigate to a conversation id — App wires this to the active-id flip;
	 * `/new`, `/fork`, and `/import` call it with the created id. Optional so
	 * a bare embed (tests) can omit it.
	 */
	onNavigate?: (id: number) => void;
}) {
	const { client, conversationId, view, onNavigate } = props;
	const draft = useDraft(client, conversationId);
	const [models, setModels] = useState<readonly ModelEntry[]>([]);
	const [selectedModel, setSelectedModel] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [sending, setSending] = useState(false);
	const [uploading, setUploading] = useState(false);
	const [compacting, setCompacting] = useState(false);
	const [commands, setCommands] = useState<readonly CommandWire[]>([]);
	const [highlight, setHighlight] = useState(0);
	const [interactions, setInteractions] = useState<readonly InteractionWire[]>([]);
	const [ambient, setAmbient] = useState<readonly AmbientWire[]>([]);

	// The slash-command catalog: fetched once per mount (a server boot
	// constant, like the model catalog). A fetch failure leaves the menu
	// empty — TYPED commands still execute (the menu is an affordance, not
	// the gate) — so the failure is swallowed at the menu level, not surfaced
	// as a boot error.
	useEffect(() => {
		let cancelled = false;
		client
			.listCommands()
			.then((response) => {
				if (!cancelled) setCommands(response.commands);
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [client]);

	// THE SEAM SOURCING: interactions + ambient come from their endpoints,
	// refreshed per view frame (a fresh immutable object per accepted frame
	// is the refetch cadence). Ambient is conversation-scoped, so a new
	// conversation id also refetches; both clear with the conversation.
	useEffect(() => {
		if (conversationId === null) {
			setInteractions([]);
			return;
		}
		let cancelled = false;
		client
			.listInteractions(conversationId)
			.then((response) => {
				if (cancelled) return;
				setInteractions(
					(response.interactions ?? []).filter((i) => i.status === "pending"),
				);
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [client, conversationId, view]);

	useEffect(() => {
		if (conversationId === null) {
			setAmbient([]);
			return;
		}
		let cancelled = false;
		client
			.listAmbient(conversationId)
			.then((response) => {
				if (cancelled) return;
				setAmbient(response.ambient ?? []);
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [client, conversationId, view]);

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

	/**
	 * The slash menu state: OPEN while the draft is exactly a `/query` (a
	 * leading slash, no whitespace yet — the first space ends the query
	 * phase and the args phase begins). Derived from the text, so it can
	 * never drift; `highlight` is the arrow-key index into `filtered`.
	 */
	const slashQuery = /^\/\S*$/.test(draft.text) ? draft.text.slice(1) : null;
	const filteredCommands =
		slashQuery === null
			? []
			: commands.filter((command) => command.name.startsWith(slashQuery));
	const menuOpen = slashQuery !== null && commands.length > 0;
	const clampedHighlight = Math.min(highlight, Math.max(0, filteredCommands.length - 1));

	/** Menu selection (click or menu-Enter): argless → execute; else insert. */
	function selectCommand(command: CommandWire): void {
		if (command.argsHint === undefined) {
			void executeCommand(command.name, "");
			return;
		}
		setHighlight(0);
		draft.setText(`/${command.name} `);
	}

	/**
	 * Execute one slash command line. The composer owns the client calls —
	 * the catalog is metadata only (the registry's own doc). Every outcome
	 * is LOUD: success sets a notice, failure sets the alert strip; an
	 * unknown command or missing args is a usage error, never a silent
	 * no-op. The draft clears (persisted) once the call resolves.
	 */
	async function executeCommand(name: string, args: string): Promise<void> {
		const command = commands.find((c) => c.name === name);
		if (command === undefined) {
			setError(`unknown command: /${name}`);
			setNotice(null);
			return;
		}
		const usage = (hint: string): void => {
			setError(`usage: /${command.name} ${hint}`);
			setNotice(null);
		};
		if (conversationId === null) return;
		// Arg validation FIRST (client-side where the shape is known — clear
		// errors without a round trip; the server re-validates anyway).
		switch (command.name) {
			case "name":
				if (args === "") return usage(command.argsHint ?? "<name>");
				break;
			case "import":
				if (args === "") return usage(command.argsHint ?? "<jsonl>");
				break;
			case "model":
				if (args === "" || !args.includes("/")) {
						return usage(command.argsHint ?? "<provider/model>");
					}
				break;
			case "thinking":
				if (args === "" || !THINKING_LEVELS.includes(args)) {
						return usage(
							`<level: ${THINKING_LEVELS.join(" | ")}>`,
						);
					}
				break;
			case "fork":
				if (args !== "" && Number.isNaN(Number(args))) {
						return usage("[at] — an entry id number");
					}
				break;
			default:
				break;
		}
		setSending(true);
		setError(null);
		setNotice(null);
		try {
			switch (command.name) {
				case "new": {
					const created = await client.createConversation();
					onNavigate?.(created.id);
					setNotice(`started conversation ${created.id}`);
					break;
				}
				case "fork": {
					const forked = await client.fork(
						conversationId,
						args === "" ? undefined : Number(args),
					);
					onNavigate?.(forked.id);
					setNotice(`forked to conversation ${forked.id}`);
					break;
				}
				case "compact": {
					await client.compact(
						conversationId,
						args === "" ? undefined : args,
					);
					setNotice("compaction admitted");
					break;
				}
				case "export": {
					const jsonl = await client.exportConversation(conversationId);
					downloadJsonl(conversationId, jsonl);
					const count = countJsonlLines(jsonl);
					setNotice(
						typeof count === "number"
							? `exported ${count} entries`
							: "exported",
					);
					break;
				}
				case "import": {
					const imported = await client.importConversation(args);
					onNavigate?.(imported.id);
					setNotice(`imported conversation ${imported.id}`);
					break;
				}
				case "name": {
					await client.patchConversationMeta(conversationId, { name: args });
					setNotice(`named “${args}”`);
					break;
				}
				case "model": {
					await client.configure(conversationId, { model: args });
					setNotice(`model set to ${args}`);
					break;
				}
				case "thinking": {
					await client.configure(conversationId, { thinking: args });
					setNotice(`thinking set to ${args}`);
					break;
				}
			}
			// Like a sent message: the command line must not resurrect from a
			// late debounce flush or a reload.
			draft.clear(true);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSending(false);
		}
	}

	async function send(): Promise<void> {
		const text = draft.text.trim();
		// A `/command args` line is a COMMAND, not a submission (Task 7): the
		// slash path owns the Send button too — an unknown command errors
		// visibly instead of being submitted as message text.
		if (text.startsWith("/")) {
			const { name, args } = parseCommandLine(draft.text);
			await executeCommand(name, args);
			return;
		}
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
			<AmbientPanels surfaces={ambient} />
			<InteractionCards
				conversationId={conversationId}
				interactions={interactions}
				client={client}
				onError={(message) => setError(message)}
				onAnswered={() => {
					// Optimistic immediate refetch — the view-frame cadence
					// only fires while a stream runs; an answer must clear
					// its card now, not on the next frame.
					if (conversationId === null) return;
					client
						.listInteractions(conversationId)
						.then((response) =>
							setInteractions(
								(response.interactions ?? []).filter(
									(i) => i.status === "pending",
								),
							),
						)
						.catch(() => undefined);
				}}
			/>
			{error !== null && <p role="alert">{error}</p>}
			{notice !== null && (
				<p className="composer-notice" role="status">
					{notice}
				</p>
			)}
			{menuOpen && (
				<ul className="composer-command-menu" role="listbox">
					{filteredCommands.map((command, index) => (
						<li
							key={command.name}
							role="option"
							aria-selected={index === clampedHighlight}
							data-highlighted={index === clampedHighlight || undefined}
							onMouseDown={(event) => {
								// Prevent the textarea's blur before the click lands.
								event.preventDefault();
							}}
							onClick={() => selectCommand(command)}
						>
							<span className="composer-command-name">/{command.name}</span>
							{command.argsHint !== undefined && (
								<span className="composer-command-args">{command.argsHint}</span>
							)}
							<span className="composer-command-description">
								{command.description}
							</span>
						</li>
					))}
				</ul>
			)}
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
					onKeyDown={(event) => {
						if (!menuOpen) return;
						const key = event.key;
						if (
							key === "ArrowDown" ||
							key === "ArrowUp" ||
							(key === "Enter" && filteredCommands.length > 0) ||
							key === "Escape"
						) {
							event.preventDefault();
							if (key === "Escape") {
								draft.setText("");
							} else if (key === "ArrowDown") {
								setHighlight(
									(clampedHighlight + 1) % filteredCommands.length,
								);
							} else if (key === "ArrowUp") {
								setHighlight(
									(clampedHighlight - 1 + filteredCommands.length) %
										filteredCommands.length,
								);
							} else {
								selectCommand(filteredCommands[clampedHighlight]!);
							}
						}
					}}
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
