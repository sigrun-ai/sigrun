/**
 * ShareMenu (core hardening W1 Task 8, spec §5.9): the owner's sharing
 * editor — private / household read|write / people + level — writing
 * `PATCH /v1/conversations/:id/meta {sharing}`. Every choice is
 * immediate-apply (a click lands its own patch); write levels carry the
 * warning that write-shared users may act as the owner.
 */

import { act } from "react";
import { describe, expect, test } from "vitest";
import { createClient, type ConversationSummary, type FetchLike } from "../api";
import { renderAsync, textContent } from "../test-utils";
import { ShareMenu } from "./ShareMenu";

type Call = { input: string; method?: string; body?: string };

function makeHarness() {
	const calls: Call[] = [];
	const fetchImpl: FetchLike = (input, init) => {
		calls.push({ input, method: init?.method, body: init?.body });
		return Promise.resolve({
			ok: true,
			status: 200,
			json: () => Promise.resolve({}),
			text: () => Promise.resolve(""),
		});
	};
	return { calls, client: createClient({ fetch: fetchImpl }) };
}

function conversation(init?: {
	readonly sharing?: ConversationSummary["sharing"];
}): ConversationSummary {
	return {
		id: 5,
		root: false,
		entryCount: 0,
		access: "write",
		owner: "alice",
		archived: false,
		pinned: false,
		...(init?.sharing === undefined ? {} : { sharing: init.sharing }),
	};
}

/** The patch bodies the test collected (one per landed sharing choice). */
function patchBodies(calls: readonly Call[]): unknown[] {
	return calls
		.filter(
			(call) =>
				call.input === "/v1/conversations/5/meta" && call.method === "PATCH",
		)
		.map((call) => JSON.parse(call.body ?? "{}") as Record<string, unknown>);
}

/** Click the one button whose label text is exactly `label`. */
async function clickButton(
	renderer: Awaited<ReturnType<typeof renderAsync>>,
	label: string,
): Promise<void> {
	const matches = renderer.root
		.findAllByType("button")
		.filter((button) =>
			(button.children ?? []).some(
				(child) => typeof child === "string" && child.trim() === label,
			),
		);
	if (matches.length !== 1) {
		throw new Error(`expected one "${label}" button, found ${matches.length}`);
	}
	await act(async () => {
		await matches[0]!.props.onClick();
	});
}

async function setUsers(
	renderer: Awaited<ReturnType<typeof renderAsync>>,
	value: string,
): Promise<void> {
	const input = renderer.root.findByProps({ "data-share-field": "users" });
	await act(async () => {
		input.props.onChange({ target: { value } });
	});
}

describe("ShareMenu", () => {
	test("Private posts the private scope and calls onSaved", async () => {
		const harness = makeHarness();
		let saved = 0;
		const renderer = await renderAsync(
			<ShareMenu
				client={harness.client}
				conversation={conversation({ sharing: { scope: "household", level: "read" } })}
				onClose={() => undefined}
				onSaved={() => {
					saved += 1;
				}}
			/>,
		);
		await clickButton(renderer, "Private");
		expect(patchBodies(harness.calls)).toEqual([
			{ sharing: { scope: "private" } },
		]);
		expect(saved).toBe(1);
		// No warning on the read-level surface.
		expect(textContent(renderer.toJSON())).not.toContain(
			"Others can ask the agent to act as you.",
		);
	});

	test("Household defaults to read; Write posts household-write and shows the act-as-you warning", async () => {
		const harness = makeHarness();
		const renderer = await renderAsync(
			<ShareMenu
				client={harness.client}
				conversation={conversation()}
				onClose={() => undefined}
				onSaved={() => undefined}
			/>,
		);
		// From a private start, choosing Household lands READ (the default).
		await clickButton(renderer, "Household");
		expect(patchBodies(harness.calls)).toEqual([
			{ sharing: { scope: "household", level: "read" } },
		]);
		// Flipping the level to write lands the write scope + the warning.
		await clickButton(renderer, "Can edit");
		expect(patchBodies(harness.calls)).toEqual([
			{ sharing: { scope: "household", level: "read" } },
			{ sharing: { scope: "household", level: "write" } },
		]);
		expect(textContent(renderer.toJSON())).toContain(
			"Others can ask the agent to act as you.",
		);
	});

	test("People parses the comma-separated user list and posts scope people with the level", async () => {
		const harness = makeHarness();
		const renderer = await renderAsync(
			<ShareMenu
				client={harness.client}
				conversation={conversation()}
				onClose={() => undefined}
				onSaved={() => undefined}
			/>,
		);
		await clickButton(renderer, "People");
		await setUsers(renderer, "carol,  dave ");
		await clickButton(renderer, "Share with people");
		expect(patchBodies(harness.calls)).toEqual([
			{ sharing: { scope: "people", users: ["carol", "dave"], level: "read" } },
		]);
	});

	test("a people share with no users is refused client-side (no patch)", async () => {
		const harness = makeHarness();
		const renderer = await renderAsync(
			<ShareMenu
				client={harness.client}
				conversation={conversation()}
				onClose={() => undefined}
				onSaved={() => undefined}
			/>,
		);
		await clickButton(renderer, "People");
		await clickButton(renderer, "Share with people");
		expect(patchBodies(harness.calls)).toEqual([]);
		expect(textContent(renderer.toJSON())).toContain(
			"enter at least one username",
		);
	});

	test("the current household-read state renders selected; Close calls onClose", async () => {
		const harness = makeHarness();
		let closed = 0;
		const renderer = await renderAsync(
			<ShareMenu
				client={harness.client}
				conversation={conversation({
					sharing: { scope: "household", level: "read" },
				})}
				onClose={() => {
					closed += 1;
				}}
				onSaved={() => undefined}
			/>,
		);
		expect(
			renderer.root.findByProps({ "data-share-scope": "household" }).props[
				"data-selected"
			],
		).toBe(true);
		await clickButton(renderer, "Close");
		expect(closed).toBe(1);
	});
});
