/**
 * UI-blocks U5 Task 4 e2e: chat blocks in the REAL chat flow — the faux
 * provider scripts a `show_blocks` round (a lanes collection + a "Use
 * this order" form submit, the spec §8.5 shape over lanes — the list
 * display has no drag affordance; lanes is the reorderable display the
 * gallery e2e drives), the block renders inline in the chat column; a
 * drag in one tab updates a SECOND tab (same user, the
 * conversation-scoped `surface.changed` over two `/v1/events` streams)
 * within 2 s; then "Use this order" submits the §8.4 answer — exactly
 * ONE new user turn (the requestId dedup's single-turn pin).
 */

import { expect, test } from "@playwright/test";
import {
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { JsonObject } from "@sigrun/shared/blocks";
import { bootE2EServer, type E2EServer } from "./harness.js";

/** The chat-legal board: a lanes collection (reorderable via drag) +
 *  the order form. */
const BOARD_TREE = {
	v: 1,
	root: {
		type: "stack",
		children: [
			{
				type: "collection",
				id: "board",
				items: { $: "/cards" },
				display: "lanes",
				groupBy: "status",
				groups: [
					{ id: "todo", title: "To do" },
					{ id: "doing", title: "Doing" },
				],
				onMove: "moveCard",
				item: { title: { $: "./title" } },
			},
			{
				type: "form",
				id: "order",
				bind: "/order",
				mode: "submit",
				onSubmit: "submitOrder",
				submitLabel: "Use this order",
				children: [{ type: "text", name: "note", label: "Note" }],
			},
		],
	},
} as unknown as JsonObject;

const BOARD_DATA = {
	cards: [
		{ id: "c1", title: "Clair de Lune", status: "todo" },
		{ id: "c2", title: "Gymnopédie", status: "todo" },
		{ id: "c3", title: "Arabesque", status: "doing" },
	],
	order: { note: "" },
};

let server: E2EServer;

test.beforeAll(async () => {
	server = await bootE2EServer({
		settingsFile: { namingModel: false },
		responses: [
			// Turn 1: the model shows the board.
			fauxAssistantMessage(
				[
					fauxToolCall(
						"show_blocks",
						{ title: "Ranking", tree: BOARD_TREE, data: BOARD_DATA },
						{ id: "call-blocks" },
					),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Here is the ranking."),
			// Turn 2 (the answer's turn): a plain reply.
			fauxAssistantMessage("Order noted."),
		],
	});
});

test.afterAll(async () => {
	await server.cleanup();
});

test("drag in one tab updates the second tab within 2 s; the order submit produces exactly one user turn", async ({
	browser,
}) => {
	const aliceContext = await browser.newContext();
	const bobContext = await browser.newContext();
	const alice = await aliceContext.newPage();
	const bob = await bobContext.newPage();
	const aliceErrors: string[] = [];
	const bobErrors: string[] = [];
	alice.on("pageerror", (cause) => aliceErrors.push(String(cause)));
	bob.on("pageerror", (cause) => bobErrors.push(String(cause)));

	// Alice runs the show_blocks turn.
	await alice.goto(server.url);
	await expect(alice.locator(".composer-input")).toBeEnabled();
	await alice.locator(".composer-input").fill("show the ranking");
	await alice.locator(".composer-send").click();
	await expect(alice.locator(".chat-center")).toContainText(
		"Here is the ranking.",
		{ timeout: 20_000 },
	);

	// The block renders inline (the compact-pinned chat surface).
	const aliceBlock = alice.locator("[data-blocks-entry]");
	await expect(aliceBlock).toBeVisible();
	await expect(aliceBlock).toContainText("Ranking");
	// The compact lanes fallback renders ONE lane plus the lane switcher;
	// the todo lane is the selected default (c1/c2 visible, c3 behind
	// the switcher).
	await expect(
		aliceBlock.locator('[data-drag-item="c1"]'),
	).toBeVisible();

	// Bob opens the SAME conversation (same user; the sidebar's row).
	await bob.goto(server.url);
	await expect(bob.locator("nav.session-list")).toBeVisible();
	await bob.locator("nav.session-list .session-select").first().click();
	const bobBlock = bob.locator("[data-blocks-entry]");
	await expect(bobBlock).toBeVisible({ timeout: 10_000 });
	// Before the drag: bob's c1 sits in the todo lane.
	await expect(
		bobBlock.locator('[data-lane="todo"] [data-drag-item="c1"]'),
	).toBeVisible();

	// Alice drags c1 below c2 inside the todo lane (the compact pin
	// shows one lane; the pointer reorder within it is the drag the
	// chat surface supports — cross-lane drops are the switcher's job
	// at this width).
	const aliceC1 = aliceBlock.locator('[data-drag-item="c1"]');
	const aliceC2 = aliceBlock.locator('[data-drag-item="c2"]');
	await aliceC1.dragTo(aliceC2);

	// Alice's own move lands at once (c1 after c2 in todo).
	await expect(
		aliceBlock.locator(
			'[data-lane="todo"] [data-drag-item="c2"] ~ [data-drag-item="c1"]',
		),
	).toBeVisible();

	// Bob's tab reflects the move within 2 s (the conversation-scoped
	// surface.changed → the since fetch on his stream).
	await expect(
		bobBlock.locator(
			'[data-lane="todo"] [data-drag-item="c2"] ~ [data-drag-item="c1"]',
		),
	).toBeVisible({ timeout: 2000 });

	// The drag posted NO turn (ruling 1: move/check never start a turn —
	// the change rides the next turn's §8.3 note; nothing new here).
	const aliceUserTurnsBefore = await alice
		.locator('[data-turn-kind="user"]')
		.count();

	// Alice submits the order form: the §8.4 answer submits ONE user
	// turn (the requestId dedup pins the double-click/one-turn rule).
	const submit = aliceBlock.getByRole("button", { name: "Use this order" });
	await expect(submit).toBeVisible();
	await submit.click();
	await expect(alice.locator(".chat-center")).toContainText(
		"Order noted.",
		{ timeout: 20_000 },
	);
	// §8.4's fold rule: the drag's change records folded into the
	// ANSWER's own content (the answer's surface notes no further) —
	// so no §8.3 note row renders for this surface, and the answer
	// text the model saw names the drag ("moved 'Clair de Lune'").
	await expect(
		alice.locator(".chat-center"),
	).toContainText("moved 'Clair de Lune'", { timeout: 20_000 });
	// Exactly ONE new user turn (the answer), carrying the chip.
	const aliceUserTurnsAfter = await alice
		.locator('[data-turn-kind="user"]')
		.count();
	expect(aliceUserTurnsAfter).toBe(aliceUserTurnsBefore + 1);
	await expect(
		alice.locator(".entry-answer-chip", { hasText: "from Ranking" }),
	).toBeVisible();

	expect(aliceErrors).toEqual([]);
	expect(bobErrors).toEqual([]);
	await aliceContext.close();
	await bobContext.close();
});
