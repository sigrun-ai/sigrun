/**
 * InteractionCards + AmbientPanels (UI-blocks U6 Task 3): the seam's
 * channel rendering FROM BLOCK TREES (docs/approval-ux-seams.md; spec
 * §9.1/§9.2). Covered here:
 *
 * - an interaction card renders its tree (a root form) and submits
 *   `{values}` through the one generic answer route;
 * - a multi-question form (several choice sections) renders the
 *   stepper with a review and submits ONCE;
 * - expiry mid-stepper: the answer route 404s, the card refetches and
 *   shows the settled status, typed values stay visible and read-only;
 * - a settled interaction renders read-only with its answer;
 * - ambient `status` renders one line, `footer` renders its zones,
 *   `panel` renders its tree above the composer; a quiet card folds
 *   behind "N more".
 *
 * react-test-renderer harness, same pattern as the entry tests. Tests
 * own their literals.
 */

import { act, createElement as h } from "react";
import { describe, expect, test, vi } from "vitest";
import { render, textContent } from "../test-utils";
import type { Tree } from "@sigrun/shared/blocks";
import type { AmbientWire, InteractionWire, SigrunClient } from "../api";
import { ApiError } from "../api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
	.IS_REACT_ACT_ENVIRONMENT = true;

import { InteractionCard, InteractionCards } from "./InteractionCards";
import { AmbientPanel, AmbientPanels } from "./AmbientPanels";

const TREE_V = 1;

/** A root form with the given children (the §9.1 interaction shape). */
function formTree(children: readonly unknown[]): Tree {
	return {
		v: TREE_V,
		root: {
			type: "form",
			id: "ask",
			bind: "/values",
			mode: "submit",
			children,
		},
	} as Tree;
}

/** One choice section (the stepper's per-question shape, §9.1). */
function questionSection(name: string, label: string, options: readonly { id: string; label: string }[]): unknown {
	return {
		type: "section",
		title: label,
		children: [{ type: "choice", name, label, options }],
	};
}

function makeClient(overrides: Partial<SigrunClient> = {}): SigrunClient {
	return {
		answerInteraction: vi.fn().mockResolvedValue({
			callId: "c1",
			status: "answered",
			answer: { values: { decision: "allow" } },
		}),
		getInteraction: vi.fn(),
		...overrides,
	} as unknown as SigrunClient;
}

const BASE: InteractionWire = {
	kind: "fixture.ask",
	callId: "c1",
	status: "pending",
	createdAt: 1,
};

