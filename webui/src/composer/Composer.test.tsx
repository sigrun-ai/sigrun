/**
 * Composer (Task 23b): the footer — textarea, model picker, context-usage
 * ring, send/steer toggle, and the approval strip (endpoint-sourced — the
 * T22 P1 correction; see the App-level test for the pinned divergence).
 *
 * The stub fetch routes every §5 path the composer touches: the model
 * catalog, the meta GET/PATCH (the draft), the submissions POST, and the
 * approvals list. Fake timers control the draft debounce window.
 */

import { act } from "react";
import type TestRenderer from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	createClient,
	type ApprovalWire,
	type ConversationMeta,
	type ConversationViewWire,
	type FetchLike,
	type ModelEntry,
} from "../api";
import { makeView, renderAsync, textContent } from "../test-utils";
import { Composer } from "./Composer";

const MODELS: readonly ModelEntry[] = [
	{
		id: "faux/one",
		provider: "faux",
		modelId: "one",
		name: "Faux One",
		contextWindow: 1000,
		maxTokens: 100,
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.5 },
	},
	{
		id: "faux/two",
		provider: "faux",
		modelId: "two",
		name: "Faux Two",
		contextWindow: 4000,
		maxTokens: 400,
		reasoning: true,
		input: ["text"],
		cost: { input: 3, output: 4, cacheRead: 1, cacheWrite: 1 },
	},
];

function makeHarness(init?: {
	readonly draftText?: string;
	readonly draftAttachments?: readonly string[];
	readonly approvals?: readonly ApprovalWire[];
	readonly models?: readonly ModelEntry[];
}) {
	const calls: { input: string; method?: string; body?: string }[] = [];
	const meta: ConversationMeta = {
		pinned: false,
		tagged: [],
		archived: false,
		draft: {
			text: init?.draftText ?? "",
			attachments: init?.draftAttachments ?? [],
		},
		source: "user",
	};
	let approvals = init?.approvals ?? [];
	/** Test seam: invoked when the compact POST fires (pending-state test). */
	let compactionSawRequest: () => void = () => {};
	const fetchImpl: FetchLike = (input, init2) => {
		calls.push({ input, method: init2?.method, body: init2?.body });
		let body: unknown;
		if (input === "/v1/models") body = { models: init?.models ?? MODELS };
		else if (input.endsWith("/meta")) body = meta;
		else if (input.endsWith("/approvals")) body = { approvals };
		else if (input.endsWith("/uploads")) {
			const parsed = JSON.parse(init2?.body as string) as { name: string };
			body = { path: `uploads/1/${parsed.name}` };
		} else if (input.endsWith("/submissions")) {
			body = { id: 9, conversationId: 1, type: "input", status: "done" };
		} else if (input.endsWith("/compact")) {
			body = { taskId: 42 };
			compactionSawRequest();
		} else throw new Error(`unexpected fetch ${input}`);
		return Promise.resolve({
			ok: true,
			status: input.endsWith("/submissions")
				? 202
				: input.endsWith("/uploads")
					? 201
					: input.endsWith("/compact")
						? 202
						: 200,
			json: () => Promise.resolve(body),
		});
	};
	const client = createClient({ fetch: fetchImpl });
	return {
		calls,
		client,
		setApprovals(next: readonly ApprovalWire[]) {
			approvals = next;
		},
		onCompactRequest(callback: () => void) {
			compactionSawRequest = callback;
		},
	};
}

async function renderComposer(
	client: ReturnType<typeof createClient>,
	view: ConversationViewWire,
	conversationId: number | null = 1,
) {
	return await renderAsync(
		<Composer
			client={client}
			conversationId={conversationId}
			view={view}
		/>,
	);
}

function composerTextarea(renderer: TestRenderer.ReactTestRenderer) {
	return renderer.root.findByProps({ className: "composer-input" });
}

async function typeText(
	renderer: TestRenderer.ReactTestRenderer,
	text: string,
) {
	const textarea = composerTextarea(renderer);
	await act(async () => {
		textarea.props.onChange({
			target: { value: text },
		});
	});
}

async function clickSend(renderer: TestRenderer.ReactTestRenderer) {
	const button = renderer.root.findByProps({ className: "composer-send" });
	await act(async () => {
		await button.props.onClick();
	});
}

