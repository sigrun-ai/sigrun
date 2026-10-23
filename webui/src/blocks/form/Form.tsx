/**
 * The form block (UI-blocks U1 Task 5, spec §5.6/§6.2/§9.1): modes
 * (submit / live / inline), client validation before dispatch, the
 * live-mode 300 ms debounce with the `/view/` view-only branch, and the
 * interaction stepper — several sections each holding a `choice` in an
 * interaction placement present one question at a time with a review
 * step, submitting ONCE with every field's value.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import type {
	Field,
	FormBlock,
	JsonObject,
	JsonValue,
	SectionBlock,
} from "@sigrun/shared/blocks";
import { resolvePointer } from "@sigrun/shared/blocks";
import {
	boundString,
	useSurfaceActions,
	useSurfaceData,
} from "../context";
import { BlockView } from "../BlockView";
import { FieldView } from "./fields";
import { collectFields, initialValue, validateField } from "./values";

/** The live-mode debounce (spec §5.6: "every change is applied after
 *  300 ms"). */
export const LIVE_DEBOUNCE_MS = 300;

/** The stepper: does this form qualify (several sections each holding
 *  a choice, interaction placement)? (§9.1) */
function stepperSections(
	block: FormBlock,
	interaction: boolean,
): readonly SectionBlock[] | null {
	if (!interaction) return null;
	const sections = block.children.filter(
		(child): child is SectionBlock =>
			typeof child === "object" &&
			child !== null &&
			(child as SectionBlock).type === "section",
	);
	if (sections.length < 2) return null;
	const allChoice = sections.every((section) =>
		section.children.some(
			(child) =>
				typeof child === "object" &&
				child !== null &&
				(child as Field).type === "choice",
		),
	);
	return allChoice ? sections : null;
}

export function FormBlockView(props: {
	readonly block: FormBlock;
	/** Whether the form sits in an interaction placement (§9.1 stepper). */
	readonly interaction?: boolean;
}): ReactNode {
	const { block } = props;
	const data = useSurfaceData();
	const actions = useSurfaceActions();
	const boundObject =
		(resolvePointer(data.data, block.bind) as JsonObject | undefined) ?? {};
	const fields = collectFields(block);
	const [values, setValues] = useState<JsonObject>(() => {
		const init: JsonObject = {};
		for (const field of fields) {
			init[field.name] = initialValue(field, boundObject);
		}
		return init;
	});
	const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
	const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
	const pending = useRef<JsonObject | null>(null);

	// The live-mode debounce flushes on unmount (no timer leak).
	useEffect(
		() => () => {
			if (debounce.current !== null) clearTimeout(debounce.current);
		},
		[],
	);

	const readOnly = actions.access !== "write";

	const validate = (next: JsonObject): boolean => {
		const nextErrors: Record<string, string> = {};
		for (const field of fields) {
			const message = validateField(
				field,
				next[field.name],
				boundString(data, field.label) || field.name,
			);
			if (message !== null) nextErrors[field.name] = message;
		}
		setErrors(nextErrors);
		return Object.keys(nextErrors).length === 0;
	};

	const doSubmit = (next: JsonObject): boolean => {
		if (!validate(next)) return false;
		actions.dispatch(
			{
				type: "submit",
				name: block.onSubmit ?? "submit",
				...(block.turn === undefined ? {} : { turn: block.turn }),
			},
			{ values: { ...next } },
		);
		return true;
	};

	const change = (name: string, value: JsonValue): void => {
		setValues((current) => {
			const next = { ...current, [name]: value };
			if (block.mode === "live") {
				pending.current = next;
				if (debounce.current !== null) clearTimeout(debounce.current);
				debounce.current = setTimeout(() => {
					const flushed = pending.current;
					pending.current = null;
					if (flushed === null) return;
					if (block.bind.startsWith("/view/")) {
						// §6.2: view-only — the channel owns /view/; no dispatch.
						return;
					}
					actions.dispatch(
						{
							type: "edit",
							name: block.onSubmit ?? "edit",
							...(block.turn === undefined ? {} : { turn: block.turn }),
						},
						{ values: { ...flushed } },
					);
				}, LIVE_DEBOUNCE_MS);
			}
			return next;
		});
	};

	const submitLabel = boundString(data, block.submitLabel) || "Submit";
	const sections = stepperSections(block, props.interaction === true);

	// The stepper (§9.1): one section at a time, then a review, one
	// submit with every value.
	if (sections !== null) {
		return (
			<StepperForm
				block={block}
				sections={sections}
				values={values}
				errors={errors}
				serverErrors={actions.serverErrors ?? {}}
				disabled={readOnly}
				submitLabel={submitLabel}
				onChange={change}
				onSubmit={() => {
					doSubmit(values);
				}}
			/>
		);
	}

	const submit = (): void => {
		const ok = doSubmit(values);
		if (ok && block.mode === "inline") {
			// Inline clears on success (the dispatch did not throw).
			const cleared: JsonObject = {};
			for (const field of fields) {
				cleared[field.name] = initialValue(field, {});
			}
			setValues(cleared);
		}
	};

	return (
		<div className="blk blk-form" data-block="form" data-mode={block.mode}>
			<FormChildren
				block={block}
				values={values}
				errors={errors}
				serverErrors={actions.serverErrors ?? {}}
				disabled={readOnly}
				onChange={change}
			/>
			{block.mode !== "live" && !readOnly && (
				<button type="button" className="blk-form-submit" onClick={submit}>
					{submitLabel}
				</button>
			)}
		</div>
	);
}

