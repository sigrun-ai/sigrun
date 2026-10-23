/**
 * Content blocks (UI-blocks U1 Task 1, spec §5.3): `markdown`,
 * `fields`, `stat`, `callout`, `image`, `diff`, `details` — the simple
 * content half of the block set. Bindings resolve through the
 * `SurfaceData` context; values format through the shared
 * `formatValue`; every text slot carries `dir="auto"` (review focus 5,
 * RTL text in markdown and cards).
 *
 * The action-button row (spec §6.1/§6.2) lives here too: `callout` is
 * its first consumer and the later tasks' cards and pages import the
 * same row. `copy` and `open` are channel-local (clipboard / new tab)
 * and never dispatch; an action carrying `confirm` opens a dialog and
 * only its Confirm button dispatches.
 */

import { useState, type ReactNode } from "react";
import {
	formatValue,
	type Action,
	type ActionButton,
	type Bindable,
	type Confirm,
	type IconName,
	type JsonValue,
	type Tone,
} from "@sigrun/shared/blocks";
import { Markdown, safeUrlTransform } from "../entries/Markdown";
import { copyText } from "../entries/MessageActions";
import { bound, boundString, useSurfaceActions, useSurfaceData } from "./context";
import { Icon } from "./icons";
import { toneColor } from "./tones";

// ─── markdown ─────────────────────────────────────────────────────────────

/** A markdown block: the same renderer as chat (spec §5.3 — tables,
 *  code, links; raw HTML escaped; the §15 link allowlist applies). */
export function MarkdownBlockView(props: {
	block: { readonly text: Bindable<string> };
}): ReactNode {
	const text = boundString(useSurfaceData(), props.block.text);
	return (
		<div className="blk blk-markdown">
			<Markdown source={text} variant="prose" />
		</div>
	);
}

// ─── fields ───────────────────────────────────────────────────────────────

/** One label/value row (the tone and icon colour the value). */
function FieldRow(props: {
	label: string;
	value: string;
	tone: Tone;
	icon?: ReactNode;
}): ReactNode {
	return (
		<div className="blk-field-row">
			<dt dir="auto">{props.label}</dt>
			<dd dir="auto" data-tone={props.tone} style={toneColor(props.tone)}>
				{props.icon}
				{props.value}
			</dd>
		</div>
	);
}

/** A fields block: label/value pairs (spec §5.3). */
export function FieldsBlockView(props: {
	block: {
		readonly rows: Bindable<readonly {
			readonly label: Bindable<string>;
			readonly value: Bindable<JsonValue>;
			readonly tone?: Bindable<Tone>;
			readonly icon?: Bindable<IconName>;
		}[]>;
	};
}): ReactNode {
	const ctx = useSurfaceData();
	const rows = bound(ctx, props.block.rows) ?? [];
	return (
		<div className="blk blk-fields">
			<dl>
				{rows.map((row, index) => {
					const icon = bound(ctx, row.icon);
					return (
						<FieldRow
							key={index}
							label={boundString(ctx, row.label)}
							value={formatValue(
								bound(ctx, row.value) ?? null,
								undefined,
								ctx.locale,
							)}
							tone={bound(ctx, row.tone) ?? "neutral"}
							icon={icon === undefined ? undefined : <Icon name={icon} />}
						/>
					);
				})}
			</dl>
		</div>
	);
}

// ─── stat ─────────────────────────────────────────────────────────────────

/** A stat's sparkline as one polyline (Task 2's charts own axes). */
function Sparkline(props: { points: readonly number[] }): ReactNode {
	const { points } = props;
	if (points.length < 2) return null;
	const min = Math.min(...points);
	const max = Math.max(...points);
	const span = max - min || 1;
	const width = 100;
	const height = 24;
	const d = points
		.map((point, index) => {
			const x = (index / (points.length - 1)) * width;
			const y = height - ((point - min) / span) * height;
			return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
		})
		.join(" ");
	return (
		<svg
			className="blk-spark"
			viewBox={`0 0 ${width} ${height}`}
			preserveAspectRatio="none"
			aria-hidden="true"
		>
			<path d={d} fill="none" stroke="currentColor" strokeWidth={2} />
		</svg>
	);
}

