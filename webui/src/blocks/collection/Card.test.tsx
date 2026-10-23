/**
 * Card slots (UI-blocks U1 Task 3, spec §5.5.1): the fixed slot set —
 * eyebrow, required title, subtitle, markdown body (clamped to 4 lines
 * in list/lanes, full in detail), image, icon, badges, meta (text /
 * person-shows-name / formatted time), metrics, tone stripe, up to 3
 * actions then an overflow menu, status with spinner, deps as
 * "after: …" — each bound relative to the item (`./` pointers).
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
	.IS_REACT_ACT_ENVIRONMENT = true;

import { createElement as h, type ReactElement, type ReactNode } from "react";
import { describe, expect, test, vi } from "vitest";
import type { JsonObject } from "@sigrun/shared/blocks";
import { render, textContent } from "../../test-utils";
import type { ReactTestInstance } from "react-test-renderer";

/** All text under a found test instance (instances have no toJSON). */
function textOf(node: ReactTestInstance): string {
	let text = "";
	for (const child of node.children) {
		text += typeof child === "string" ? child : textOf(child);
	}
	return text;
}
import { SurfaceActionsContext, SurfaceDataContext } from "../context";
import { CardView, type CardDisplay } from "./Card";
import type { Card } from "@sigrun/shared/blocks";

/** The dispatch spy + write-access provider the tests drive. */
function makeActions(): {
	dispatch: ReturnType<typeof vi.fn>;
	provider(children: ReactNode): ReactElement;
} {
	const dispatch = vi.fn();
	return {
		dispatch,
		provider: (children): ReactElement =>
			h(SurfaceActionsContext.Provider, {
				value: { dispatch, access: "write", viewState: {} as JsonObject },
			}, children),
	};
}

/** Render one card for `item` (item bindings are literals/`./` pointers). */
function renderCard(
	card: Card,
	item: JsonObject,
	display: CardDisplay = "list",
): ReturnType<typeof render> {
	const { provider } = makeActions();
	return render(
		h(SurfaceDataContext.Provider, {
			value: { data: {}, locale: "en-US" },
		}, provider(h(CardView, { card, item, display }))),
	);
}

const acme = { id: "t1", title: "Acme deploy", tone: "warn" };

describe("card slots (spec §5.5.1)", () => {
	test("renders every bound slot relative to the item", () => {
		const card: Card = {
			eyebrow: { $: "./id" },
			title: { $: "./title" },
			subtitle: { $: "./sub" },
			body: { $: "./body" },
			icon: "check",
			badges: [{ text: { $: "./badge" }, tone: "good" }],
			meta: [
				{ icon: "tag", text: { $: "./label" } },
				{ person: { user: { $: "./user" }, name: { $: "./name" } } },
				{ time: { $: "./at" }, format: "date" },
			],
			metrics: [{ label: "Points", value: { $: "./points" } }],
			tone: { $: "./tone" },
			status: { label: { $: "./status" }, tone: "warn", spinner: true },
			deps: { $: "./deps" },
		};
		const view = renderCard(card, {
			...acme,
			sub: "nightly pipeline",
			body: "Deploys the **acme** service.",
			badge: "ready",
			label: "release",
			user: "mike",
			name: "Mike Example",
			at: "2026-10-19T12:00:00Z",
			points: 42,
			status: "building",
			deps: ["t0", "t-1"],
		});
		const text = textContent(view.toJSON());
		expect(text).toContain("t1"); // eyebrow
		expect(text).toContain("Acme deploy"); // title
		expect(text).toContain("nightly pipeline"); // subtitle
		expect(text).toContain("acme"); // markdown body
		expect(text).toContain("ready"); // badge
		expect(text).toContain("release"); // meta text
		expect(text).toContain("Mike Example"); // person shows the NAME
		expect(text).not.toContain("mike");
		expect(text).toContain("Oct 19, 2026"); // formatted time
		expect(text).toContain("Points"); // metric label
		expect(text).toContain("42"); // metric value
		expect(text).toContain("building"); // status label
		expect(text).toContain("after: t0, t-1"); // deps markers
		const json = view.toJSON();
		const rendered = JSON.stringify(json);
		expect(rendered).toContain('"data-tone":"warn"'); // tone stripe / status
		expect(rendered).toContain('"data-spinner":"true"'); // status spinner
	});

	test("body clamps to 4 lines in list, full in detail", () => {
		const card: Card = { title: "Acme", body: "Long **body**" };
		const list = renderCard(card, acme, "list");
		expect(JSON.stringify(list.toJSON())).toContain('"data-clamped":true');
		const detail = renderCard(card, acme, "detail");
		expect(JSON.stringify(detail.toJSON())).not.toContain(
			'"data-clamped":true',
		);
	});

	test("image renders top in grid, thumbnail in list", () => {
		const card: Card = {
			title: "Acme",
			image: "https://img.example.invalid/a.png",
		};
		const grid = renderCard(card, acme, "grid");
		expect(JSON.stringify(grid.toJSON())).toContain('"data-layout":"top"');
		const list = renderCard(card, acme, "list");
		expect(JSON.stringify(list.toJSON())).toContain(
			'"data-layout":"thumb"',
		);
	});

	test("actions: up to 3 buttons, the rest behind an overflow menu", () => {
		const mk = (id: string) => ({
			id,
			label: `Do ${id}`,
			action: { type: "submit" as const, name: `on_${id}` },
		});
		const card: Card = {
			title: "Acme",
			actions: [mk("a"), mk("b"), mk("c"), mk("d"), mk("e")],
		};
		const view = renderCard(card, acme);
		const json = JSON.stringify(view.toJSON());
		expect(json).toContain("Do a");
		expect(json).toContain("Do c");
		expect(json).toContain("Do e"); // overflow still rendered
		expect(json).toContain("More actions");
		const buttons = view.root.findAll(
			(node) =>
				node.type === "button" && textOf(node).includes("Do"),
		);
		// 3 direct + 2 in the overflow details
		expect(buttons.length).toBe(5);
		const summaries = view.root.findAll((node) => node.type === "summary");
		expect(summaries.length).toBe(1);
	});

	test("a missing binding renders empty, never an error", () => {
		const card: Card = {
			eyebrow: { $: "./nope" },
			title: { $: "./title" },
			subtitle: { $: "./nope" },
			deps: { $: "./nope" },
		};
		const view = renderCard(card, acme);
		const text = textContent(view.toJSON());
		expect(text).toContain("Acme deploy");
		expect(text).not.toContain("after:");
	});

	test("long unbroken titles wrap or ellipsize, never widen (focus 4)", () => {
		const card: Card = { title: { $: "./title" } };
		const longTitle = `acme-${"x".repeat(200)}`;
		const view = renderCard(card, { id: "t", title: longTitle });
		const title = view.root.find(
			(node) => node.props.className === "blk-card-title",
		);
		expect(title.props.dir).toBe("auto");
		expect(textOf(title)).toBe(longTitle);
	});
});