/** The form's children: sections (nested) and fields. */
function FormChildren(props: {
	readonly block: FormBlock;
	readonly values: JsonObject;
	readonly errors: Readonly<Record<string, string>>;
	readonly serverErrors: Readonly<Record<string, string>>;
	readonly disabled: boolean;
	readonly onChange: (name: string, value: JsonValue) => void;
}): ReactNode {
	return (
		<>
			{props.block.children.map((child, index) => (
				<FormChild key={index} child={child} {...props} />
			))}
		</>
	);
}

function FormChild(props: {
	readonly child: Field | SectionBlock;
	readonly values: JsonObject;
	readonly errors: Readonly<Record<string, string>>;
	readonly serverErrors: Readonly<Record<string, string>>;
	readonly disabled: boolean;
	readonly onChange: (name: string, value: JsonValue) => void;
}): ReactNode {
	const child = props.child;
	if (
		typeof child === "object" &&
		child !== null &&
		(child as SectionBlock).type === "section"
	) {
		const section = child as SectionBlock;
		return (
			<div className="blk blk-section" data-block="section">
				{section.title !== undefined && (
					<SectionTitle section={section} />
				)}
				{section.children.map((nested, index) => {
					if (
						typeof nested === "object" &&
						nested !== null &&
						typeof (nested as Field).name === "string"
					) {
						const { child: _ignored, ...rest } = props;
						return (
							<FormChild key={index} {...rest} child={nested as Field} />
						);
					}
					return <BlockView key={index} block={nested as never} />;
				})}
			</div>
		);
	}
	const field = child as Field;
	return (
		<FieldView
			field={field}
			value={props.values[field.name]}
			disabled={props.disabled || field.disabled === true}
			error={props.errors[field.name] ?? props.serverErrors[field.name]}
			onChange={props.onChange}
		/>
	);
}

function SectionTitle(props: { readonly section: SectionBlock }): ReactNode {
	const data = useSurfaceData();
	return (
		<h3 className="blk-section-title" dir="auto">
			{boundString(data, props.section.title)}
		</h3>
	);
}

/** The stepper presentation (§9.1): one choice section at a time, a
 *  review, then a single submit. */
function StepperForm(props: {
	readonly block: FormBlock;
	readonly sections: readonly SectionBlock[];
	readonly values: JsonObject;
	readonly errors: Readonly<Record<string, string>>;
	readonly serverErrors: Readonly<Record<string, string>>;
	readonly disabled: boolean;
	readonly submitLabel: string;
	readonly onChange: (name: string, value: JsonValue) => void;
	readonly onSubmit: () => void;
}): ReactNode {
	const [step, setStep] = useState(0);
	const total = props.sections.length;
	const reviewing = step >= total;
	const section = reviewing ? undefined : props.sections[step];

	return (
		<div className="blk blk-form blk-stepper" data-block="form" data-step={step}>
			{section !== undefined ? (
				<>
					<div className="blk-stepper-progress">
						Step {step + 1} of {total}
					</div>
					<FormChild
						child={section}
						values={props.values}
						errors={props.errors}
						serverErrors={props.serverErrors}
						disabled={props.disabled}
						onChange={props.onChange}
					/>
					<div className="blk-stepper-nav">
						{step > 0 && (
							<button type="button" onClick={() => setStep(step - 1)}>
								Back
							</button>
						)}
						<button type="button" onClick={() => setStep(step + 1)}>
							{step + 1 === total ? "Review" : "Next"}
						</button>
					</div>
				</>
			) : (
				<>
					<div className="blk-stepper-review">
						{props.sections.map((item, index) => {
							const choice = item.children.find(
								(child) =>
									typeof child === "object" &&
									child !== null &&
									(child as Field).type === "choice",
							) as Field | undefined;
							const value = choice === undefined ? undefined : props.values[choice.name];
							return (
								<div key={index} className="blk-stepper-review-row">
									<SectionTitle section={item} />
									<span dir="auto">{typeof value === "string" ? value : JSON.stringify(value)}</span>
								</div>
							);
						})}
					</div>
					<div className="blk-stepper-nav">
						<button type="button" onClick={() => setStep(total - 1)}>
							Back
						</button>
						{!props.disabled && (
							<button
								type="button"
								className="blk-form-submit"
								onClick={props.onSubmit}
							>
								{props.submitLabel}
							</button>
						)}
					</div>
				</>
			)}
		</div>
	);
}
