/**
 * Composer (Task 23b): the footer — textarea, model picker, context-usage
 * ring, and send/steer toggle.
 * T22 P1 correction; see the App-level test for the pinned divergence).
 *
 * The stub fetch routes every §5 path the composer touches: the model
 * catalog, the meta GET/PATCH (the draft), the submissions POST, and the
 * Fake timers control the draft debounce window.
 */

import { act } from "react";
import type TestRenderer from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	createClient,
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
	{
		id: "faux/m2",
		provider: "faux",
		modelId: "m2",
		name: "Faux M2",
		contextWindow: 2000,
		maxTokens: 200,
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
	},
];

/** The `/` menu's catalog fixture (the Task 7 server set, metadata only) —
 *  plus ONE extension-contributed entry (W5 Task 3: `extension` set, the
 *  invoke endpoint). */
const COMMANDS = [
	{ name: "new", description: "Start a new conversation", endpoint: { method: "POST", path: "/v1/conversations" } },
	{ name: "fork", description: "Fork this conversation", argsHint: "[at]", endpoint: { method: "POST", path: "/v1/conversations/:id/fork" } },
	{ name: "compact", description: "Compact", argsHint: "[instructions]", endpoint: { method: "POST", path: "/v1/conversations/:id/compact" } },
	{ name: "export", description: "Download JSONL", endpoint: { method: "GET", path: "/v1/conversations/:id/export" } },
	{ name: "import", description: "Import JSONL", argsHint: "<jsonl>", endpoint: { method: "POST", path: "/v1/conversations/import" } },
	{ name: "name", description: "Name", argsHint: "<name>", endpoint: { method: "PATCH", path: "/v1/conversations/:id/meta" } },
	{ name: "model", description: "Switch model", argsHint: "<provider/model>", endpoint: { method: "POST", path: "/v1/conversations/:id/configure" } },
	{ name: "thinking", description: "Set thinking level", argsHint: "<level>", endpoint: { method: "POST", path: "/v1/conversations/:id/configure" } },
		{ name: "hello", description: "Say hello", argsHint: "<name>", extension: "fixture-commands", endpoint: { method: "POST", path: "/v1/conversations/:id/commands/hello" } },
	{ name: "settings", description: "Open the settings panel (sections + search)", endpoint: { method: "GET", path: "/v1/settings/sections" } },
	// Task 2c expand entries: a prompt template (with its argument-hint as
	// argsHint) and a skill (no hint) — no endpoint; the server expands at
	// admission.
	{ name: "review", description: "Review the change", argsHint: "<focus>", kind: "expand" },
	{ name: "skill:greet", description: "Greet a person warmly", kind: "expand" },
];

