/**
 * The card template (UI-blocks U1 Task 3, spec §5.5.1): the fixed slots
 * every collection display renders per item. Every slot except `title`
 * is optional and takes a binding relative to the item (`./` pointers,
 * spec §4.2) — each card renders under a `SurfaceData` provider whose
 * `item` is the item, so the `bound` helpers resolve per item.
 *
 * Slot rules (spec §5.5.1):
 * - `body` is markdown, clamped to 4 lines in `list`/`lanes` (a class
 *   the CSS enforces), full elsewhere;
 * - `meta` facts: `{icon?, text}`, `{person: {user, name}}` shows the
 *   `name` (the extension supplies the display name), `{time, format}`;
 * - `tone` renders an accent stripe;
 * - `actions` shows up to 3 buttons, the rest behind an overflow menu;
 * - `status` is a badge, with an activity spinner beside the label when
 *   `spinner` is set;
 * - `deps` lists item ids as "after: …" markers.
 *
 * Text slots carry `dir="auto"` and wrap/ellipsize in CSS so long
 * unbroken strings never widen the container (Task 1 review focus 4).
 */

import { useState, type ReactNode } from "react";
import type {
	Card,
	CardMeta,
	IconName,
	JsonValue,
} from "@sigrun/shared/blocks";
import { formatValue } from "@sigrun/shared/blocks";
import { Markdown } from "../../entries/Markdown";
import {
	SurfaceDataContext,
	bound,
	boundString,
	useSurfaceData,
	type SurfaceDataCtx,
} from "../context";
import { ActionButtonRow } from "../content";
import { Icon } from "../icons";
import { toneBackground } from "../tones";

/** The displays a card can render in — drives the body clamp (lists and
 *  lanes clamp to 4 lines; `detail`/everything else shows it full). */
export type CardDisplay = "list" | "lanes" | "table" | "grid" | "detail";

/** One card, rendered for `item` under the item-scoped data context. */
export function CardView(props: {
	card: Card;
	item: import("@sigrun/shared/blocks").JsonValue;
	display: CardDisplay;
}): ReactNode {
	const ctx = useSurfaceData();
	const scoped: SurfaceDataCtx = { ...ctx, item: props.item };
	return (
		<SurfaceDataContext.Provider value={scoped}>
			<CardInner card={props.card} display={props.display} />
		</SurfaceDataContext.Provider>
	);
}

/** The card body, with `item` already scoped in the data context. */
function CardInner(props: { card: Card; display: CardDisplay }): ReactNode {
	const ctx = useSurfaceData();
	const card = props.card;
	const eyebrow = boundString(ctx, card.eyebrow);
	const title = boundString(ctx, card.title);
	const subtitle = boundString(ctx, card.subtitle);
	const body = boundString(ctx, card.body);
	const image = boundString(ctx, card.image);
	const icon = bound(ctx, card.icon);
	const tone = bound(ctx, card.tone);
	const quiet = bound(ctx, card.quiet);
	const deps = bound<readonly string[]>(ctx, card.deps);
	const clamped = props.display === "list" || props.display === "lanes";

	return (
		<div
			className="blk blk-card"
			data-block="card"
			data-tone={tone ?? "neutral"}
			data-quiet={quiet === true ? true : undefined}
		>
			{tone !== undefined && (
				<div className="blk-card-stripe" style={toneBackground(tone)} />
			)}
			{image !== "" && (
				<img
					className="blk-card-image"
					data-layout={props.display === "grid" ? "top" : "thumb"}
					src={image}
					alt=""
				/>
			)}
			<div className="blk-card-main">
				<div className="blk-card-head">
					{icon !== undefined && (
						<span className="blk-card-icon">
							<Icon name={icon} />
						</span>
					)}
					<div className="blk-card-titles">
						{eyebrow !== "" && (
							<div className="blk-card-eyebrow" dir="auto">
								{eyebrow}
							</div>
						)}
						<div className="blk-card-title" dir="auto">
							{title}
						</div>
						{subtitle !== "" && (
							<div className="blk-card-subtitle" dir="auto">
								{subtitle}
							</div>
						)}
					</div>
					{card.status !== undefined && <CardStatusSlot card={card} />}
				</div>
				{body !== "" && (
					<div
						className="blk-card-body"
						data-clamped={clamped ? true : undefined}
					>
						<Markdown source={body} variant="prose" />
					</div>
				)}
				<CardBadges card={card} />
				<CardMetaRow card={card} />
				<CardMetrics card={card} />
				{deps !== undefined && deps.length > 0 && (
					<div className="blk-card-deps" dir="auto">
						after: {deps.join(", ")}
					</div>
				)}
				<CardActions card={card} />
			</div>
		</div>
	);
}

