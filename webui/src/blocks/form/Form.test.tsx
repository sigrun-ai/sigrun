/**
 * The form block (UI-blocks U1 Task 5, spec §5.6, §6.2): mode
 * semantics (submit / live / inline), client validation, server
 * `{error: {field}}` messages, read access, and the interaction
 * stepper (§9.1).
 *
 * Tests drive the form through the two contexts with
 * react-test-renderer; the live-mode 300 ms debounce is driven by
 * fake timers. Server field errors arrive through the
 * `serverErrors` SurfaceActions context value.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
	.IS_REACT_ACT_ENVIRONMENT = true;

import { createElement as h, act } from "react";
import TestRenderer from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
	Field,
	FormBlock,
	JsonObject,
	SectionBlock,
} from "@sigrun/shared/blocks";
import { findButton, render, textContent } from "../../test-utils";
import { SurfaceActionsContext, SurfaceDataContext } from "../context";
import { FormBlockView } from "./Form";

interface Harness {
	readonly dispatch: ReturnType<typeof vi.fn>;
	readonly renderer: TestRenderer.ReactTestRenderer;
}

function makeHarness(
	block: FormBlock,
	init?: {
		readonly data?: JsonObject;
		readonly viewState?: JsonObject;
		readonly access?: "read" | "write";
		readonly serverErrors?: Readonly<Record<string, string>>;
		readonly interaction?: boolean;
	},
): Harness {
	const dispatch = vi.fn();
	const renderer = render(
		h(
			SurfaceDataContext.Provider,
			{ value: { data: init?.data ?? {}, locale: "en-US" } },
			h(
				SurfaceActionsContext.Provider,
				{
					value: {
						dispatch,
						access: init?.access ?? "write",
						viewState: init?.viewState ?? {},
						serverErrors: init?.serverErrors ?? {},
					},
				},
				h(FormBlockView, {
					block,
					interaction: init?.interaction ?? false,
				}),
			),
		),
	);
	return { dispatch, renderer };
}

/** The acme registration form fixture the tests share. */
function registrationForm(init?: Partial<FormBlock>): FormBlock {
	return {
		type: "form",
		bind: "/registration",
		mode: "submit",
		onSubmit: "register",
		submitLabel: "Register",
		children: [
			{ type: "text", name: "name", label: "Name", required: true },
			{ type: "text", name: "handle", label: "Handle", pattern: "^[a-z]+$" },
			{ type: "number", name: "seats", label: "Seats", min: 1, max: 10 },
		],
		...init,
	} as FormBlock;
}

/** Type into the input (or textarea) whose aria-label matches. */
function typeInto(
	renderer: TestRenderer.ReactTestRenderer,
	label: string,
	value: string,
): void {
	const input = renderer.root.findAll(
		(node) =>
			(node.type === "input" || node.type === "textarea") &&
			node.props["aria-label"] === label,
	)[0];
	if (input === undefined) throw new Error(`no input labelled ${label}`);
	act(() => {
		input.props.onChange({ target: { value, checked: value === "true" } });
	});
}

describe("form mode: submit", () => {
	test("dispatches onSubmit with {values} when validation passes", () => {
		const { dispatch, renderer } = makeHarness(registrationForm(), {
			data: { registration: { name: "Acme Co", handle: "acme", seats: 3 } },
		});
		act(() => {
			findButton(renderer, "Register").props.onClick();
		});
		expect(dispatch).toHaveBeenCalledTimes(1);
		expect(dispatch).toHaveBeenCalledWith(
			{ type: "submit", name: "register" },
			{ rev: 0, values: { name: "Acme Co", handle: "acme", seats: 3 } },
		);
	});

	test("required blocks dispatch and shows the field error", () => {
		const { dispatch, renderer } = makeHarness(registrationForm(), {
			data: { registration: { handle: "acme" } },
		});
		act(() => {
			findButton(renderer, "Register").props.onClick();
		});
		expect(dispatch).not.toHaveBeenCalled();
		expect(textContent(renderer.toJSON())).toContain("Name is required");
	});

	test("pattern violation blocks dispatch", () => {
		const { dispatch, renderer } = makeHarness(registrationForm(), {
			data: { registration: { name: "Acme Co", handle: "Acme" } },
		});
		act(() => {
			findButton(renderer, "Register").props.onClick();
		});
		expect(dispatch).not.toHaveBeenCalled();
		expect(textContent(renderer.toJSON())).toContain("Handle");
	});

	test("min/max violations block dispatch", () => {
		const { dispatch, renderer } = makeHarness(registrationForm(), {
			data: { registration: { name: "Acme Co", handle: "acme", seats: 99 } },
		});
		act(() => {
			findButton(renderer, "Register").props.onClick();
		});
		expect(dispatch).not.toHaveBeenCalled();
		expect(textContent(renderer.toJSON())).toContain("at most 10");
	});

	test("minLength/maxLength violations block dispatch", () => {
		const form = {
			type: "form",
			bind: "/f",
			mode: "submit",
			onSubmit: "save",
			submitLabel: "Save",
			children: [
				{ type: "text", name: "code", label: "Code", minLength: 2, maxLength: 4 },
			],
		} as FormBlock;
		const short = makeHarness(form, { data: { f: { code: "a" } } });
		act(() => {
			findButton(short.renderer, "Save").props.onClick();
		});
		expect(short.dispatch).not.toHaveBeenCalled();
		expect(textContent(short.renderer.toJSON())).toContain(
			"at least 2 characters",
		);
		const long = makeHarness(form, { data: { f: { code: "abcde" } } });
		act(() => {
			findButton(long.renderer, "Save").props.onClick();
		});
		expect(long.dispatch).not.toHaveBeenCalled();
		expect(textContent(long.renderer.toJSON())).toContain(
			"at most 4 characters",
		);
	});
});

