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
 * - Model + thinking pickers (B6, the toolbar): live popovers — picking
 *   calls `configure` (model / thinking). The current model follows the
 *   view's `docs["pi.agent"].model` (`{provider, modelId}` — the server
 *   truth); a successful pick is echoed immediately (the frame lands
 *   next) while a FAILED configure keeps the previous selection and lands
 *   in the alert strip. The thinking picker is ALWAYS rendered — the
 *   catalog's `reasoning` flag is unreliable (glm-5.3-flash thinks but
 *   reports false) and must never hide the control.
 * - Context-usage ring: the current model's `docs["pi.usage"].models`
 *   ledger entry (input+output+cacheRead+cacheWrite — `totalTokens` is
 *   upstream-drift-prone) over its `contextWindow`, rendered as a compact
 *   SVG ring + percent; the tooltip names the raw `used / window` tokens.
 * - Interaction cards + ambient panels: the seam surfaces (docs/
 *   approval-ux-seams.md), endpoint-sourced, refreshed per view frame.
 * - Send/steer toggle: `view.steer.busy` flips the button and the submit
 *   carries `whenBusy: "steer"`; queued depth shows next to the button.
 * - Slash commands (Task 7, pi parity): typing `/` as the first character
 *   opens a menu over `GET /v1/commands` (fetched at mount, then re-fetched
 *   whenever a submitted command name is missing from the cached catalog —
 *   the server re-scans its roots per request, so templates and skills can
 *   appear mid-session); typing filters by name prefix; Enter/click selects
 *   — an argless command executes immediately, an arg-taking command
 *   inserts `/name ` for its args.
 *   Submitting a `/command args` line performs the corresponding client
 *   call; an UNKNOWN command is a clear alert-strip error, never a silent
 *   no-op. `/new` and `/fork` navigate to the created conversation via the
 *   optional `onNavigate` prop (App wires it to the active-id flip).
 */

import { useEffect, useRef, useState, type ChangeEvent } from "react";
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
import { PlusIcon, SendIcon } from "../layout/icons";
import { ModelPicker } from "./ModelPicker";
import { THINKING_LEVELS, ThinkingPicker } from "./ThinkingPicker";
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

/**
 * The `pi.agent` doc (pi-durable's AgentState), narrowed to the current
 * model — the schema's `{provider, modelId}` ref.
 */
interface AgentDocWire {
	readonly model?: {
		readonly provider: string;
		readonly modelId: string;
	};
}

/** The view's configured model as a catalog id (`provider/modelId`), null
 *  when the view carries no model ref yet. */
function agentModelId(view: ConversationViewWire | null): string | null {
	if (view === null) return null;
	const doc = view.docs["pi.agent"] as AgentDocWire | undefined;
	if (doc?.model === undefined) return null;
	return `${doc.model.provider}/${doc.model.modelId}`;
}

/** The current model's context usage — the raw token counts the ring's
 *  tooltip names plus the 0–1 fraction; null when unknown. */
