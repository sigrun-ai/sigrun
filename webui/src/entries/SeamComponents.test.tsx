/**
 * InteractionCards + AmbientPanels: the seam's channel rendering
 * (docs/approval-ux-seams.md contract). react-test-renderer harness, same
 * pattern as the entry tests.
 */

import { act, createElement as h } from "react";
import { describe, expect, test, vi } from "vitest";
import { render, textContent } from "../test-utils";
import type {
	AmbientWire,
	SigrunClient,
	InteractionWire,
} from "../api";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
	.IS_REACT_ACT_ENVIRONMENT = true;
import { InteractionCard, InteractionCards } from "./InteractionCards";
import { AmbientPanel } from "./AmbientPanels";

function makeClient(overrides: Partial<SigrunClient> = {}): SigrunClient {
	return {
		answerInteraction: vi.fn().mockResolvedValue({
			callId: "c1",
			status: "answered",
			answer: { ids: ["a"] },
		}),
		...overrides,
	} as unknown as SigrunClient;
}

const BASE: InteractionWire = {
	kind: "fixture.ask",
	callId: "c1",
	status: "pending",
	createdAt: 1,
};

describe("InteractionCard", () => {
	test("renders kind, text, and toned options; recommended pre-selected", () => {
		const client = makeClient();
		const renderer = render(
			h(InteractionCard, {
				conversationId: 1,
				interaction: {
					...BASE,
					body: {
						text: "allow this?",
						options: [
							{ id: "a", label: "Allow", tone: "ok", recommended: true },
							{ id: "b", label: "Deny", tone: "danger" },
						],
					},
				},
				client,
			}),
		);
		expect(textContent(renderer.toJSON())).toContain("fixture.ask");
		expect(textContent(renderer.toJSON())).toContain("allow this?");
		const checked = renderer.root.findAllByProps({ checked: true });
		expect(checked).toHaveLength(1);
		const radios = renderer.root.findAllByProps({ type: "radio" });
		expect(radios).toHaveLength(2);
	});

	test("answering a single choice sends ids through the generic route", async () => {
		const answerInteraction = vi.fn().mockResolvedValue({
			callId: "c1",
			status: "answered",
			answer: { ids: ["a"] },
		});
		const client = makeClient({ answerInteraction });
		const renderer = render(
			h(InteractionCard, {
				conversationId: 7,
				interaction: {
					...BASE,
					body: {
						options: [
							{ id: "a", label: "Allow" },
							{ id: "b", label: "Deny" },
						],
					},
				},
				client,
			}),
		);
		// No `recommended` in this fixture: select the radio, then submit.
		const radios = renderer.root.findAllByProps({
			type: "radio",
			checked: false,
		});
		await act(async () => {
			radios[0].props.onChange();
		});
		const submit = renderer.root.findByProps({ className: "interaction-submit" });
		await act(async () => {
			submit.props.onClick();
		});
		expect(answerInteraction).toHaveBeenCalledWith(7, "c1", { ids: ["a"] });
	});

	test("multi-select accumulates checkboxes into one ids answer", async () => {
		const answerInteraction = vi.fn().mockResolvedValue({
			callId: "c1",
			status: "answered",
			answer: { ids: ["a", "c"] },
		});
		const client = makeClient({ answerInteraction });
		const renderer = render(
			h(InteractionCard, {
				conversationId: 7,
				interaction: {
					...BASE,
					details: { multi: true },
					body: {
						options: [
							{ id: "a", label: "A" },
							{ id: "b", label: "B" },
							{ id: "c", label: "C" },
						],
					},
				},
				client,
			}),
		);
		const boxes = renderer.root.findAllByProps({ type: "checkbox" });
		expect(boxes).toHaveLength(3);
		await act(async () => {
			boxes[0].props.onChange();
		});
		await act(async () => {
			boxes[2].props.onChange();
		});
		const submit = renderer.root.findByProps({ className: "interaction-submit" });
		await act(async () => {
			submit.props.onClick();
		});
		expect(answerInteraction).toHaveBeenCalledWith(7, "c1", { ids: ["a", "c"] });
	});

	test("secret fields render as password inputs; values submit", async () => {
		const answerInteraction = vi.fn().mockResolvedValue({
			callId: "c1",
			status: "answered",
			answer: { values: { key: "abc", name: "x" } },
		});
		const client = makeClient({ answerInteraction });
		const renderer = render(
			h(InteractionCard, {
				conversationId: 7,
				interaction: {
					...BASE,
					body: {
						fields: [
							{ name: "key", type: "secret", required: true },
							{ name: "name", type: "string" },
						],
					},
				},
				client,
			}),
		);
		const inputs = renderer.root.findAllByType("input" as never);
		expect(inputs[0].props.type).toBe("password");
		await act(async () => {
			inputs[0].props.onChange({ target: { value: "abc" } });
		});
		await act(async () => {
			inputs[1].props.onChange({ target: { value: "x" } });
		});
		const submit = renderer.root.findByProps({ className: "interaction-submit" });
		await act(async () => {
			submit.props.onClick();
		});
		expect(answerInteraction).toHaveBeenCalledWith(7, "c1", {
			values: { key: "abc", name: "x" },
		});
	});

	test("no-affordance records render text+details with no answer controls", () => {
		const client = makeClient();
		const renderer = render(
			h(InteractionCard, {
				conversationId: 7,
				interaction: {
					...BASE,
					body: { text: "informational only" },
					details: { why: "because" },
				},
				client,
			}),
		);
		expect(renderer.root.findAllByProps({ className: "interaction-submit" })).toHaveLength(0);
		expect(renderer.root.findByProps({ className: "interaction-details" })).toBeDefined();
		expect(textContent(renderer.toJSON())).toContain("informational only");
	});

	test("a failed answer surfaces the error fail-loud", async () => {
		const answerInteraction = vi.fn().mockRejectedValue(new Error("boom"));
		const onError = vi.fn();
		const client = makeClient({ answerInteraction });
		const renderer = render(
			h(InteractionCard, {
				conversationId: 7,
				interaction: {
					...BASE,
					body: { options: [{ id: "a", label: "A" }] },
				},
				client,
				onError,
			}),
		);
		await act(async () => {
			renderer.root.findByType("button" as never).props.onClick();
		});
		expect(onError).toHaveBeenCalledWith("boom");
	});
});