describe("form server errors", () => {
	test("serverErrors context values render under the named field", () => {
		const { renderer } = makeHarness(registrationForm({ bind: "/f" }), {
			data: { f: { handle: "acme" } },
			serverErrors: { handle: "Handle is taken" },
		});
		expect(textContent(renderer.toJSON())).toContain("Handle is taken");
	});
});

describe("form mode: live", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	const liveForm = (bind: string): FormBlock =>
		({
			type: "form",
			bind,
			mode: "live",
			onSubmit: "filter",
			children: [{ type: "text", name: "query", label: "Query" }],
		}) as FormBlock;

	test("bound under /view/: no dispatch — view-only state (§6.2)", () => {
		const { dispatch, renderer } = makeHarness(liveForm("/view/filters"), {
			data: { view: { filters: { query: "" } } },
		});
		typeInto(renderer, "Query", "acme");
		act(() => {
			vi.advanceTimersByTime(400);
		});
		expect(dispatch).not.toHaveBeenCalled();
	});

	test("bound under /view/: the debounce publishes to setView so siblings see it (§6.2)", () => {
		const dispatch = vi.fn();
		const setView = vi.fn();
		const block = liveForm("/view/filters");
		const renderer = render(
			h(
				SurfaceDataContext.Provider,
				{ value: { data: {}, locale: "en-US" } },
				h(
					SurfaceActionsContext.Provider,
					{
						value: {
							dispatch,
							access: "write" as const,
							viewState: {},
							serverErrors: {},
							setView,
						},
					},
					h(FormBlockView, { block }),
				),
			),
		);
		typeInto(renderer, "Query", "acme");
		act(() => {
			vi.advanceTimersByTime(400);
		});
		expect(dispatch).not.toHaveBeenCalled();
		// The path is the bind minus the /view/ prefix; the value is the
		// flushed values object.
		expect(setView).toHaveBeenCalledWith("filters", { query: "acme" });
	});

	test("bound under /view/ with no setView provider: the default is a safe no-op", () => {
		const { dispatch, renderer } = makeHarness(liveForm("/view/filters"), {
			data: {},
		});
		typeInto(renderer, "Query", "acme");
		act(() => {
			vi.advanceTimersByTime(400);
		});
		expect(dispatch).not.toHaveBeenCalled();
		// and no throw (the default setView is a no-op)
	});

	test("bound elsewhere: dispatches an edit after 300 ms", () => {
		const { dispatch, renderer } = makeHarness(liveForm("/filters"), {
			data: { filters: { query: "" } },
		});
		typeInto(renderer, "Query", "acme");
		act(() => {
			vi.advanceTimersByTime(200);
		});
		expect(dispatch).not.toHaveBeenCalled();
		act(() => {
			vi.advanceTimersByTime(150);
		});
		expect(dispatch).toHaveBeenCalledTimes(1);
		expect(dispatch).toHaveBeenCalledWith(
			{ type: "edit", name: "filter" },
			{ values: { query: "acme" } },
		);
	});

	test("rapid changes debounce into one dispatch", () => {
		const { dispatch, renderer } = makeHarness(liveForm("/filters"), {
			data: { filters: { query: "" } },
		});
		typeInto(renderer, "Query", "a");
		act(() => {
			vi.advanceTimersByTime(100);
		});
		typeInto(renderer, "Query", "acme");
		act(() => {
			vi.advanceTimersByTime(400);
		});
		expect(dispatch).toHaveBeenCalledTimes(1);
		expect(dispatch).toHaveBeenCalledWith(
			{ type: "edit", name: "filter" },
			{ values: { query: "acme" } },
		);
	});
});