/** A stat block: label, formatted value (+unit), caption, sparkline. */
export function StatBlockView(props: {
	block: {
		readonly label: Bindable<string>;
		readonly value: Bindable<JsonValue>;
		readonly unit?: Bindable<string>;
		readonly format?: string;
		readonly tone?: Bindable<Tone>;
		readonly icon?: Bindable<IconName>;
		readonly size?: "s" | "m" | "l";
		readonly caption?: Bindable<string>;
		readonly sparkline?: Bindable<readonly number[]>;
	};
}): ReactNode {
	const ctx = useSurfaceData();
	const icon = bound(ctx, props.block.icon);
	const unit = boundString(ctx, props.block.unit);
	const caption = boundString(ctx, props.block.caption);
	const tone = bound(ctx, props.block.tone) ?? "neutral";
	const sparkline = bound(ctx, props.block.sparkline);
	return (
		<div
			className="blk blk-stat"
			data-block="stat"
			data-size={props.block.size ?? "m"}
			data-tone={tone}
		>
			<div className="blk-stat-top">
				{icon !== undefined && <Icon name={icon} />}
				<div className="blk-stat-label" dir="auto">
					{boundString(ctx, props.block.label)}
				</div>
			</div>
			<div className="blk-stat-value" dir="auto" style={toneColor(tone)}>
				{formatValue(bound(ctx, props.block.value) ?? null, props.block.format, ctx.locale)}
				{unit !== "" && <span className="blk-stat-unit"> {unit}</span>}
			</div>
			{caption !== "" && (
				<div className="blk-stat-caption" dir="auto">
					{caption}
				</div>
			)}
			{sparkline !== undefined && sparkline.length > 1 && <Sparkline points={sparkline} />}
		</div>
	);
}

// ─── callout ──────────────────────────────────────────────────────────────

/** A callout block: tone, title, markdown body, action buttons. */
export function CalloutBlockView(props: {
	block: {
		readonly tone: Bindable<Tone>;
		readonly title: Bindable<string>;
		readonly body?: Bindable<string>;
		readonly actions?: readonly ActionButton[];
	};
}): ReactNode {
	const ctx = useSurfaceData();
	const tone = bound(ctx, props.block.tone) ?? "neutral";
	const body = boundString(ctx, props.block.body);
	return (
		<div className="blk blk-callout" data-block="callout" data-tone={tone}>
			<div className="blk-callout-title" dir="auto" style={toneColor(tone)}>
				{boundString(ctx, props.block.title)}
			</div>
			{body !== "" && (
				<div className="blk-callout-body">
				<Markdown source={body} variant="prose" />
				</div>
			)}
			{props.block.actions !== undefined && props.block.actions.length > 0 && (
				<ActionButtonRow buttons={props.block.actions} />
			)}
		</div>
	);
}

// ─── image ────────────────────────────────────────────────────────────────

/** An image block: shown at its aspect ratio, `alt` on failure
 *  (spec §5.3/§11 — the server has already rewritten `https:` sources
 *  to the proxy, so the client renders `src` as given). */
export function ImageBlockView(props: {
	block: { readonly src: Bindable<string>; readonly alt: Bindable<string> };
}): ReactNode {
	const ctx = useSurfaceData();
	const [failed, setFailed] = useState(false);
	const src = boundString(ctx, props.block.src);
	const alt = boundString(ctx, props.block.alt);
	if (failed || src === "") {
		return (
			<div className="blk blk-image-fallback" dir="auto">
				{alt}
			</div>
		);
	}
	return (
		<img
			className="blk blk-image"
			src={src}
			alt={alt}
			loading="lazy"
			onError={() => {
				setFailed(true);
			}}
		/>
	);
}

// ─── diff ─────────────────────────────────────────────────────────────────

/** A diff block: before/after panes with the path (the interaction
 *  primitive, spec §5.3). */
export function DiffBlockView(props: {
	block: {
		readonly before: string;
		readonly after: string;
		readonly path?: string;
		readonly lang?: string;
	};
}): ReactNode {
	const path = props.block.path;
	return (
		<div className="blk blk-diff" data-block="diff">
			{path !== undefined && path !== "" && (
				<div className="blk-diff-path" dir="auto">
					{path}
				</div>
			)}
			<div className="blk-diff-panes">
				<pre className="blk-diff-before" dir="auto">
					{props.block.before}
				</pre>
				<pre className="blk-diff-after" dir="auto">
					{props.block.after}
				</pre>
			</div>
		</div>
	);
}

// ─── details ──────────────────────────────────────────────────────────────

/** Pretty-print JSON with recursively sorted keys (the §14.3
 *  determinism rule — the same input renders the same bytes). */
