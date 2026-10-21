/**
 * Interactions (the seam's channel half, docs/approval-ux-seams.md): the
 * generic pending-decision card stack.
 *
 * Rendering contract (what the webui commits to): the envelope state, the
 * four primitives generically (text as prose; options as buttons — tone
 * colors, `recommended` pre-selected, multi via checkboxes; fields as a
 * light form, `secret` masked; diff as a before/after view), and `details`
 * as collapsed generic JSON — never interpreted.
 *
 * The answer goes through the one generic route; resolution semantics stay
 * extension-owned. `answerIds` on a single-choice card sends `ids`; the
 * multi variant accumulates then submits; fields submit `values`; free
 * text submits `text`. A card for a record with NO affordance primitives
 * still renders (text/details) but offers no answer controls — the
 * extension owns how that record resolves.
 */

import { useState } from "react";
import type {
	InteractionFieldWire,
	InteractionOptionWire,
	InteractionWire,
	SigrunClient,
} from "../api";

const TONE_CLASS: Record<string, string> = {
	danger: "interaction-option-danger",
	warn: "interaction-option-warn",
	ok: "interaction-option-ok",
	neutral: "interaction-option-neutral",
};

function OptionsBlock(props: {
	options: readonly InteractionOptionWire[];
	multi: boolean;
	disabled: boolean;
	onAnswerIds: (ids: readonly string[]) => void;
}) {
	const { options, multi, disabled, onAnswerIds } = props;
	const [selected, setSelected] = useState<readonly string[]>(
		options.filter((o) => o.recommended === true).map((o) => o.id),
	);
	const toggle = (id: string): void => {
		if (multi) {
			setSelected((current) =>
				current.includes(id)
					? current.filter((x) => x !== id)
					: [...current, id],
			);
		} else {
			setSelected([id]);
		}
	};
	return (
		<div className="interaction-options">
			{options.map((option) => (
				<label
					key={option.id}
					className={`interaction-option ${TONE_CLASS[option.tone ?? "neutral"] ?? ""}`}
				>
					<input
						type={multi ? "checkbox" : "radio"}
						name="interaction-option"
						checked={selected.includes(option.id)}
						onChange={() => toggle(option.id)}
						disabled={disabled}
					/>
					<span className="interaction-option-label">{option.label}</span>
					{option.description !== undefined && (
						<span className="interaction-option-description">
							{option.description}
						</span>
					)}
				</label>
			))}
			<button
				type="button"
				className="interaction-submit"
				disabled={disabled || selected.length === 0}
				onClick={() => onAnswerIds(selected)}
			>
				Submit
			</button>
		</div>
	);
}

function FieldsBlock(props: {
	fields: readonly InteractionFieldWire[];
	disabled: boolean;
	onAnswerValues: (values: Record<string, string | number | boolean>) => void;
}) {
	const { fields, disabled, onAnswerValues } = props;
	const [values, setValues] = useState<Record<string, string>>({});
	const missing = fields.find(
		(f) => f.required === true && (values[f.name] ?? "") === "",
	);
	return (
		<div className="interaction-fields">
			{fields.map((field) => (
				<label key={field.name} className="interaction-field">
					<span className="interaction-field-label">
						{field.label ?? field.name}
						{field.required === true ? " *" : ""}
					</span>
					<input
						type={field.type === "secret" ? "password" : "text"}
						inputMode={field.type === "number" ? "numeric" : undefined}
						value={values[field.name] ?? ""}
						onChange={(event) =>
							setValues((current) => ({
								...current,
								[field.name]: event.target.value,
							}))
						}
						disabled={disabled}
					/>
				</label>
			))}
			<button
				type="button"
				className="interaction-submit"
				disabled={disabled || missing !== undefined}
				onClick={() =>
					onAnswerValues(
						Object.fromEntries(
							fields.map((f) => {
								const raw = values[f.name] ?? "";
								return [
									f.name,
									f.type === "number" && raw !== "" ? Number(raw) : raw,
								];
							}),
						),
					)
				}
			>
				Submit
			</button>
		</div>
	);
}

/** One pending interaction card. */
export function InteractionCard(props: {
	conversationId: number;
	interaction: InteractionWire;
	client: SigrunClient;
	onAnswered?: (callId: string) => void;
	onError?: (message: string) => void;
}) {
	const { conversationId, interaction, client, onAnswered, onError } = props;
	const [busy, setBusy] = useState(false);

	async function answer(answer: {
		ids?: readonly string[];
		values?: Record<string, string | number | boolean>;
		text?: string;
	}): Promise<void> {
		setBusy(true);
		try {
			await client.answerInteraction(conversationId, interaction.callId, answer);
			onAnswered?.(interaction.callId);
		} catch (cause) {
			onError?.(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	}

	const body = interaction.body;
	const options = body?.options ?? [];
	const fields = body?.fields ?? [];
	// multiSelect rides the record level: an extension may declare it in
	// `details.multi` (the only place open to it without a schema bump).
	const multiSelect =
		(interaction.details as { multi?: boolean } | undefined)?.multi === true;
	const hasAffordance = options.length > 0 || fields.length > 0;

	return (
		<div className="interaction-card" data-kind={interaction.kind}>
			<div className="interaction-card-title">
				<span className="interaction-kind">{interaction.kind}</span>
				{interaction.expiresAt !== undefined && (
					<span className="interaction-expiry">expires</span>
				)}
			</div>
			{body?.text !== undefined && (
				<p className="interaction-text">{body.text}</p>
			)}
			{body?.diff !== undefined && (
				<div className="interaction-diff">
					<pre className="interaction-diff-before">{body.diff.before}</pre>
					<pre className="interaction-diff-after">{body.diff.after}</pre>
				</div>
			)}
			{options.length > 0 && (
				<OptionsBlock
					options={options}
					multi={multiSelect}
					disabled={busy}
					onAnswerIds={(ids) => void answer({ ids })}
				/>
			)}
			{options.length === 0 && fields.length > 0 && (
				<FieldsBlock
					fields={fields}
					disabled={busy}
					onAnswerValues={(values) => void answer({ values })}
				/>
			)}
			{!hasAffordance && interaction.details !== undefined && (
				<details className="interaction-details">
					<summary>details</summary>
					<pre>{JSON.stringify(interaction.details, null, 2)}</pre>
				</details>
			)}
			{hasAffordance && interaction.details !== undefined && (
				<details className="interaction-details">
					<summary>details</summary>
					<pre>{JSON.stringify(interaction.details, null, 2)}</pre>
				</details>
			)}
		</div>
	);
}

/** The pending card stack (replaces the old single-kind card strip). */
export function InteractionCards(props: {
	conversationId: number | null;
	interactions: readonly InteractionWire[];
	client: SigrunClient;
	onAnswered?: (callId: string) => void;
	onError?: (message: string) => void;
}) {
	const { conversationId, interactions, client, onAnswered, onError } = props;
	if (conversationId === null || interactions.length === 0) return null;
	return (
		<div className="interaction-cards">
			{interactions.map((interaction) => (
				<InteractionCard
					key={interaction.callId}
					conversationId={conversationId}
					interaction={interaction}
					client={client}
					onAnswered={onAnswered}
					onError={onError}
				/>
			))}
		</div>
	);
}