describe("InteractionCards", () => {
	test("null conversation or empty list renders nothing", () => {
		const client = makeClient();
		expect(render(
			h(InteractionCards, { conversationId: null, interactions: [BASE], client }),
		).toJSON()).toBeNull();
		expect(render(
			h(InteractionCards, { conversationId: 1, interactions: [], client }),
		).toJSON()).toBeNull();
	});
});

describe("AmbientPanel", () => {
	test("renders line segments by zone", () => {
		const surface: AmbientWire = {
			key: "powerline",
			owner: "ext",
			place: "status",
			expires: "never",
			updatedAt: 1,
			body: {
				line: {
					text: "",
					segments: [
						{ id: "model", text: "glm-5.3", place: "left" },
						{ id: "cost", text: "$0.12", place: "right" },
					],
				},
			},
		};
		const renderer = render(h(AmbientPanel, { surface }));
		const segments = renderer.root.findAllByProps({
			"className": "ambient-segment ambient-segment-left",
		});
		expect(segments.length).toBeGreaterThan(0);
		expect(textContent(renderer.toJSON())).toContain("glm-5.3");
		expect(textContent(renderer.toJSON())).toContain("$0.12");
	});

	test("rows: severity sorts first, quiet folded with a count, deps + metrics rendered", () => {
		const surface: AmbientWire = {
			key: "tasks",
			owner: "ext",
			place: "panel",
			expires: "never",
			updatedAt: 1,
			body: {
				rows: [
					{ id: "r1", label: "quiet thing", status: "ok", quiet: true },
					{ id: "r2", label: "failing", status: "failed", severity: 0, deps: ["r1"], metrics: { completed: 2, total: 5, format: "compact" } },
					{ id: "r3", label: "working", status: "running", spinnerLabel: "parsing" },
				],
			},
		};
		const renderer = render(h(AmbientPanel, { surface }));
		const rows = renderer.root.findAllByProps({ className: "ambient-row" });
		// severity-0 first; quiet folded into a summary row
		expect(rows[0].props["data-status"]).toBe("failed");
		expect(textContent(renderer.toJSON())).toContain("+1 quiet");
		expect(textContent(renderer.toJSON())).toContain("⛓ r1");
		expect(textContent(renderer.toJSON())).toContain("parsing");
		expect(textContent(renderer.toJSON())).toContain("2/5");
	});

	test("gauge renders percent bar, elapsed, and check rows", () => {
		const surface: AmbientWire = {
			key: "audit",
			owner: "ext",
			place: "panel",
			expires: "never",
			updatedAt: 1,
			body: {
				gauge: {
					label: "auditing",
					percent: 62,
					phase: "producing_report",
					elapsedMs: 3400,
					checks: [{ id: "c1", label: "tests", status: "passed" }],
				},
			},
		};
		const renderer = render(h(AmbientPanel, { surface }));
		expect(textContent(renderer.toJSON())).toContain("auditing · producing_report · 3.4s");
		expect(renderer.root.findByProps({ className: "ambient-gauge-fill" }).props.style.width).toBe("62%");
		expect(textContent(renderer.toJSON())).toContain("tests");
	});

	test("ledger renders newest-first", () => {
		const surface: AmbientWire = {
			key: "trace",
			owner: "ext",
			place: "panel",
			expires: "never",
			updatedAt: 1,
			body: {
				ledger: [
					{ id: "1", at: 1, kind: "guard", summary: "first" },
					{ id: "2", at: 2, kind: "guard", summary: "second" },
				],
			},
		};
		const renderer = render(h(AmbientPanel, { surface }));
		const text = textContent(renderer.toJSON());
		expect(text.indexOf("second")).toBeLessThan(text.indexOf("first"));
	});

	test("details render collapsed; an empty-body surface with only details still renders", () => {
		const surface: AmbientWire = {
			key: "x",
			owner: "ext",
			place: "status",
			expires: "never",
			updatedAt: 1,
			details: { custom: true },
		};
		const renderer = render(h(AmbientPanel, { surface }));
		expect(renderer.root.findByProps({ className: "ambient-details" })).toBeDefined();
	});
});