function prettySorted(value: JsonValue, indent: string): string {
	if (Array.isArray(value)) {
		const items = value.map((item) => prettySorted(item, `${indent}  `));
		return items.length === 0
			? "[]"
			: `[\n${items.map((item) => `${indent}  ${item}`).join(",\n")}\n${indent}]`;
	}
	if (value !== null && typeof value === "object") {
		const entries = Object.keys(value)
			.sort()
			.map((key) => `${indent}  ${JSON.stringify(key)}: ${prettySorted(value[key], `${indent}  `)}`);
		return entries.length === 0
			? "{}"
			: `{\n${entries.join(",\n")}\n${indent}}`;
	}
	return JSON.stringify(value) ?? "null";
}

/** A details block: opaque JSON, collapsed until expanded (spec §5.3). */
export function DetailsBlockView(props: { block: { readonly value: JsonValue } }): ReactNode {
	const [open, setOpen] = useState(false);
	return (
		<details className="blk blk-details" data-block="details" open={open}>
			<summary
				onClick={(event) => {
					// The native toggle does not fire under test renderers;
					// own the state so both environments agree.
					event.preventDefault();
					setOpen(!open);
				}}
			>
				Details
			</summary>
			{open && (
				<pre className="blk-details-json" dir="auto">
					{prettySorted(props.block.value, "")}
				</pre>
			)}
		</details>
	);
}

// ─── action buttons (spec §6.1/§6.2) ──────────────────────────────────────

/** The actions that stay under `access: "read"` (spec §6.5: the channel
 *  hides every EDIT and ANSWER action — view-only ones remain). */
function isViewOnly(action: Action): boolean {
	return (
		action.type === "copy" || action.type === "open" || action.type === "navigate"
	);
}

/** The pending confirmation an action's `confirm` opened. */
interface PendingConfirm {
	button: ActionButton;
	confirm: Confirm;
}

/** A row of action buttons. `copy` and `open` are channel-local; the
 *  rest dispatch through the `SurfaceActions` context; an action with
 *  `confirm` opens a dialog whose Confirm is the only dispatcher. */
export function ActionButtonRow(props: {
	buttons: readonly ActionButton[];
}): ReactNode {
	const actions = useSurfaceActions();
	const data = useSurfaceData();
	const [confirming, setConfirming] = useState<PendingConfirm | null>(null);

	const visible =
		actions.access === "write"
			? props.buttons
			: props.buttons.filter((button) => isViewOnly(button.action));

	function activate(button: ActionButton): void {
		const action = button.action;
		if (action.type === "copy") {
			copyText(
				typeof action.text === "string"
				? action.text
				: (bound<string>(data, action.text) ?? ""),
			);
			return;
		}
		if (action.type === "open") {
			const url = safeUrlTransform(action.url);
			if (url === "") return; // disallowed scheme: no tab, no dispatch
			const opener = (
				globalThis as {
					open?: (url: string, target: string, features: string) => unknown;
				}
			).open;
			opener?.(url, "_blank", "noopener");
			return;
		}
		if (action.type === "submit" || action.type === "restart") {
			if (action.confirm !== undefined) {
				setConfirming({ button, confirm: action.confirm });
				return;
			}
		}
		actions.dispatch(action, null);
	}

	if (confirming !== null) {
		const { button, confirm } = confirming;
		return (
			<div
				className="blk-confirm"
				role="dialog"
				data-tone={confirm.tone ?? "bad"}
			>
				<div className="blk-confirm-title" dir="auto">
					{confirm.title}
				</div>
				{confirm.body !== undefined && confirm.body !== "" && (
					<div className="blk-confirm-body" dir="auto">
						{confirm.body}
					</div>
				)}
				<div className="blk-confirm-row">
					<button type="button" onClick={() => setConfirming(null)}>
						Cancel
					</button>
					<button
						type="button"
						className="blk-confirm-ok"
						onClick={() => {
							setConfirming(null);
							actions.dispatch(button.action, null);
						}}
					>
						{confirm.confirmLabel ?? "Confirm"}
					</button>
				</div>
			</div>
		);
	}

	if (visible.length === 0) return null;
	return (
		<div className="blk-actions" data-block="actions">
			{visible.map((button) => {
				const icon = bound(data, button.icon);
				return (
					<button
						key={button.id}
						type="button"
						className="blk-action"
						onClick={() => activate(button)}
					>
						{icon !== undefined && <Icon name={icon} />}
						<span dir="auto">{boundString(data, button.label)}</span>
					</button>
				);
			})}
		</div>
	);
}