/** The status badge (§5.5.1): label + tone; `spinner` adds an activity
 *  indicator beside the label. */
function CardStatusSlot(props: { card: Card }): ReactNode {
	const ctx = useSurfaceData();
	const status = props.card.status;
	if (status === undefined) return null;
	const label = boundString(ctx, status.label);
	const tone = bound(ctx, status.tone);
	const spinner = bound(ctx, status.spinner) === true;
	if (label === "" && !spinner) return null;
	return (
		<div className="blk-card-status" data-tone={tone ?? "neutral"}>
			{spinner && <span className="blk-card-spinner" data-spinner="true" />}
			<span dir="auto">{label}</span>
		</div>
	);
}

/** The badge row (§5.5.1): `{text, tone?}[]`. */
function CardBadges(props: { card: Card }): ReactNode {
	const ctx = useSurfaceData();
	const badges = props.card.badges ?? [];
	const rendered = badges
		.map((badge, index) => {
			const text = boundString(ctx, badge.text);
			if (text === "") return null;
			return (
				<span
					key={index}
					className="blk-card-badge"
					data-tone={bound(ctx, badge.tone) ?? "neutral"}
					dir="auto"
				>
					{text}
				</span>
			);
		})
		.filter((node) => node !== null);
	if (rendered.length === 0) return null;
	return <div className="blk-card-badges">{rendered}</div>;
}

/** The meta row (§5.5.1): inline facts; a person fact shows its `name`;
 *  a time fact formats per `format`. */
function CardMetaRow(props: { card: Card }): ReactNode {
	const ctx = useSurfaceData();
	const metas = props.card.meta ?? [];
	const rendered = metas
		.map((meta, index) => renderMeta(ctx, meta, index))
		.filter((node) => node !== null);
	if (rendered.length === 0) return null;
	return <div className="blk-card-meta">{rendered}</div>;
}

/** One meta fact (the three §5.5.1 shapes, distinguished by key). */
function renderMeta(
	ctx: SurfaceDataCtx,
	meta: CardMeta,
	index: number,
): ReactNode {
	if ("person" in meta) {
		const name = boundString(ctx, meta.person.name);
		if (name === "") return null;
		return (
			<span key={index} className="blk-card-meta-item" dir="auto">
				<Icon name={"user" satisfies IconName} />
				{name}
			</span>
		);
	}
	if ("time" in meta) {
		const time = bound<string>(ctx, meta.time);
		const text = formatValue(
			typeof time === "string" || typeof time === "number" ? time : "",
			meta.format,
			ctx.locale,
		);
		if (text === "") return null;
		return (
			<span key={index} className="blk-card-meta-item" dir="auto">
				<Icon name={"clock" satisfies IconName} />
				{text}
			</span>
		);
	}
	const text = boundString(ctx, meta.text);
	if (text === "") return null;
	const icon = "icon" in meta ? bound(ctx, meta.icon) : undefined;
	return (
		<span key={index} className="blk-card-meta-item" dir="auto">
			{icon !== undefined && <Icon name={icon} />}
			{text}
		</span>
	);
}

/** The metric row (§5.5.1): `{label, value, format?}[]`. */
function CardMetrics(props: { card: Card }): ReactNode {
	const ctx = useSurfaceData();
	const metrics = props.card.metrics ?? [];
	const rendered = metrics
		.map((metric, index) => {
			const label = boundString(ctx, metric.label);
			const value = bound<JsonValue>(ctx, metric.value);
			if (label === "" || value === undefined) return null;
			return (
				<span key={index} className="blk-card-metric" dir="auto">
					<span className="blk-card-metric-value">
						{formatValue(value, metric.format, ctx.locale)}
					</span>
					<span className="blk-card-metric-label">{label}</span>
				</span>
			);
		})
		.filter((node) => node !== null);
	if (rendered.length === 0) return null;
	return <div className="blk-card-metrics">{rendered}</div>;
}

/** The action slot (§5.5.1): up to 3 buttons, the rest behind an
 *  overflow menu (a `details` disclosure — no view state to move). */
function CardActions(props: { card: Card }): ReactNode {
	const actions = props.card.actions ?? [];
	if (actions.length === 0) return null;
	const direct = actions.slice(0, 3);
	const overflow = actions.slice(3);
	return (
		<div className="blk-card-actions">
			<ActionButtonRow buttons={direct} />
			{overflow.length > 0 && (
				<details className="blk-card-overflow">
					<summary aria-label="More actions">
						<Icon name={"more" satisfies IconName} />
					</summary>
					<ActionButtonRow buttons={overflow} />
				</details>
			)}
		</div>
	);
}