function contextUsage(
	view: ConversationViewWire | null,
	model: ModelEntry | undefined,
): { used: number; window: number; fraction: number } | null {
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
	return {
		used,
		window: model.contextWindow,
		fraction: Math.max(0, Math.min(1, used / model.contextWindow)),
	};
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

/** Whether a submitted command line is an EXPAND input (Task 2c) — one the
 *  SERVER rewrites at admission (`kind: "expand"` catalog entries: prompt
 *  templates and skills) — so the composer submits it as message text and
 *  never calls an endpoint or errors locally. Any `skill:`-prefixed name
 *  qualifies even when the catalog does not list it: an unknown skill is a
 *  server-side pass-through, never a client-side unknown-command error. */
function isExpandLine(name: string, commands: readonly CommandWire[]): boolean {
	if (name.startsWith("skill:")) return true;
	return commands.find((command) => command.name === name)?.kind === "expand";
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

/** The compact context-usage ring (an SVG arc + percent label). The
 *  tooltip names the raw counts — "<used> / <window> tokens". */
function UsageRing(props: {
	readonly used: number | null;
	readonly window: number | null;
}) {
	const fraction =
		props.used === null || props.window === null || props.window <= 0
			? null
			: Math.max(0, Math.min(1, props.used / props.window));
	const percent =
		fraction === null ? null : Math.round(fraction * 100);
	const radius = 9;
	const circumference = 2 * Math.PI * radius;
	const filled =
		fraction === null ? 0 : fraction * circumference;
	return (
		<span
			className="composer-ring"
			data-usage-percent={percent === null ? undefined : percent}
			title={
				props.used === null || props.window === null
					? "context usage unknown"
					: `${props.used} / ${props.window} tokens`
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
	/**
	 * The `enterToSend` pref (usePrefs): when true, Enter (without shift)
	 * submits and Shift+Enter inserts a newline; Ctrl+Enter submits in every
	 * mode. Default false — Ctrl+Enter is the only submit chord.
	 */
	readonly enterToSend?: boolean;
	/**
	 * A read-access conversation (spec §5.9): the composer renders
	 * disabled with "Read-only (shared with you)" — a recipient views the
	 * transcript but cannot submit, steer, or attach.
	 */
	readonly readOnly?: boolean;
}) {
	const { client, conversationId, view, onNavigate, enterToSend = false, readOnly = false } =
		props;
	const draft = useDraft(client, conversationId);
	const [models, setModels] = useState<readonly ModelEntry[]>([]);
	const [pickedModel, setPickedModel] = useState<string | null>(null);
	const [pickedThinking, setPickedThinking] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [sending, setSending] = useState(false);
	// The SYNCHRONOUS twin of `sending` (§7.1): React state is not committed
	// between two clicks in one burst, so the admission-flight guard reads
	// a ref — set before the first await, released in the finally.
	const sendingRef = useRef(false);
	const [uploading, setUploading] = useState(false);
	const [commands, setCommands] = useState<readonly CommandWire[]>([]);
	const [highlight, setHighlight] = useState(0);
	const [interactions, setInteractions] = useState<readonly InteractionWire[]>([]);
	const [ambient, setAmbient] = useState<readonly AmbientWire[]>([]);

	// The slash-command catalog: fetched at mount, then re-fetched on the
	// send path whenever a submitted command name is missing from the
	// cache — the server re-scans its skill/template roots on every
	// request, so a template added mid-session must not die on the mount
	// snapshot (the refetch lands in state, so the menu catches up too).
	// A fetch failure leaves the menu empty — TYPED commands still execute
	// (the menu is an affordance, not the gate) — so the failure is
	// swallowed at the menu level, not surfaced as a boot error.
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
	// boot constant for M2's purposes). The CURRENT model is not picked here
	// — it follows the view's pi.agent doc (with the last successful pick as
	// the session echo that covers the frame latency).
	useEffect(() => {
		let cancelled = false;
		client
			.listModels()
			.then((response) => {
				if (cancelled) return;
				setModels(response.models);
			})
			.catch((cause: unknown) => {
				if (cancelled) return;
				setError(cause instanceof Error ? cause.message : String(cause));
			});
		return () => {
			cancelled = true;
		};
	}, [client]);

	// The current model: the view's pi.agent doc is the authority. The echo
	// (`pickedModel` — the last model successfully configured from here)
	// covers the gap between a successful pick and the frame that confirms
	// it; whenever the doc names a DIFFERENT model the server truth wins (an
	// out-of-band change, another tab, or the pick's own confirming frame).
	const viewModelId = agentModelId(view);
	useEffect(() => {
		if (viewModelId !== null) setPickedModel(viewModelId);
	}, [viewModelId]);
	const currentModel = pickedModel ?? viewModelId ?? models[0]?.id ?? null;

	const busy = view?.steer.busy ?? false;
	const queued = view?.steer.queued ?? 0;
	const model = models.find((m) => m.id === currentModel);
	const usage = contextUsage(view, model);

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

	function onFilesSelected(event: ChangeEvent<HTMLInputElement>): void {
		const files = event.target.files;
		const picked = files === null ? [] : Array.from(files);
		// Reset so picking the SAME file again re-fires the change event.
		event.target.value = "";
		if (picked.length === 0) return;
		// attach() catches its own failures (the alert strip owns them).
		void attach(picked);
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

	/** Menu selection (click or menu-Enter): argless → execute; else insert.
	 *  An EXPAND entry (Task 2c) always inserts `/name ` — args are its
	 *  whole point, and there is no endpoint to call: the server expands
	 *  the submitted line at admission. */
	function selectCommand(command: CommandWire): void {
		if (command.kind === "expand" || command.argsHint !== undefined) {
			setHighlight(0);
			draft.setText(`/${command.name} `);
			return;
		}
		void executeCommand(command.name, "");
	}

	/**
	 * Execute one slash command line. The composer owns the client calls —
	 * the catalog is metadata only (the registry's own doc). Every outcome
	 * is LOUD: success sets a notice, failure sets the alert strip; an
	 * unknown command or missing args is a usage error, never a silent
	 * no-op. The draft clears (persisted) once the call resolves. The
	 * lookup runs over `catalog` — the caller's freshest list (the send
	 * path passes its just-refetched catalog when one was needed).
	 */
	async function executeCommand(
		name: string,
		args: string,
		catalog: readonly CommandWire[] = commands,
	): Promise<void> {
		const command = catalog.find((c) => c.name === name);
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
					// The pill follows the command too (one spelling of "current").
					setPickedModel(args);
					setNotice(`model set to ${args}`);
					break;
				}
				case "thinking": {
					await client.configure(conversationId, { thinking: args });
					setPickedThinking(args);
					setNotice(`thinking set to ${args}`);
					break;
				}
				default: {
					// An extension-contributed command (W5 Task 3): the catalog
					// entry carries its slug — POST the invoke endpoint and render
					// the returned notice as the transient status banner. A command
					// with neither a core case nor an extension is inert (existing
					// behavior — the menu never offers one).
					if (command.extension === undefined) break;
					const result = await client.runCommand(
						conversationId,
						command.name,
						args,
					);
					setNotice(result.notice ?? `/${command.name} done`);
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

	/**
	 * Toolbar pick → `configure`. Success echoes immediately (the view frame
	 * confirms next — see `currentModel`); FAILURE keeps the previous
	 * selection and lands in the alert strip — a failed pick must never
	 * silently swap or drop what the composer shows.
	 */
	async function pickModel(id: string): Promise<void> {
		if (conversationId === null) return;
		try {
			await client.configure(conversationId, { model: id });
			setPickedModel(id);
			setError(null);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}

	/** The thinking twin of {@link pickModel} (same contract). */
	async function pickThinking(level: string): Promise<void> {
		if (conversationId === null) return;
		try {
			await client.configure(conversationId, { thinking: level });
			setPickedThinking(level);
			setError(null);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}

	async function send(): Promise<void> {
		// Read access is not a submission path (spec §5.9) — the disabled
		// surface normally makes this unreachable; the guard keeps it true.
		if (readOnly) return;
		const text = draft.text.trim();
		// A `/command args` line is a COMMAND, not a submission (Task 7): the
		// slash path owns the Send button too — an unknown command errors
		// visibly instead of being submitted as message text. EXCEPT an
		// expand input (Task 2c — `/skill:name`, a prompt template): that IS
		// a submission — the server expands the text at admission — so it
		// falls through to the normal submit path below, verbatim.
		if (text.startsWith("/")) {
			const { name, args } = parseCommandLine(draft.text);
			// Live catalog (fix round): the server re-scans its roots per
			// request, so a name the mount snapshot lacks may be a template
		// added mid-session. When the cached catalog does not know the
		// name, refetch ONCE and re-evaluate before any unknown-command
		// verdict; the refetch lands in state, so the menu catches up too.
			// A `skill:`-prefixed name never needs this (it always submits).
			let catalog = commands;
			if (
				!name.startsWith("skill:") &&
				!commands.some((command) => command.name === name)
			) {
				try {
					const fresh = await client.listCommands();
				catalog = fresh.commands;
				setCommands(fresh.commands);
				} catch {
					// A failed refetch keeps the cached verdict — the error path
					// below reports the unknown command honestly.
				}
			}
			if (!isExpandLine(name, catalog)) {
				await executeCommand(name, args, catalog);
				return;
			}
		}
		// §7.1: submit returns at ADMISSION, so `sending` spans only the
		// in-flight admit (not the whole run). The guard holds from the click
		// until the admission resolves (answered or errored) — synchronous via
		// the ref, so a double-click admits ONE submission. While `busy` (the
		// view's steer report), a click is a STEER, never a double-send.
		if (conversationId === null || (sendingRef.current && !busy)) return;
		if (text === "" && draft.attachments.length === 0) return;
		sendingRef.current = true;
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
			sendingRef.current = false;
			setSending(false);
		}
	}

	/**
	 * Manual compaction stays available as the `/compact` COMMAND (Task 4,
	 * pi parity): the dedicated button was removed in the 2026-10-15
	 * round-2 pass — compaction is automatic server-side, and the button
	 * crowded the composer.
	 */

	// The send button's disabled state (aria-disabled + class — see the
	// toolbar comment): no conversation, a read-only share, an in-flight
	// admission (while not steering), or nothing to send. A busy conversation
	// keeps it LIVE (a click steers).
	const sendDisabled =
		readOnly ||
		conversationId === null ||
		(sending && !busy) ||
		(draft.text.trim() === "" && draft.attachments.length === 0);

	return (
		<>
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
				<textarea
					className="composer-input"
					rows={3}
					placeholder={
						readOnly
							? "Read-only (shared with you)"
							: conversationId === null
								? "Select a conversation"
								: busy
									? "Steer the running session…"
									: "Message…"
					}
					value={draft.text}
					disabled={conversationId === null || readOnly}
					onChange={(event) => draft.setText(event.target.value)}
					onKeyDown={(event) => {
						// The slash menu owns the keys while it is open.
						if (menuOpen) {
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
							return;
						}
						// Submit chords: Ctrl+Enter / Cmd+Enter always (the mac
						// keyboard's submit key is Cmd — the 2026-10-15 round-2
						// report); Enter only under the `enterToSend` pref
						// (Shift+Enter stays a newline there).
						const submitChord =
							(event.key === "Enter" &&
								(event.ctrlKey ||
									event.metaKey ||
									(enterToSend && !event.shiftKey)));
						if (submitChord) {
							event.preventDefault();
							void send();
						}
					}}
				/>
				{/* THE TOOLBAR (B6) — the mockup's `[attach] [model] [thinking]
				    spacer [ring %] [send]` under the textarea. The send/steer
				    state is aria-label + aria-disabled + the
				    `composer-send-disabled` class — NOT a native `disabled`, which
				    would drop the Steer-while-busy click (T26b-iii); send() owns
				    the no-op guard. */}
				<div className="composer-toolbar">
					<label
						className="composer-pill composer-attach"
						title="Attach files"
						aria-label="attach files"
						data-uploading={uploading || undefined}
					>
						<PlusIcon />
						<input
							type="file"
							className="composer-file-input"
							multiple
							hidden
							disabled={conversationId === null || readOnly || uploading}
							onChange={onFilesSelected}
						/>
					</label>
					<ModelPicker
						models={models}
						current={currentModel}
						disabled={conversationId === null}
						onPick={pickModel}
					/>
					{/* ALWAYS rendered (B6): the catalog's `reasoning` flag is
					    unreliable (glm-5.3-flash thinks but reports false) — it must
					    never gate this control. */}
					<ThinkingPicker current={pickedThinking} onPick={pickThinking} />
					<span className="composer-toolbar-spacer" />
					<UsageRing used={usage?.used ?? null} window={usage?.window ?? null} />
					<button
						type="button"
						className={
							"composer-send" +
							(sendDisabled ? " composer-send-disabled" : "")
						}
						aria-label={busy ? "Steer" : "Send"}
						title={busy ? "Steer the running session" : "Send"}
						aria-disabled={sendDisabled}
						onClick={() => void send()}
					>
						<SendIcon />
					</button>
					{queued > 0 && (
						<span className="composer-queued">+{queued} queued</span>
					)}
				</div>
			</div>
			{/* The hint line beneath the box (the mockup's centered faint
			    caption): the submit chord + the slash affordance, exact. */}
			<p className="composer-hint">
				{enterToSend
					? "Enter to send · Shift+Enter for newline · / for commands"
					: "Ctrl+Enter to send · / for commands"}
			</p>
	</>
	);
}