function makeHarness(init?: {
	readonly draftText?: string;
	readonly draftAttachments?: string[];
	readonly models?: readonly ModelEntry[];
	/** The commands served on every GET /v1/commands AFTER the mount fetch
	 *  (the live-catalog fix round: a template appearing mid-session). */
	readonly laterCommands?: readonly unknown[];
}) {
	const calls: { input: string; method?: string; body?: string | Uint8Array }[] = [];
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
	const fetchImpl: FetchLike = (input, init2) => {
		calls.push({ input, method: init2?.method, body: init2?.body });
		let body: unknown;
		if (input === "/v1/models") body = { models: init?.models ?? MODELS };
		else if (input === "/v1/commands") {
			// The mount fetch serves the mount catalog; every later GET (the
			// send-path refetch) serves the LIVE catalog — the second and
			// subsequent responses gain the `laterCommands` entries.
			const fetchCount = calls.filter(
					(call) => call.input === "/v1/commands",
				).length;
			body =
					fetchCount > 1 && init?.laterCommands !== undefined
						? { commands: [...COMMANDS, ...init.laterCommands] }
						: { commands: COMMANDS };
		}
		else if (input.endsWith("/meta")) body = meta;

		else if (input.includes("/uploads/")) {
			// The raw PUT: the name rides the route param (percent-encoded).
			const name = decodeURIComponent(input.slice(input.lastIndexOf("/") + 1));
			body = { path: `uploads/1/${name}` };
		} else if (input.endsWith("/submissions")) {
			body = {
				submission: { id: 9, conversationId: 1, type: "input", status: "done" },
			};
		} else if (input.endsWith("/export")) {
			// text(), not json(): the export route serves raw JSONL.
			const jsonl =
					'{"id":1,"conversationId":1,"kind":"pi.user"}\n{"id":2,"conversationId":1,"kind":"pi.assistant"}\n';
			return Promise.resolve({
				ok: true,
				status: 200,
				json: () => Promise.resolve({}),
				text: () => Promise.resolve(jsonl),
			});
		} else if (input.endsWith("/fork") || input === "/v1/conversations" || input === "/v1/conversations/import") {
			// The create-family shape; ids differentiate the routes for asserts.
			body = {
				id: input.endsWith("/fork") ? 7 : input === "/v1/conversations" ? 3 : 8,
				view: makeView(),
			};
		} else if (input.endsWith("/configure")) {
			body = { model: "faux/one", thinkingLevel: "off" };
		} else if (input.endsWith("/commands/hello")) {
			// The extension invoke endpoint: the notice echoes the args.
			const parsed = JSON.parse(String(init2?.body ?? "{}")) as { args?: string };
			body = { notice: `hi ${parsed.args ?? ""}` };
		} else throw new Error(`unexpected fetch ${input}`);
		return Promise.resolve({
			ok: true,
			status: input.endsWith("/submissions")
				? 202
				: input.includes("/uploads/")
					? 201
				: input.endsWith("/compact")
					? 202
					: 200,
			json: () => Promise.resolve(body),
			text: () => Promise.resolve(String(body)),
		});
	};
	const client = createClient({ fetch: fetchImpl });
	return {
		calls,
		client,

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

/** The send/steer icon button (its accessible name flips Send↔Steer). */
function sendButton(renderer: TestRenderer.ReactTestRenderer) {
	const button = renderer.root
		.findAllByType("button")
		.find(
			(b) =>
				b.props["aria-label"] === "Send" ||
				b.props["aria-label"] === "Steer",
		);
	if (button === undefined) throw new Error("send button not found");
	return button;
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
	const button = sendButton(renderer);
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

	/** Open the model picker's popover (click the toggle); returns the toggle. */
	function openModelMenu(renderer: TestRenderer.ReactTestRenderer) {
		const toggle = renderer.root.findByProps({ "data-picker": "model" });
		act(() => {
			toggle.props.onClick();
		});
		return toggle;
	}

	test("the model picker names the current model and defaults to the catalog's first entry", async () => {
		const { client } = makeHarness();
		const renderer = await renderComposer(client, makeView());
		const toggle = renderer.root.findByProps({ "data-picker": "model" });
		expect(toggle.props["aria-haspopup"]).toBe("listbox");
		expect(toggle.props["aria-expanded"]).toBe(false);
		// No pi.agent doc on the view yet: the catalog's first entry is the
		// working selection (the ring still reads a model).
		expect(toggle.children.join("")).toContain("Faux One");
		act(() => {
			toggle.props.onClick();
		});
		const options = renderer.root.findAllByProps({ role: "option" });
		expect(options.map((o) => o.props["data-model-id"])).toEqual([
			"faux/one",
			"faux/two",
			"faux/m2",
		]);
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
			renderer.root.findAllByProps({ "data-picker": "model" }),
		).toHaveLength(0);
		// The single model is still the ring's selection (50% of 1000).
		expect(textContent(renderer.toJSON())).toContain("50%");
	});

	test("the picker convention: an empty catalog hides the picker", async () => {
		const { client } = makeHarness({ models: [] });
		const renderer = await renderComposer(client, makeView());
		expect(
			renderer.root.findAllByProps({ "data-picker": "model" }),
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

	test("two rapid clicks while not busy admit ONE submission (§7.1 admission-flight guard)", async () => {
		const { calls, client } = makeHarness();
		const renderer = await renderComposer(client, makeView());
		await typeText(renderer, "double click");
		const button = sendButton(renderer);
		await act(async () => {
			// Two clicks in ONE synchronous burst: the first admission is
			// in flight (the 202 has not landed), so the second must be a
			// no-op — React state is not committed between the two clicks.
			void button.props.onClick();
			void button.props.onClick();
		});
		const posts = () => calls.filter((c) => c.input.endsWith("/submissions"));
		expect(posts()).toHaveLength(1);
		// The guard releases once the admission resolves: a later click
		// (with fresh text) sends again.
		await typeText(renderer, "and again");
		await clickSend(renderer);
		expect(posts()).toHaveLength(2);
	});

	test("steer.busy flips the button to Steer and submits with whenBusy:steer", async () => {
		const { calls, client } = makeHarness();
		const renderer = await renderComposer(
			client,
			makeView({ steer: { busy: true, queued: 0 } }),
		);
		// Icon button: the accessible name carries the send/steer flip.
		const button = renderer.root.findByProps({ "aria-label": "Steer" });
		expect(button.props["aria-label"]).toBe("Steer");
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
		// The tooltip names used / window tokens (the B6 toolbar contract).
		expect(ring.props.title).toBe("500 / 1000 tokens");
	});

	test("the view's pi.agent doc drives the current model and re-rates the ring against it", async () => {
		const { client } = makeHarness();
		const view = makeView({
			docs: {
				"pi.agent": { model: { provider: "faux", modelId: "two" } },
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
		const toggle = renderer.root.findByProps({ "data-picker": "model" });
		expect(toggle.children.join("")).toContain("Faux Two");
		const ring = renderer.root.findByProps({ className: "composer-ring" });
		expect(ring.props["data-usage-percent"]).toBe(25);
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

	test("a read-access conversation renders the read-only composer (spec §5.9): disabled textarea, placeholder, no submit", async () => {
		const { calls, client } = makeHarness();
		const renderer = await renderAsync(
			<Composer
				client={client}
				conversationId={1}
				view={makeView()}
				readOnly
			/>,
		);
		const textarea = composerTextarea(renderer);
		expect(textarea.props.disabled).toBe(true);
		expect(textarea.props.placeholder).toBe("Read-only (shared with you)");
		// Typing is impossible through a disabled textarea, but the send
		// path is guarded too: nothing POSTs even with text in the draft.
		const send = sendButton(renderer);
		expect(send.props["aria-disabled"]).toBe(true);
		await act(async () => {
			await send.props.onClick();
		});
		expect(
			calls.filter((c) => c.input.endsWith("/submissions")),
		).toEqual([]);
	});

	describe("toolbar: live model + thinking pickers (B6)", () => {
		test("picking a model from the popover POSTs configure and the pill follows", async () => {
			const { calls, client } = makeHarness();
			const renderer = await renderComposer(client, makeView());
			openModelMenu(renderer);
			await act(async () => {
				renderer.root
					.findByProps({ "data-model-id": "faux/m2" })
					.props.onClick();
			});
			const configureCalls = calls.filter((c) => c.input.endsWith("/configure"));
			expect(configureCalls).toEqual([
				{
					input: "/v1/conversations/1/configure",
					method: "POST",
					body: JSON.stringify({ model: "faux/m2" }),
			},
			]);
			// The pill names the picked model immediately (the view frame is the
			// authority that follows).
			expect(
				renderer.root.findByProps({ "data-picker": "model" }).children.join(""),
			).toContain("Faux M2");
		});

		test("a rejected configure leaves the previous model shown and renders the error", async () => {
			const { client } = makeHarness();
			client.configure = () =>
				Promise.reject(
					new Error(
						"sigrun api: POST /v1/conversations/1/configure failed with status 400",
					),
			);
			const renderer = await renderComposer(client, makeView());
			openModelMenu(renderer);
			await act(async () => {
				renderer.root
					.findByProps({ "data-model-id": "faux/m2" })
					.props.onClick();
			});
			// The previous selection survives the failure (never silently lost).
			expect(
				renderer.root.findByProps({ "data-picker": "model" }).children.join(""),
			).toContain("Faux One");
			expect(textContent(renderer.toJSON())).toContain("failed with status 400");
			expect(renderer.root.findByProps({ role: "alert" })).toBeDefined();
		});

		test("the thinking picker renders even when every model has reasoning:false, and picking configures the level", async () => {
			// Both fixture models report reasoning:false — the picker must stay
		// (the flag is unreliable: glm-5.3-flash thinks but reports false).
			const { calls, client } = makeHarness({
				models: [MODELS[0]!, MODELS[2]!],
			});
			const renderer = await renderComposer(client, makeView());
			const toggle = renderer.root.findByProps({ "data-picker": "thinking" });
			expect(toggle.children.join("")).toContain("Thinking: default");
			act(() => {
				toggle.props.onClick();
			});
			await act(async () => {
				renderer.root
					.findByProps({ "data-thinking-level": "high" })
					.props.onClick();
			});
			const configureCalls = calls.filter((c) => c.input.endsWith("/configure"));
			expect(configureCalls).toEqual([
				{
					input: "/v1/conversations/1/configure",
					method: "POST",
					body: JSON.stringify({ thinking: "high" }),
			},
			]);
			expect(
				renderer.root.findByProps({ "data-picker": "thinking" }).children.join(""),
			).toContain("Thinking: high");
		});

		test("the hint line matches both enterToSend states exactly", async () => {
			const { client } = makeHarness();
		const renderer = await renderComposer(client, makeView());
			expect(
				renderer.root.findByProps({ className: "composer-hint" }).children,
			).toEqual(["Ctrl+Enter to send \u00b7 / for commands"]);
			const renderer2 = await renderAsync(
				<Composer
					client={client}
					conversationId={1}
					view={makeView()}
					enterToSend
				/>,
			);
			expect(
				renderer2.root.findByProps({ className: "composer-hint" }).children,
			).toEqual([
				"Enter to send \u00b7 Shift+Enter for newline \u00b7 / for commands",
			]);
		});

		test("a disabled send carries aria-disabled and the disabled class; text re-enables it", async () => {
			const { client } = makeHarness();
			const renderer = await renderComposer(client, makeView());
			const idle = renderer.root.findByProps({ "aria-label": "Send" });
			expect(idle.props["aria-disabled"]).toBe(true);
			expect((idle.props.className as string).includes("disabled")).toBe(true);
			await typeText(renderer, "some words");
			const live = renderer.root.findByProps({ "aria-label": "Send" });
			expect(live.props["aria-disabled"]).toBe(false);
			expect((live.props.className as string).includes("disabled")).toBe(false);
		});
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
			const uploads = calls.filter((c) => c.method === "PUT");
			expect(uploads).toEqual([
				{
					input: "/v1/conversations/1/uploads/pic.png",
					method: "PUT",
					// The raw bytes, not a base64 body (spec §6.2).
					body: new Uint8Array([104, 105]),
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

	});

	describe("slash commands (Task 7)", () => {
		/** The open menu's option list, by name (or [] when closed). */
		function menuNames(renderer: TestRenderer.ReactTestRenderer): string[] {
			const items = renderer.root.findAllByProps({
				className: "composer-command-name",
			});
			// The span's children are ["/", name] — join, don't take [0].
			return items.map((item) => item.children.join(""));
		}

		async function submitLine(
			renderer: TestRenderer.ReactTestRenderer,
			text: string,
		) {
			await typeText(renderer, text);
			await clickSend(renderer);
		}

		test("typing / as the first character opens the menu with the fetched commands", async () => {
			const { calls, client } = makeHarness();
			const renderer = await renderComposer(client, makeView());
			await typeText(renderer, "/");
			// The catalog was fetched once per mount from GET /v1/commands.
			expect(
				calls.filter((c) => c.input === "/v1/commands" && c.method === "GET"),
			).toHaveLength(1);
			expect(menuNames(renderer)).toEqual([
				"/new",
				"/fork",
				"/compact",
				"/export",
				"/import",
				"/name",
				"/model",
				"/thinking",
				"/hello",
				"/settings",
				"/review",
				"/skill:greet",
			]);
		});

		test("typing filter: `/na` narrows the menu to /name; a plain text line keeps it closed", async () => {
			const { client } = makeHarness();
			const renderer = await renderComposer(client, makeView());
			await typeText(renderer, "/na");
			expect(menuNames(renderer)).toEqual(["/name"]);
			await typeText(renderer, "plain message text");
			expect(menuNames(renderer)).toEqual([]);
		});

		test("selecting an arg-taking command from the menu inserts `/name ` for its args", async () => {
			const { client } = makeHarness();
			const renderer = await renderComposer(client, makeView());
			await typeText(renderer, "/na");
			const option = renderer.root.findByProps({
				className: "composer-command-name",
			});
			await act(async () => {
				option.parent!.props.onClick();
			});
			expect(composerTextarea(renderer).props.value).toBe("/name ");
		});

		test("`/name foo` submits the session-meta PATCH with {name: 'foo'}", async () => {
			const { calls, client } = makeHarness();
			const renderer = await renderComposer(client, makeView());
			await submitLine(renderer, "/name foo");
			const patches = calls.filter((c) => c.method === "PATCH");
			expect(patches.map((c) => c.body)).toContain(
				JSON.stringify({ name: "foo" }),
			);
			// The command line cleared from the composer.
			expect(composerTextarea(renderer).props.value).toBe("");
		});

		test("`/settings` opens the settings overlay via onOpenSettings (a shell action — never a conversation call)", async () => {
			const { calls, client } = makeHarness();
			let opened = 0;
			const renderer = await renderAsync(
				<Composer
					client={client}
					conversationId={1}
					view={makeView()}
					onOpenSettings={() => {
						opened += 1;
					}}
				/>,
			);
			await submitLine(renderer, "/settings");
			expect(opened).toBe(1);
			// No endpoint call — the command resolves shell-side.
			expect(
				calls.filter((c) => c.input === "/v1/settings/sections"),
			).toEqual([]);
			expect(
				calls.filter((c) => c.input.endsWith("/submissions")),
			).toEqual([]);
			expect(composerTextarea(renderer).props.value).toBe("");
		});

		test("an unknown /command on submit is a CLEAR alert-strip error, not a submission", async () => {
			const { calls, client } = makeHarness();
			const renderer = await renderComposer(client, makeView());
			await submitLine(renderer, "/bogus now");
			// Nothing submitted; the alert strip names the unknown command.
			expect(
				calls.filter((c) => c.input.endsWith("/submissions")),
			).toEqual([]);
			expect(textContent(renderer.toJSON())).toContain("unknown command: /bogus");
			expect(
				renderer.root.findByProps({ role: "alert" }),
			).toBeDefined();
		});

		test("selecting `/compact` from the menu inserts `/compact ` (it takes optional instructions), and submitting executes the POST", async () => {
			const { calls, client } = makeHarness();
			const renderer = await renderComposer(client, makeView());
			await typeText(renderer, "/com");
			const option = renderer.root.findByProps({
				className: "composer-command-name",
			});
			await act(async () => {
				option.parent!.props.onClick();
			});
			// Arg-taking commands INSERT for their args…
			expect(composerTextarea(renderer).props.value).toBe("/compact ");
			// …and an immediate submit executes the compact call ({} body — the
			// trailing space is an empty optional arg).
			await clickSend(renderer);
			const compactCall = calls.find(
				(c: { input: string; method?: string }) =>
					c.method === "POST" && c.input.endsWith("/compact"),
			);
			expect(compactCall).toBeDefined();
			expect(compactCall?.body).toBe(JSON.stringify({}));
		});

		test("selecting an ARGLESS command from the menu executes immediately (`/export`)", async () => {
			const { calls, client } = makeHarness();
			const renderer = await renderComposer(client, makeView());
			await typeText(renderer, "/exp");
			const option = renderer.root.findByProps({
				className: "composer-command-name",
			});
			await act(async () => {
				option.parent!.props.onClick();
			});
			const exportCall = calls.find((c) => c.input.endsWith("/export"));
			expect(exportCall?.method).toBe("GET");
		});

		test("`/compact instructions` passes the instructions in the body", async () => {
			const { calls, client } = makeHarness();
			const renderer = await renderComposer(client, makeView());
			await submitLine(renderer, "/compact keep the plan");
			const compactCall = calls.find(
				(c: { input: string; method?: string }) =>
					c.method === "POST" && c.input.endsWith("/compact"),
			);
			expect(compactCall?.body).toBe(
				JSON.stringify({ instructions: "keep the plan" }),
			);
		});

		test("`/fork 5` POSTs the fork endpoint with {at: 5} and navigates", async () => {
			const { calls, client } = makeHarness();
			const navigated: number[] = [];
			const renderer = await renderAsync(
				<Composer
					client={client}
					conversationId={1}
					view={makeView()}
					onNavigate={(id) => navigated.push(id)}
				/>,
			);
			await submitLine(renderer, "/fork 5");
			const forkCall = calls.find(
				(c: { input: string; method?: string }) =>
					c.method === "POST" && c.input.endsWith("/fork"),
			);
			expect(forkCall?.body).toBe(JSON.stringify({ at: 5 }));
			expect(navigated).toEqual([7]);
		});

		test("`/export` GETs the export route and reports the entry count", async () => {
			const { calls, client } = makeHarness();
			const renderer = await renderComposer(client, makeView());
			await submitLine(renderer, "/export");
			const exportCall = calls.find((c) => c.input.endsWith("/export"));
			expect(exportCall?.method).toBe("GET");
			expect(textContent(renderer.toJSON())).toContain("exported 2 entries");
		});

		test("an extension command POSTs its invoke endpoint and renders the returned notice (W5 Task 3)", async () => {
			const { calls, client } = makeHarness();
			const renderer = await renderComposer(client, makeView());
			await submitLine(renderer, "/hello bob");
			const invokeCall = calls.find((c) => c.input.endsWith("/commands/hello"));
			expect(invokeCall?.method).toBe("POST");
			expect(invokeCall?.body).toBe(JSON.stringify({ args: "bob" }));
			// The returned notice renders as the transient status banner.
			expect(textContent(renderer.toJSON())).toContain("hi bob");
		});

		test("`/import` POSTs the raw JSONL to the import route and navigates", async () => {
			const { calls, client } = makeHarness();
			const navigated: number[] = [];
			const renderer = await renderAsync(
				<Composer
					client={client}
					conversationId={1}
					view={makeView()}
					onNavigate={(id) => navigated.push(id)}
				/>,
			);
			const jsonl = '{"kind":"pi.user"}';
			await submitLine(renderer, `/import ${jsonl}`);
			const importCall = calls.find(
				(c: { input: string; method?: string }) =>
					c.method === "POST" && c.input === "/v1/conversations/import",
			);
			expect(importCall?.body).toBe(jsonl); // RAW text, not JSON-encoded
			expect(navigated).toEqual([8]);
		});

		test("`/name` with no args is a usage error in the alert strip", async () => {
			const { calls, client } = makeHarness();
			const renderer = await renderComposer(client, makeView());
			await submitLine(renderer, "/name");
			expect(
				calls.filter((c) => c.method === "PATCH"),
			).toEqual([]);
			expect(textContent(renderer.toJSON())).toContain("usage: /name <name>");
		});

		test("a failed command call surfaces the client error in the alert strip", async () => {
			const { client } = makeHarness();
			client.configure = () =>
				Promise.reject(
					new Error("sigrun api: POST /v1/conversations/1/configure failed with status 400"),
			);
			const renderer = await renderComposer(client, makeView());
			// /thinking is a configure command — a level outside the enum is a
			// USAGE error (client-side); a VALID level reaches the failing call.
			await submitLine(renderer, "/thinking high");
			expect(textContent(renderer.toJSON())).toContain("failed with status 400");
		});

		// ── Expand commands (Task 2c): /skill:name and prompt templates ──
		// The menu offers them like any command, but selecting INSERTS and
		// submitting SENDS the line — the server expands at admission, so
		// the composer never calls an endpoint and never errors locally.

		test("the menu shows expand entries with their argument-hint, filtered by prefix", async () => {
			const { client } = makeHarness();
			const renderer = await renderComposer(client, makeView());
			await typeText(renderer, "/re");
			expect(menuNames(renderer)).toEqual(["/review"]);
			// The template's argument-hint renders in the option (the menu is
			// the only text on screen with `/review` in it right now).
			expect(textContent(renderer.toJSON())).toContain("<focus>");
			await typeText(renderer, "/skill:g");
			expect(menuNames(renderer)).toEqual(["/skill:greet"]);
		});

		test("selecting an expand template from the menu inserts `/review ` and does NOT submit", async () => {
			const { calls, client } = makeHarness();
			const renderer = await renderComposer(client, makeView());
			await typeText(renderer, "/re");
			const option = renderer.root.findByProps({
				className: "composer-command-name",
			});
			await act(async () => {
				option.parent!.props.onClick();
			});
			expect(composerTextarea(renderer).props.value).toBe("/review ");
			// Nothing was called — insertion only (the server expands on send).
			expect(
				calls.filter((c) => c.input.endsWith("/submissions")),
			).toEqual([]);
		});

		test("selecting a skill from the menu inserts `/skill:greet ` (trailing space even with no argsHint)", async () => {
			const { client } = makeHarness();
			const renderer = await renderComposer(client, makeView());
			await typeText(renderer, "/skill:g");
			const option = renderer.root.findByProps({
				className: "composer-command-name",
			});
			await act(async () => {
				option.parent!.props.onClick();
			});
			expect(composerTextarea(renderer).props.value).toBe("/skill:greet ");
		});

		test("sending `/review concurrency` SUBMITS the line (the server expands at admission)", async () => {
			const { calls, client } = makeHarness();
			const renderer = await renderComposer(client, makeView());
			await submitLine(renderer, "/review concurrency");
			const posts = calls.filter((c) => c.input.endsWith("/submissions"));
			expect(posts).toEqual([
				{
					input: "/v1/conversations/1/submissions",
					method: "POST",
					body: JSON.stringify({
						input: [{ type: "text", text: "/review concurrency" }],
					}),
				},
			]);
			// No endpoint call, no alert — expansion is the server's job.
			expect(textContent(renderer.toJSON())).not.toContain("unknown command");
			expect(
				renderer.root.findAllByProps({ role: "alert" }),
			).toHaveLength(0);
		});

		test("sending `/skill:greet hej` submits the line verbatim", async () => {
			const { calls, client } = makeHarness();
			const renderer = await renderComposer(client, makeView());
			await submitLine(renderer, "/skill:greet hej");
			const posts = calls.filter((c) => c.input.endsWith("/submissions"));
			expect(posts.map((post) => post.body)).toEqual([
				JSON.stringify({ input: [{ type: "text", text: "/skill:greet hej" }] }),
			]);
		});

		test("an UNKNOWN skill name is never an unknown-command error — it submits (the server passes it through)", async () => {
			const { calls, client } = makeHarness();
			const renderer = await renderComposer(client, makeView());
			await submitLine(renderer, "/skill:nope x");
			expect(
				calls.filter((c) => c.input.endsWith("/submissions")).length,
			).toBe(1);
			expect(textContent(renderer.toJSON())).not.toContain("unknown command");
			expect(
				renderer.root.findAllByProps({ role: "alert" }),
			).toHaveLength(0);
		});

		// ── Live catalog (fix round): the server re-scans per request, the
		// client's mount cache must not mask a template added mid-session ──

		test("a template added mid-session becomes submittable after one refetch (no unknown-command error)", async () => {
			const { calls, client } = makeHarness({
				laterCommands: [
					{ name: "deploy", description: "Deploy the thing", argsHint: "<target>", kind: "expand" },
				],
			});
			const renderer = await renderComposer(client, makeView());
			// Not in the mount catalog: the send path must REFETCH once and
			// re-evaluate before deciding "unknown command".
			await submitLine(renderer, "/deploy prod");
			const gets = calls.filter((c) => c.input === "/v1/commands");
			expect(gets.length).toBeGreaterThanOrEqual(2);
			expect(
				calls.filter((c) => c.input.endsWith("/submissions")).map((c) => c.body),
			).toEqual([
				JSON.stringify({ input: [{ type: "text", text: "/deploy prod" }] }),
			]);
			expect(textContent(renderer.toJSON())).not.toContain("unknown command: /deploy");
			expect(
				renderer.root.findAllByProps({ role: "alert" }),
			).toHaveLength(0);
			// The refetched catalog also lands in state: the menu offers it now.
			await typeText(renderer, "/dep");
			const menu = renderer.root.findAllByProps({
				className: "composer-command-name",
			});
			expect(menu.map((item) => item.children.join(""))).toEqual(["/deploy"]);
		});

		test("a genuinely unknown command still errors after the refetch (the refetch is not a free pass)", async () => {
			const { calls, client } = makeHarness();
			const renderer = await renderComposer(client, makeView());
			await submitLine(renderer, "/bogus now");
			// One mount fetch + one refetch, then the honest error.
			expect(calls.filter((c) => c.input === "/v1/commands").length).toBe(2);
			expect(
				calls.filter((c) => c.input.endsWith("/submissions")),
			).toEqual([]);
			expect(textContent(renderer.toJSON())).toContain("unknown command: /bogus");
		});
	});
});

describe("Composer submit keys", () => {
	test("Ctrl+Enter submits; plain Enter never does by default", async () => {
		const { calls, client } = makeHarness();
		const renderer = await renderComposer(client, makeView());
		await typeText(renderer, "hello chord");
		const textarea = composerTextarea(renderer);
		await act(async () => {
			textarea.props.onKeyDown({
				key: "Enter",
				ctrlKey: true,
				preventDefault: () => {},
			});
		});
		expect(
			calls.some(
				(c) => c.method === "POST" && c.input.endsWith("/submissions"),
			),
		).toBe(true);
		const callsAfterCtrl = calls.length;
		await typeText(renderer, "second");
		await act(async () => {
			textarea.props.onKeyDown({
				key: "Enter",
				ctrlKey: false,
				preventDefault: () => {},
			});
		});
		expect(calls.length).toBe(callsAfterCtrl);
	});

	test("enterToSend makes plain Enter submit (shift+Enter still newlines)", async () => {
		const { calls, client } = makeHarness();
		const renderer = await renderAsync(
			<Composer
				client={client}
				conversationId={1}
				view={makeView()}
				enterToSend
			/>,
		);
		await typeText(renderer, "hello enter");
		const textarea = composerTextarea(renderer);
		await act(async () => {
			textarea.props.onKeyDown({
				key: "Enter",
				ctrlKey: false,
				shiftKey: false,
				preventDefault: () => {},
			});
		});
		expect(
			calls.some(
				(c) => c.method === "POST" && c.input.endsWith("/submissions"),
			),
		).toBe(true);
		const count = calls.length;
		await typeText(renderer, "more");
		await act(async () => {
			textarea.props.onKeyDown({
				key: "Enter",
				ctrlKey: false,
				shiftKey: true,
				preventDefault: () => {},
			});
		});
		expect(calls.length).toBe(count);
	});

	test("Cmd+Enter submits (the mac submit chord)", async () => {
		const { calls, client } = makeHarness();
		const renderer = await renderComposer(client, makeView());
		await typeText(renderer, "hello cmd");
		const textarea = composerTextarea(renderer);
		await act(async () => {
			textarea.props.onKeyDown({
				key: "Enter",
				metaKey: true,
				ctrlKey: false,
				preventDefault: () => {},
			});
		});
		expect(
			calls.some(
				(c) => c.method === "POST" && c.input.endsWith("/submissions"),
			),
		).toBe(true);
	});
});
