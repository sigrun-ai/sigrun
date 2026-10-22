/**
 * The App shell (B2, UI refresh): the section rail + sidebar drawer, the
 * chat pane under ChatHeader, and the mode-switchable RightPanel over the
 * composer footer. Stub fetch for the §5 HTTP calls; StubEventSource for
 * the stream.
 */

import { act } from "react";
import { describe, expect, test } from "vitest";
import { App } from "./App";
import {
	createClient,
	type ConversationMeta,
	type FetchLike,
	type MetaResponse,
} from "./api";
import { PINNED_SCHEMA_VERSION } from "./schema-version";
import type { EventSourceFactory } from "./stream";
import {
	makeEntry,
	makeView,
	renderAsync,
	StubEventSource,
	textContent,
	textMessage,
} from "./test-utils";

type Call = { input: string; method?: string; body?: string | Uint8Array };

function makeMeta(init?: {
	readonly schemaVersion?: string;
}): MetaResponse {
	return {
		version: "0.0.0-test",
		harnessVersion: "1.0.2",
		schemaVersion: init?.schemaVersion ?? PINNED_SCHEMA_VERSION,
		extensions: [
			{ name: "memory", status: "ok" },
			{ name: "gatekeeper", status: "ok" },
		],
		health: { backup: "unconfigured", memory: "ok", providers: "ok" },
		auth: { methods: [], claimed: true },
		backup: {},
		capabilities: { backup: false, channels: ["webui"] },
		seam: { interactions: [], ambient: [] },
		collisions: { webui: [], providers: [], commands: [] },
	};
}

function makeHarness(init?: {
	readonly meta?: MetaResponse;
	readonly metaFails?: boolean;
	/** Serve a 500 for the FIRST conversation-meta PATCH, then succeed (the
	 * shell-error recovery test's scripted failure). */
	readonly failFirstMetaPatch?: boolean;
}) {
	let metaPatchFails = init?.failFirstMetaPatch === true;
	const metas: Record<number, ConversationMeta> = {
		1: {
			pinned: false,
			tagged: [],
			archived: false,
			draft: { text: "", attachments: [] },
			source: "user",
		},
		2: {
			pinned: false,
			tagged: [],
			archived: false,
			draft: { text: "", attachments: [] },
			source: "user",
		},
	};
	const conversations = [
		{
			id: 1,
			root: true,
			archived: false,
			pinned: false,
			name: "Tide table rewrite",
			lastActivityAt: new Date().toISOString(),
		},
		{
			id: 2,
			root: false,
			archived: false,
			pinned: false,
			name: "Moor line inspection",
			lastActivityAt: new Date().toISOString(),
		},
	];
	const calls: Call[] = [];
	const fetchImpl: FetchLike = (input, init2) => {
		calls.push({ input, method: init2?.method, body: init2?.body });
		if (input === "/v1/meta") {
			if (init?.metaFails === true) {
				return Promise.resolve({
					ok: false,
					status: 500,
					json: () => Promise.resolve({}),
					text: () => Promise.resolve(String({})),
				});
			}
			return Promise.resolve({
				ok: true,
				status: 200,
				json: () => Promise.resolve(init?.meta ?? makeMeta()),
				text: () => Promise.resolve(String(init?.meta ?? makeMeta())),
			});
		}
		const metaMatch = /^\/v1\/conversations\/(\d+)\/meta$/.exec(input);
		let body: unknown;
		if (metaMatch !== null) {
			const id = Number(metaMatch[1]);
			if (init2?.method === "PATCH" && metaPatchFails) {
				metaPatchFails = false;
				return Promise.resolve({
					ok: false,
					status: 500,
					json: () => Promise.resolve({ message: "meta write failed" }),
					text: () => Promise.resolve("meta write failed"),
				});
			}
			if (init2?.method === "PATCH") {
				// The server-side merge: a name/archived patch updates the
				// summary the list serves (the reload re-reads it).
				const patch = JSON.parse(
					typeof init2.body === "string" ? init2.body : "{}",
				) as {
					name?: string;
					archived?: boolean;
				};
				const target = conversations.find((one) => one.id === id);
				if (target !== undefined && patch.name !== undefined) {
					target.name = patch.name;
				}
				if (target !== undefined && patch.archived !== undefined) {
					target.archived = patch.archived;
				}
				body = {};
			} else {
				body = metas[id];
			}
		} else if (input === "/v1/models") body = { models: [] };
		else if (/^\/v1\/conversations\/\d+\/files\?/.test(input)) {
			body = { entries: [] };
		} else {
			// A copy per response — freshly parsed JSON in reality; a
			// same-reference list would bail out of the reload re-render.
			body = { conversations: conversations.map((one) => ({ ...one })) };
		}
		return Promise.resolve({
			ok: true,
			status: 200,
			json: () => Promise.resolve(body),
			text: () => Promise.resolve(String(body)),
		});
	};
	const sources: { url: string; source: StubEventSource }[] = [];
	const createEventSource: EventSourceFactory = (url) => {
		const source = new StubEventSource();
		sources.push({ url, source });
		return source;
	};
	const client = createClient({ fetch: fetchImpl });
	return {
		calls,
		client,
		createEventSource,
		sources,
	};
}