describe("InteractionCard (tree rendering)", () => {
	test("renders the tree's markdown and choice; answering submits {values}", async () => {
		const answerInteraction = vi.fn().mockResolvedValue({
			callId: "c1",
			status: "answered",
			answer: { values: { decision: "allow" } },
		});
		const client = makeClient({ answerInteraction });
		const interaction: InteractionWire = {
			...BASE,
			body: formTree([
				{
					type: "section",
					children: [{ type: "markdown", text: "allow this?" }],
				},
				{
					type: "choice",
					name: "decision",
					label: "Verdict",
					options: [
						{ id: "allow", label: "Allow", tone: "good", recommended: true },
						{ id: "deny", label: "Deny", tone: "bad" },
					],
				},
			]),
		};
		const renderer = render(
			h(InteractionCard, { conversationId: 7, interaction, client }),
		);
		expect(textContent(renderer.toJSON())).toContain("fixture.ask");
		expect(textContent(renderer.toJSON())).toContain("allow this?");
		// recommended pre-selected, then submit → the generic route
		// carries `{values}` (ruling 20).
		const submit = renderer.root.find(
			(node) =>
				node.type === "button" &&
				typeof node.props.className === "string" &&
				node.props.className.includes("blk-form-submit"),
		);
		await act(async () => {
			submit.props.onClick();
		});
		expect(answerInteraction).toHaveBeenCalledWith(7, "c1", {
			values: { decision: "allow" },
		});
	});

	test("a multi-question form renders the stepper with review and submits once", async () => {
		const answerInteraction = vi.fn().mockResolvedValue({
			callId: "c1",
			status: "answered",
			answer: { values: { q1: "a", q2: "x" } },
		});
		const client = makeClient({ answerInteraction });
		const interaction: InteractionWire = {
			...BASE,
			body: formTree([
				questionSection("q1", "First", [
					{ id: "a", label: "A" },
					{ id: "b", label: "B" },
				]),
				questionSection("q2", "Second", [
					{ id: "x", label: "X" },
					{ id: "y", label: "Y" },
				]),
			]),
		};
		const renderer = render(
			h(InteractionCard, { conversationId: 7, interaction, client }),
		);
		// Stepper: one question at a time ("Step 1 of 2").
		expect(textContent(renderer.toJSON())).toContain("Step 1 of 2");
		// Answer step 1 (click the first choice's radio), advance, answer
		// step 2, review, submit once.
		const radios = renderer.root.findAllByProps({ type: "radio" });
		await act(async () => {
			radios[0].props.onChange({ target: { value: radios[0].props.value } });
		});
		// Find the Next button by its text.
		const nextButton = renderer.root.findAllByType("button" as never).find(
			(b) => textContent((b as never)) === "Next",
		);
		expect(nextButton).toBeDefined();
		await act(async () => {
			nextButton?.props.onClick();
		});
		expect(textContent(renderer.toJSON())).toContain("Step 2 of 2");
		const radios2 = renderer.root.findAllByProps({ type: "radio" });
		await act(async () => {
			radios2[0].props.onChange({ target: { value: radios2[0].props.value } });
		});
		const reviewButton = renderer.root.findAllByType("button" as never).find(
			(b) => textContent(b as never) === "Review",
		);
		await act(async () => {
			reviewButton?.props.onClick();
		});
		// The review step lists both answers.
		const text = textContent(renderer.toJSON());
		expect(text).toContain("a");
		expect(text).toContain("x");
		const submit = renderer.root.findAllByType("button" as never).find(
			(b) =>
				typeof (b.props as { className?: string }).className === "string" &&
				(b.props as { className: string }).className.includes("blk-form-submit"),
		);
		await act(async () => {
			submit?.props.onClick();
		});
		expect(answerInteraction).toHaveBeenCalledTimes(1);
		expect(answerInteraction).toHaveBeenCalledWith(7, "c1", {
			values: { q1: "a", q2: "x" },
		});
	});

	test("expiry mid-stepper: the 404 refetches, shows the status, keeps typed values read-only", async () => {
		const settledRecord: InteractionWire = {
			...BASE,
			status: "expired",
			settledAt: 2,
			answer: { values: { q1: "a", q2: "x" } },
		};
		const answerInteraction = vi
			.fn()
			.mockRejectedValue(new ApiError({ method: "POST", path: "/answer", status: 404, error: "not_pending" }));
		const getInteraction = vi.fn().mockResolvedValue(settledRecord);
		const client = makeClient({ answerInteraction, getInteraction });
		const interaction: InteractionWire = {
			...BASE,
			expiresAt: 100,
			body: formTree([
				questionSection("q1", "First", [{ id: "a", label: "A" }, { id: "b", label: "B" }]),
				questionSection("q2", "Second", [{ id: "x", label: "X" }, { id: "y", label: "Y" }]),
			]),
		};
		const renderer = render(
			h(InteractionCard, { conversationId: 7, interaction, client }),
		);
		// Type step 1, then submit → 404 → refetch → settled, read-only.
		const radios = renderer.root.findAllByProps({ type: "radio" });
		await act(async () => {
			radios[0].props.onChange({ target: { value: radios[0].props.value } });
		});
		const nextButton = renderer.root.findAllByType("button" as never).find(
			(b) => textContent(b as never) === "Next",
		);
		await act(async () => {
			nextButton?.props.onClick();
		});
		const radios2 = renderer.root.findAllByProps({ type: "radio" });
		await act(async () => {
			radios2[0].props.onChange({ target: { value: radios2[0].props.value } });
		});
		const reviewButton = renderer.root.findAllByType("button" as never).find(
			(b) => textContent(b as never) === "Review",
		);
		await act(async () => {
			reviewButton?.props.onClick();
		});
		const submit = renderer.root.findAllByType("button" as never).find(
			(b) =>
				typeof (b.props as { className?: string }).className === "string" &&
				(b.props as { className: string }).className.includes("blk-form-submit"),
		);
		await act(async () => {
			submit?.props.onClick();
		});
		// The refetch happened and the settled status renders.
		expect(getInteraction).toHaveBeenCalledWith(7, "c1");
		const text = textContent(renderer.toJSON());
		expect(text).toContain("expired");
		// Typed values stay visible (the read-only form still shows them).
		expect(text).toContain("a");
		// Read-only: no enabled submit remains.
		const enabledSubmit = renderer.root.findAllByType("button" as never).filter(
			(b) =>
				typeof (b.props as { className?: string }).className === "string" &&
				(b.props as { className: string }).className.includes("blk-form-submit") &&
				b.props.disabled !== true,
		);
		expect(enabledSubmit).toHaveLength(0);
	});

	test("a settled interaction renders read-only with the answer", () => {
		const client = makeClient();
		const interaction: InteractionWire = {
			...BASE,
			status: "answered",
			settledAt: 2,
			answer: { values: { decision: "allow" } },
			body: formTree([
				{
					type: "choice",
					name: "decision",
					label: "Verdict",
					options: [
						{ id: "allow", label: "Allow" },
						{ id: "deny", label: "Deny" },
					],
				},
			]),
		};
		const renderer = render(
			h(InteractionCard, { conversationId: 7, interaction, client }),
		);
		const text = textContent(renderer.toJSON());
		expect(text).toContain("answered");
		// Read access hides the submit control.
		const submits = renderer.root.findAll(
			(node) =>
				node.type === "button" &&
				typeof node.props.className === "string" &&
				node.props.className.includes("blk-form-submit"),
		);
		expect(submits).toHaveLength(0);
	});
});