describe("Composer", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	test("renders the model picker from the catalog and defaults to the first model", async () => {
		const { client } = makeHarness();
		const renderer = await renderComposer(client, makeView());
		const select = renderer.root.findByProps({
			className: "composer-model",
		});
		const options = select.findAllByType("option");
		expect(options.map((o) => o.props.value)).toEqual([
			"faux/one",
			"faux/two",
		]);
		expect(select.props.value).toBe("faux/one");
	});

	// THE PICKER CONVENTION (spec §6.1, binding): a picker renders ONLY when
	// its list has more than one item — a single-model deployment hides the
	// model picker (the ring still renders; the single model stays selected).
	test("the picker convention: a single-model catalog hides the picker but keeps the ring on that model", async () => {
		const { client } = makeHarness({ models: [MODELS[0]!] });
		const view = makeView({
			docs: {
				"pi.usage": {
					models: {
						"faux/one": { input: 250, output: 250 },
					},
				},
			},
		});
		const renderer = await renderComposer(client, view);
		expect(
			renderer.root.findAllByProps({ className: "composer-model" }),
		).toHaveLength(0);
		// The single model is still the ring's selection (50% of 1000).
		expect(textContent(renderer.toJSON())).toContain("50%");
	});

	test("the picker convention: an empty catalog hides the picker", async () => {
		const { client } = makeHarness({ models: [] });
		const renderer = await renderComposer(client, makeView());
		expect(
			renderer.root.findAllByProps({ className: "composer-model" }),
		).toHaveLength(0);
	});

	test("submitting sends the §5 submission body and clears the composer", async () => {
		const { calls, client } = makeHarness();
		const renderer = await renderComposer(client, makeView());
		await typeText(renderer, "hello sigrun");
		await clickSend(renderer);
		const posts = calls.filter((c) => c.input.endsWith("/submissions"));
		expect(posts).toEqual([
			{
				input: "/v1/conversations/1/submissions",
				method: "POST",
				body: JSON.stringify({
					input: [{ type: "text", text: "hello sigrun" }],
				}),
			},
		]);
		expect(composerTextarea(renderer).props.value).toBe("");
	});

	test("steer.busy flips the button to Steer and submits with whenBusy:steer", async () => {
		const { calls, client } = makeHarness();
		const renderer = await renderComposer(
			client,
			makeView({ steer: { busy: true, queued: 0 } }),
		);
		const button = renderer.root.findByProps({ className: "composer-send" });
		expect(button.children.join("")).toBe("Steer");
		await typeText(renderer, "actually, stop that");
		await clickSend(renderer);
		const posts = calls.filter((c) => c.input.endsWith("/submissions"));
		expect(posts[0]?.body).toBe(
			JSON.stringify({
				input: [{ type: "text", text: "actually, stop that" }],
				whenBusy: "steer",
			}),
		);
	});

	test("the usage ring reads the selected model's pi.usage ledger entry over its contextWindow", async () => {
		const { client } = makeHarness();
		const view = makeView({
			docs: {
				"pi.usage": {
					models: {
						// 300 input + 100 output + 100 cacheRead = 500 of 1000.
						"faux/one": {
							input: 300,
							output: 100,
							cacheRead: 100,
							cacheWrite: 0,
							totalTokens: 500,
							cost: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								total: 0,
							},
						},
					},
					tools: {},
				},
			},
		});
		const renderer = await renderComposer(client, view);
		const ring = renderer.root.findByProps({ className: "composer-ring" });
		expect(ring.props["data-usage-percent"]).toBe(50);
		expect(textContent(renderer.toJSON())).toContain("50%");
	});

	test("switching the model re-rates the ring against THAT model's ledger entry and window", async () => {
		const { client } = makeHarness();
		const view = makeView({
			docs: {
				"pi.usage": {
					models: {
						"faux/two": {
							input: 800,
							output: 200,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 1000,
							cost: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								total: 0,
							},
						},
					},
					tools: {},
				},
			},
		});
		const renderer = await renderComposer(client, view);
		const select = renderer.root.findByProps({
			className: "composer-model",
		});
		await act(async () => {
			select.props.onChange({ target: { value: "faux/two" } });
		});
		const ring = renderer.root.findByProps({ className: "composer-ring" });
		expect(ring.props["data-usage-percent"]).toBe(25);
	});

	test("a pending approval from listApprovals renders an ApprovalCard", async () => {
		const { client } = makeHarness({
			approvals: [
				{
					callId: "call-1",
					toolName: "bash",
					status: "pending",
					arguments: { command: "rm -rf /" },
				},
			],
		});
		const renderer = await renderComposer(client, makeView());
		const cards = renderer.root.findAllByProps({
			className: "approval-card",
		});
		expect(cards).toHaveLength(1);
		expect(textContent(renderer.toJSON())).toContain("bash");
	});

	test("a view frame clears the card when the endpoint list goes empty", async () => {
		const harness = makeHarness({
			approvals: [
				{ callId: "call-1", toolName: "bash", status: "pending" },
			],
		});
		const renderer = await renderComposer(harness.client, makeView());
		expect(
			renderer.root.findAllByProps({ className: "approval-card" }),
		).toHaveLength(1);
		// The endpoint now serves an empty list (a decision landed); the next
		// view frame refreshes the strip.
		harness.setApprovals([]);
		await act(async () => {
			renderer.update(
				<Composer
					client={harness.client}
					conversationId={1}
					view={makeView()}
				/>,
			);
		});
		expect(
			renderer.root.findAllByProps({ className: "approval-card" }),
		).toHaveLength(0);
	});

	test("the draft restores from meta and saves debounced", async () => {
		const { calls, client } = makeHarness({ draftText: "restored words" });
		const renderer = await renderComposer(client, makeView());
		expect(composerTextarea(renderer).props.value).toBe("restored words");
		await typeText(renderer, "edited words");
		await act(async () => {
			vi.advanceTimersByTime(600);
		});
		const patches = calls.filter((c) => c.method === "PATCH");
		expect(patches[0]?.body).toBe(
			JSON.stringify({ draft: { text: "edited words" } }),
		);
	});

	test("the composer is disabled while no conversation is active", async () => {
		const { calls, client } = makeHarness();
		const renderer = await renderComposer(client, makeView(), null);
		// An empty submission is a no-op: nothing POSTs.
		await clickSend(renderer);
		expect(
			calls.filter((c) => c.input.endsWith("/submissions")),
		).toEqual([]);
	});

	describe("attachments (Task 24)", () => {
		function fileInput(renderer: TestRenderer.ReactTestRenderer) {
			return renderer.root.findByProps({
				className: "composer-file-input",
			});
		}

		async function attach(
			renderer: TestRenderer.ReactTestRenderer,
			files: readonly File[],
		) {
			await act(async () => {
				await fileInput(renderer).props.onChange({
					target: { files },
				});
			});
		}

		test("attaching a file uploads it and the path lands in draft.attachments (tray + meta PATCH)", async () => {
			const { calls, client } = makeHarness();
			const renderer = await renderComposer(client, makeView());
			await attach(renderer, [
				new File([new Uint8Array([104, 105])], "pic.png", {
					type: "image/png",
				}),
			]);
			const uploads = calls.filter((c) => c.input.endsWith("/uploads"));
			expect(uploads).toEqual([
				{
					input: "/v1/conversations/1/uploads",
					method: "POST",
					body: JSON.stringify({
						name: "pic.png",
						contentBase64: "aGk=",
					}),
				},
			]);
			// The tray shows the uploaded path's basename.
			expect(textContent(renderer.toJSON())).toContain("pic.png");
			// …and the path persisted to session-meta immediately (no debounce):
			// the tray survives a reload.
			const patches = calls.filter((c) => c.method === "PATCH");
			expect(patches.map((c) => c.body)).toContain(
				JSON.stringify({ draft: { attachments: ["uploads/1/pic.png"] } }),
			);
		});

		test("submit sends the image path-part + the text part, then clears the tray (persisted)", async () => {
			const { calls, client } = makeHarness();
			const renderer = await renderComposer(client, makeView());
			await attach(renderer, [
				new File([new Uint8Array([104, 105])], "pic.png", {
					type: "image/png",
				}),
			]);
			await typeText(renderer, "look at this");
			await clickSend(renderer);
			const posts = calls.filter((c) => c.input.endsWith("/submissions"));
			expect(posts).toEqual([
				{
					input: "/v1/conversations/1/submissions",
					method: "POST",
					body: JSON.stringify({
						input: [
							{
								type: "image",
								path: "uploads/1/pic.png",
								mime: "image/png",
							},
							{ type: "text", text: "look at this" },
						],
					}),
				},
			]);
			// The tray is empty and the clear persisted BOTH fields.
			expect(
				renderer.root.findAllByProps({
					className: "composer-attachment",
				}),
			).toHaveLength(0);
			const patches = calls.filter((c) => c.method === "PATCH");
			expect(patches.map((c) => c.body)).toContain(
				JSON.stringify({ draft: { text: "", attachments: [] } }),
			);
		});

		test("a non-image attachment submits as a file part (no mime), and attachments alone can send", async () => {
			const { calls, client } = makeHarness();
			const renderer = await renderComposer(client, makeView());
			await attach(renderer, [
				new File([new Uint8Array([104, 105])], "notes.txt"),
			]);
			await clickSend(renderer);
			const posts = calls.filter((c) => c.input.endsWith("/submissions"));
			expect(posts).toEqual([
				{
					input: "/v1/conversations/1/submissions",
					method: "POST",
					body: JSON.stringify({
						input: [{ type: "file", path: "uploads/1/notes.txt" }],
					}),
				},
			]);
		});

		test("the tray restores from meta on reload", async () => {
			const { client } = makeHarness({
				draftAttachments: ["uploads/1/old.png"],
			});
			const renderer = await renderComposer(client, makeView());
			const chips = renderer.root.findAllByProps({
				className: "composer-attachment",
			});
			expect(chips).toHaveLength(1);
			expect(chips[0]?.props["data-path"]).toBe("uploads/1/old.png");
			expect(textContent(renderer.toJSON())).toContain("old.png");
		});

		test("removing an attachment PATCHes the reduced list", async () => {
			const { calls, client } = makeHarness({
				draftAttachments: ["uploads/1/a.png", "uploads/1/b.png"],
			});
			const renderer = await renderComposer(client, makeView());
			const remove = renderer.root
				.findAllByProps({ className: "composer-attachment-remove" })
				.find((b) => b.props["aria-label"] === "remove a.png");
			await act(async () => {
				await remove?.props.onClick();
			});
			const chips = renderer.root.findAllByProps({
				className: "composer-attachment",
			});
			expect(chips.map((c) => c.props["data-path"])).toEqual([
				"uploads/1/b.png",
			]);
			const patches = calls.filter((c) => c.method === "PATCH");
			expect(patches.map((c) => c.body)).toContain(
				JSON.stringify({ draft: { attachments: ["uploads/1/b.png"] } }),
			);
		});

		// Manual compaction (Task 4, pi parity): the Compact button next to
		// the usage ring POSTs the compact endpoint on click, shows the
		// pending state while the POST is in flight, and returns to idle.
		test("the Compact button POSTs the compact endpoint and returns to idle", async () => {
			const { calls, client } = makeHarness();
			const renderer = await renderComposer(client, makeView());
			const button = renderer.root.findByProps({
				className: "composer-compact",
			});
			expect(textContent(renderer.toJSON())).toContain("Compact");
			await act(async () => {
				await button.props.onClick();
			});
			const compactCall = calls.find(
				(c: { input: string; method?: string }) =>
					c.method === "POST" && c.input.endsWith("/compact"),
			);
			expect(compactCall).toBeDefined();
			expect(compactCall?.body).toBe(JSON.stringify({}));
			// Back to idle after the 202 resolves.
			expect(
				renderer.root.findByProps({ className: "composer-compact" })
					.props.disabled,
			).toBe(false);
		});

		test("the Compact button shows the pending state while the POST is in flight", async () => {
			// Gate the compact POST: the harness seam resolves it only when
			// the test releases, so the in-flight render is observable.
			const { client } = makeHarness();
			let release!: () => void;
			client.compact = (conversationId: number) => {
				void conversationId;
				return new Promise((resolve) => {
					release = () => resolve({ taskId: 1 });
				});
			};
			const renderer = await renderComposer(client, makeView());
			const button = renderer.root.findByProps({
				className: "composer-compact",
			});
			await act(async () => {
				void button.props.onClick();
			});
			// In flight: disabled + the Compacting… label.
			expect(button.props.disabled).toBe(true);
			expect(
				renderer.root.findByProps({ className: "composer-compact" }).props[
					"data-compacting"
				],
			).toBe(true);
			expect(textContent(renderer.toJSON())).toContain("Compacting…");
			await act(async () => {
				release();
			});
			// Settled: back to idle.
			expect(
				renderer.root.findByProps({ className: "composer-compact" })
					.props.disabled,
			).toBe(false);
			expect(textContent(renderer.toJSON())).toContain("Compact");
		});

		test("the Compact button is disabled with no conversation selected", async () => {
			const { client } = makeHarness();
			const renderer = await renderComposer(client, makeView(), null);
			const button = renderer.root.findByProps({
				className: "composer-compact",
			});
			expect(button.props.disabled).toBe(true);
		});
	});
});