describe("form mode: inline", () => {
	test("renders one row with a button and clears on success", () => {
		const form = {
			type: "form",
			bind: "/quick",
			mode: "inline",
			onSubmit: "add",
			submitLabel: "Add",
			children: [{ type: "text", name: "title", label: "Title" }],
		} as FormBlock;
		const { dispatch, renderer } = makeHarness(form, {
			data: { quick: { title: "" } },
		});
		expect(
			renderer.root.findByProps({ "data-mode": "inline" }),
		).toBeDefined();
		typeInto(renderer, "Title", "Buy milk");
		act(() => {
			findButton(renderer, "Add").props.onClick();
		});
		expect(dispatch).toHaveBeenCalledWith(
			{ type: "submit", name: "add" },
			{ rev: 0, values: { title: "Buy milk" } },
		);
		// clears on success (the dispatch observable did not throw)
		const input = renderer.root.findAll(
			(node) => node.type === "input" && node.props["aria-label"] === "Title",
		)[0];
		expect(input?.props.value).toBe("");
	});
});

describe("form access: read", () => {
	test("read access disables every field and hides submit", () => {
		const { renderer } = makeHarness(registrationForm(), {
			data: { registration: { name: "Acme Co" } },
			access: "read",
		});
		const inputs = renderer.root.findAll(
			(node) => node.type === "input" || node.type === "textarea",
		);
		expect(inputs.length).toBeGreaterThan(0);
		for (const input of inputs) {
			expect(input.props.disabled).toBe(true);
		}
		expect(
			renderer.root.findAllByType("button").filter((button) =>
				(button.children ?? []).some(
					(child) => typeof child === "string" && child.trim() === "Register",
				),
			),
		).toHaveLength(0);
	});
});

describe("interaction stepper (§9.1)", () => {
	const choiceSection = (title: string, name: string): SectionBlock =>
		({
			type: "section",
			title,
			children: [
				{
					type: "choice",
					name,
					label: title,
					options: [
						{ id: "a", label: "Alpha" },
						{ id: "b", label: "Beta" },
					],
				} as Field,
			],
		}) as SectionBlock;

	const stepperForm = (): FormBlock =>
		({
			type: "form",
			bind: "/answers",
			mode: "submit",
			onSubmit: "answer",
			submitLabel: "Submit answers",
			children: [choiceSection("First question", "q1"), choiceSection("Second question", "q2")],
		}) as FormBlock;

	test("an interaction form with several choice sections steps one at a time with a review step", () => {
		const { dispatch, renderer } = makeHarness(stepperForm(), {
			data: { answers: {} },
			interaction: true,
		});
		// step 1 shows only the first question
		const firstText = textContent(renderer.toJSON());
		expect(firstText).toContain("First question");
		expect(firstText).not.toContain("Second question");
		// choose an option, advance
		const option = renderer.root.findAll(
			(node) => node.type === "input" && node.props.value === "a",
		)[0];
		act(() => {
			option.props.onChange({ target: { value: "a", checked: true } });
		});
		act(() => {
			findButton(renderer, "Next").props.onClick();
		});
		const secondText = textContent(renderer.toJSON());
		expect(secondText).toContain("Second question");
		expect(secondText).not.toContain("First question");
		act(() => {
			findButton(renderer, "Review").props.onClick();
		});
		// review lists both answers; nothing dispatched yet
		const reviewText = textContent(renderer.toJSON());
		expect(reviewText).toContain("First question");
		expect(reviewText).toContain("Second question");
		expect(dispatch).not.toHaveBeenCalled();
		// submits ONCE with both values
		act(() => {
			findButton(renderer, "Submit answers").props.onClick();
		});
		expect(dispatch).toHaveBeenCalledTimes(1);
		expect(dispatch).toHaveBeenCalledWith(
			{ type: "submit", name: "answer" },
			{ rev: 0, values: { q1: "a", q2: "" } },
		);
	});
});