describe("InteractionCards", () => {
	test("null conversation or empty list renders nothing", () => {
		const client = makeClient();
		expect(
			render(h(InteractionCards, { conversationId: null, interactions: [BASE], client })).toJSON(),
		).toBeNull();
		expect(
			render(h(InteractionCards, { conversationId: 1, interactions: [], client })).toJSON(),
		).toBeNull();
	});
});

/** One panel surface with a literal-rows collection (the §9.2 rows
 *  mapping; ambient collections never bind — the 2026-10-24 ruling). */
function rowsSurface(rows: readonly Record<string, unknown>[], init?: Partial<AmbientWire>): AmbientWire {
	return {
		key: "goal",
		owner: "ext",
		place: "panel",
		expires: "never",
		updatedAt: 1,
		body: {
			v: TREE_V,
			root: {
				type: "collection",
				id: "rows",
				items: rows,
				display: "list",
				item: {
					title: { $: "./label" },
					status: { label: { $: "./status" } },
					quiet: { $: "./quiet" },
					deps: { $: "./deps" },
					metrics: [{ label: "steps", value: { $: "./completed" } }],
				},
			},
		},
		...init,
	} as AmbientWire;
}

describe("AmbientPanel (tree rendering)", () => {
	test("a status surface renders its one-line markdown", () => {
		const surface: AmbientWire = {
			key: "powerline",
			owner: "ext",
			place: "status",
			expires: "never",
			updatedAt: 1,
			body: {
				v: TREE_V,
				root: { type: "markdown", text: "glm-5.3-flash · main*" },
			},
		} as AmbientWire;
		const renderer = render(h(AmbientPanel, { surface }));
		const text = textContent(renderer.toJSON());
		expect(text).toContain("glm-5.3-flash · main*");
	});

	test("a footer surface renders its three zone columns", () => {
		const surface: AmbientWire = {
			key: "zones",
			owner: "ext",
			place: "footer",
			expires: "never",
			updatedAt: 1,
			body: {
				v: TREE_V,
				root: {
					type: "columns",
					children: [
						{ block: { type: "markdown", text: "left-zone" } },
						{ block: { type: "markdown", text: "middle-zone" } },
						{ block: { type: "markdown", text: "right-zone" } },
					],
				},
			},
		} as AmbientWire;
		const renderer = render(h(AmbientPanel, { surface }));
		const text = textContent(renderer.toJSON());
		expect(text).toContain("left-zone");
		expect(text).toContain("middle-zone");
		expect(text).toContain("right-zone");
	});

	test("a panel surface renders literal rows; a quiet row folds behind a count", () => {
		const surface = rowsSurface([
			{ id: "r1", label: "deploy", status: "running", quiet: false, completed: 2 },
			{ id: "r2", label: "lint", status: "passed", quiet: true, completed: 1 },
		]);
		const renderer = render(h(AmbientPanel, { surface }));
		const text = textContent(renderer.toJSON());
		expect(text).toContain("deploy");
		expect(text).toContain("running");
		// The quiet row folds (the collection's quiet bucket).
		expect(text).toContain("1 more");
		expect(text).not.toContain("lint");
	});

	test("a meter-shaped panel renders its percent", () => {
		const surface: AmbientWire = {
			key: "audit",
			owner: "ext",
			place: "panel",
			expires: "never",
			updatedAt: 1,
			body: {
				v: TREE_V,
				root: { type: "meter", value: 0.62, format: "percent", label: "audit" },
			},
		} as AmbientWire;
		const renderer = render(h(AmbientPanel, { surface }));
		expect(textContent(renderer.toJSON())).toContain("62%");
	});

	test("details render collapsed", () => {
		const surface: AmbientWire = {
			key: "x",
			owner: "ext",
			place: "status",
			expires: "never",
			updatedAt: 1,
			body: {
				v: TREE_V,
				root: { type: "markdown", text: "hi" },
			},
			details: { custom: true },
		} as AmbientWire;
		const renderer = render(h(AmbientPanel, { surface }));
		expect(renderer.root.findByProps({ className: "ambient-details" })).toBeDefined();
	});
});

describe("AmbientPanels", () => {
	test("no surfaces render nothing", () => {
		expect(render(h(AmbientPanels, { surfaces: [] })).toJSON()).toBeNull();
	});
});