/** Click a sidebar conversation row by its display name (its title). */
async function clickConversation(
	renderer: Awaited<ReturnType<typeof renderAsync>>,
	name: string,
): Promise<void> {
	const button = renderer.root.findByProps({
		className: "session-select",
		title: name,
	});
	await act(async () => {
		await (button.props as { onClick: () => unknown }).onClick();
	});
}

/** Click a header panel toggle by its aria-label hook. */
async function clickPanel(
	renderer: Awaited<ReturnType<typeof renderAsync>>,
	panel: "outline" | "workspace",
): Promise<void> {
	const button = renderer.root.findByProps({ "aria-label": panel });
	await act(async () => {
		(button.props as { onClick: () => unknown }).onClick();
	});
}

describe("App shell", () => {
	test("boots past the schema gate and renders the rail + header shell with the meta health dot", async () => {
		const { client, createEventSource } = makeHarness();
		const renderer = await renderAsync(
			<App client={client} createEventSource={createEventSource} />,
		);
		// The rail mounts with the health dot fed from the meta (extensions
		// all ok + memory/providers ok + backup not degraded → ok).
		const rail = renderer.root.findByProps({ className: "rail" });
		expect(rail.findByProps({ className: "rail-brand" }).props.title).toBe(
			"sigrun",
		);
		const dot = rail.findByProps({ className: "rail-health" });
		expect(dot.props["data-health"]).toBe("ok");
		expect(dot.props.title).toContain("memory: ok");
		expect(dot.props.title).toContain("backup: unconfigured");
		// The old top bar is gone; the chat header owns the title now.
		expect(
			renderer.root.findAllByProps({ className: "top-bar" }),
		).toHaveLength(0);
		expect(
			renderer.root.findAllByProps({ className: "chat-header" }),
		).toHaveLength(1);
		// The shell renders beneath; the boot-time default selection picks
		// the root conversation, so the transcript area is live.
		expect(textContent(renderer.toJSON())).not.toContain(
			"Select or create a conversation",
		);
	});

	test("a schemaVersion mismatch REFUSES to render (fail loud, spec §5)", async () => {
		const { client, createEventSource } = makeHarness({
			meta: makeMeta({ schemaVersion: "0".repeat(64) }),
		});
		const renderer = await renderAsync(
			<App client={client} createEventSource={createEventSource} />,
		);
		const text = textContent(renderer.toJSON());
		expect(text).toContain("schema");
		expect(text).toContain(PINNED_SCHEMA_VERSION.slice(0, 12));
		// The shell does NOT render behind the refusal.
		expect(
			renderer.root.findAllByProps({ className: "session-list" }),
		).toHaveLength(0);
		expect(
			renderer.root.findAllByProps({ className: "composer" }),
		).toHaveLength(0);
	});

	test("a meta fetch failure refuses to render (unverifiable schema is a mismatch-class failure)", async () => {
		const { client, createEventSource } = makeHarness({ metaFails: true });
		const renderer = await renderAsync(
			<App client={client} createEventSource={createEventSource} />,
		);
		const text = textContent(renderer.toJSON());
		expect(text).toContain("schema");
		expect(
			renderer.root.findAllByProps({ className: "session-list" }),
		).toHaveLength(0);
	});

	test("composes sidebar + chat pane + composer slot; the boot-time default selects the root conversation and opens its stream", async () => {
		const { client, createEventSource, sources } = makeHarness();
		const renderer = await renderAsync(
			<App client={client} createEventSource={createEventSource} />,
		);
		const text = textContent(renderer.toJSON());
		// Sidebar conversations rendered (grouped under Today — the activity
		// stamps are fresh).
		expect(text).toContain("Tide table rewrite");
		expect(text).toContain("Moor line inspection");
		expect(text).toContain("Today");
		// The boot-time default selection picked the root conversation (id 1)
		// and opened its stream — the composer is live without a click.
		expect(text).not.toContain("Select or create a conversation");
		const composer = renderer.root.findByProps({
			className: "composer-slot",
		});
		expect(composer.findAllByProps({ className: "composer" })).toHaveLength(
			1,
		);
		// The events source rides FIRST (the list hook's shared /v1/events —
		// the jobs panel's job.changed nudge rides it too, W4 Task 5), then
		// the boot-selected root conversation's stream.
		expect(sources.map((s) => s.url)).toEqual([
			"/v1/events",
			"/v1/conversations/1/stream",
		]);
		// The right panel is closed by default (mode null renders nothing).
		expect(
			renderer.root.findAllByProps({ className: "right-panel" }),
		).toHaveLength(0);
	});

	test("Outline opens the panel; Outline again closes it; Workspace replaces Outline", async () => {
		const { client, createEventSource } = makeHarness();
		const renderer = await renderAsync(
			<App client={client} createEventSource={createEventSource} />,
		);
		await clickPanel(renderer, "outline");
		let panel = renderer.root.findByProps({ className: "right-panel" });
		expect(panel.props["data-panel"]).toBe("outline");
		// Clicking the active mode closes the panel (mode → null).
		await clickPanel(renderer, "outline");
		expect(
			renderer.root.findAllByProps({ className: "right-panel" }),
		).toHaveLength(0);
		// Workspace replaces Outline when both would be open.
		await clickPanel(renderer, "outline");
		await clickPanel(renderer, "workspace");
		panel = renderer.root.findByProps({ className: "right-panel" });
		expect(panel.props["data-panel"]).toBe("workspace");
	});

	test("the old top-bar accent select (and theme controls) are gone", async () => {
		const { client, createEventSource } = makeHarness();
		const renderer = await renderAsync(
			<App client={client} createEventSource={createEventSource} />,
		);
		expect(
			renderer.root.findAllByProps({ className: "accent-picker" }),
		).toHaveLength(0);
		expect(
			renderer.root.findAllByProps({ className: "theme-controls" }),
		).toHaveLength(0);
	});

	test("selecting a conversation drives the view hook and renders the transcript; the Workspace panel lists that conversation's files", async () => {
		const { calls, client, createEventSource, sources } = makeHarness();
		const renderer = await renderAsync(
			<App client={client} createEventSource={createEventSource} />,
		);
		// The boot default selected the root (id 1) and opened its stream
		// (sources[0] is the shared /v1/events source).
		expect(sources.map((s) => s.url)).toEqual([
			"/v1/events",
			"/v1/conversations/1/stream",
		]);
		await clickConversation(renderer, "Moor line inspection");
		expect(sources.map((s) => s.url)).toEqual([
			"/v1/events",
			"/v1/conversations/1/stream",
			"/v1/conversations/2/stream",
		]);
		// sources[2] is conversation 2's stream.
		act(() => {
			sources[2]?.source.emit(
				"snapshot",
				JSON.stringify(
					makeView({
						id: 2,
						entries: [
							makeEntry(
								"pi.user",
								[textMessage("user", "hello from conversation two")],
								{ id: 10, conversationId: 2 },
							),
						],
					}),
				),
			);
		});
		const text = textContent(renderer.toJSON());
		expect(text).toContain("hello from conversation two");
		// Opening the Workspace panel lists conversation 2's workspace root.
		expect(calls.map((c) => c.input)).not.toContain(
			"/v1/conversations/2/files?path=.",
		);
		await clickPanel(renderer, "workspace");
		expect(calls.map((c) => c.input)).toContain(
			"/v1/conversations/2/files?path=.",
		);
	});

	test("switching the active id re-drives the view hook (new stream, old closed)", async () => {
		const { client, createEventSource, sources } = makeHarness();
		const renderer = await renderAsync(
			<App client={client} createEventSource={createEventSource} />,
		);
		await clickConversation(renderer, "Tide table rewrite");
		await clickConversation(renderer, "Moor line inspection");
		expect(sources.map((s) => s.url)).toEqual([
			"/v1/events",
			"/v1/conversations/1/stream",
			"/v1/conversations/2/stream",
		]);
		expect(sources[1]?.source.closed).toBe(true);
		expect(sources[2]?.source.closed).toBe(false);
	});

	test("renaming from the header persists the name and updates the title", async () => {
		const { calls, client, createEventSource } = makeHarness();
		const renderer = await renderAsync(
			<App client={client} createEventSource={createEventSource} />,
		);
		// Boot default: conversation 1, named → its display name is the title.
		expect(textContent(renderer.toJSON())).toContain("Tide table rewrite");
		const title = renderer.root.findByProps({ className: "chat-title" });
		await act(async () => {
			(title.props as { onClick: () => unknown }).onClick();
		});
		const input = renderer.root.findByProps({
			className: "chat-title-input",
		});
		act(() => {
			(input.props as {
				onChange: (event: { target: { value: string } }) => void;
			}).onChange({ target: { value: "Fjord walking routes" } });
		});
		await act(async () => {
			(input.props as {
				onKeyDown: (event: { key: string }) => void;
			}).onKeyDown({ key: "Enter" });
		});
		const patch = calls.find(
			(call) =>
				call.input === "/v1/conversations/1/meta" && call.method === "PATCH",
		);
		expect(patch?.body).toContain("Fjord walking routes");
		expect(textContent(renderer.toJSON())).toContain("Fjord walking routes");
	});

	test("the ⋯ menu's Export and Compact forward to the client", async () => {
		const { calls, client, createEventSource } = makeHarness();
		const renderer = await renderAsync(
			<App client={client} createEventSource={createEventSource} />,
		);
		const more = renderer.root.findByProps({ "aria-label": "more actions" });
		await act(async () => {
			(more.props as { onClick: () => unknown }).onClick();
		});
		const menu = renderer.root.findByProps({ className: "chat-menu" });
		await act(async () => {
			(menu.findByProps({ "data-menu-action": "export" }).props as {
				onClick: () => unknown;
			}).onClick();
		});
		expect(calls.map((call) => call.input)).toContain(
			"/v1/conversations/1/export",
		);
		await act(async () => {
			(renderer.root.findByProps({ "aria-label": "more actions" }).props as {
				onClick: () => unknown;
			}).onClick();
		});
		const menu2 = renderer.root.findByProps({ className: "chat-menu" });
		await act(async () => {
			(menu2.findByProps({ "data-menu-action": "compact" }).props as {
				onClick: () => unknown;
			}).onClick();
		});
		expect(calls.map((call) => call.input)).toContain(
			"/v1/conversations/1/compact",
		);
	});

	test("the Outline panel lists the conversation's user prompts; the scroll fade rides above the composer dock", async () => {
		const { client, createEventSource, sources } = makeHarness();
		const renderer = await renderAsync(
			<App client={client} createEventSource={createEventSource} />,
		);
		act(() => {
			sources[1]?.source.emit(
			"snapshot",
				JSON.stringify(
					makeView({
						id: 1,
						entries: [
							makeEntry(
								"pi.user",
								[textMessage("user", "What is at the filesystem root?")],
								{ id: 10, conversationId: 1 },
							),
							makeEntry(
								"pi.assistant",
								[textMessage("assistant", "The root has `bin` and `etc`.")],
								{ id: 11, conversationId: 1 },
							),
							makeEntry(
								"pi.user",
								[textMessage("user", "Yes — Hugo, English + French")],
								{ id: 12, conversationId: 1 },
							),
						],
					}),
				),
			);
		});
		await clickPanel(renderer, "outline");
		const panel = renderer.root.findByProps({ className: "right-panel" });
		const items = panel.findAllByProps({ className: "outline-item" });
		expect(items).toHaveLength(2);
		expect(items[0]?.props["data-entry-id"]).toBe(10);
		expect(items[1]?.props["data-entry-id"]).toBe(12);
		expect(textContent(renderer.toJSON())).toContain(
			"What is at the filesystem root?",
		);
		expect(textContent(renderer.toJSON())).toContain(
			"Yes — Hugo, English + French",
		);
		// The scroll fade (B5): one pointer-events-none overlay over the
		// transcript bottom, ahead of the composer dock.
		expect(
			renderer.root.findAllByProps({ className: "chat-fade" }),
		).toHaveLength(1);
		renderer.unmount();
	});

	test("a shell error clears when a later action succeeds", async () => {
		const { client, createEventSource } = makeHarness({
			failFirstMetaPatch: true,
		});
		const renderer = await renderAsync(
			<App client={client} createEventSource={createEventSource} />,
		);
		const more = renderer.root.findByProps({ "aria-label": "more actions" });
		const archive = async (): Promise<void> => {
			await act(async () => {
				(more.props as { onClick: () => unknown }).onClick();
			});
			await act(async () => {
				await (
					renderer.root.findByProps({ "data-menu-action": "archive" })
						.props as { onClick: () => unknown }
				).onClick();
			});
		};
		await archive();
		expect(
			renderer.root.findAllByProps({ className: "shell-error" }),
		).toHaveLength(1);
		// The retry succeeds — the stale failure must not outlive it.
		await archive();
		expect(
			renderer.root.findAllByProps({ className: "shell-error" }),
		).toHaveLength(0);
	});

	test("the rail's Settings button opens the settings panel", async () => {
		const { client, createEventSource } = makeHarness();
		const renderer = await renderAsync(
			<App client={client} createEventSource={createEventSource} />,
		);
		expect(
			renderer.root.findAllByProps({ className: "settings-overlay" }),
		).toHaveLength(0);
		const settings = renderer.root.findByProps({ "aria-label": "settings" });
		await act(async () => {
			(settings.props as { onClick: () => unknown }).onClick();
		});
		expect(
			renderer.root.findAllByProps({ className: "settings-overlay" }),
		).toHaveLength(1);
	});
});
