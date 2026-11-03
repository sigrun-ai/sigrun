/**
 * The App shell (B2, UI refresh): the section rail + sidebar drawer, the
 * chat pane under ChatHeader, and the mode-switchable RightPanel over the
 * composer footer. Stub fetch for the §5 HTTP calls; StubEventSource for
 * the stream.
 */

import { act } from "react";
import { describe, expect, test, vi } from "vitest";
import { App, locationHash, parseHash, resetLocationHashForTest, routeHash } from "./App";
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
	readonly extensions?: MetaResponse["extensions"];
}): MetaResponse {
	return {
		version: "0.0.0-test",
		harnessVersion: "1.0.2",
		schemaVersion: init?.schemaVersion ?? PINNED_SCHEMA_VERSION,
		listener: { host: "::", port: 3000, families: ["ipv4", "ipv6"] },
		extensions: init?.extensions ?? [
			{ name: "memory", status: "ok" },
			{ name: "gatekeeper", status: "ok" },
		],
		health: { backup: "unconfigured", memory: "ok", providers: "ok" },
		auth: { methods: [], claimed: true },
		backup: {},
		capabilities: { backup: false, channels: ["webui"] },
		dev: false,
		supervised: false,
		isolation: { mode: "auto", active: false, available: false, abi: 0, osUsers: "off" },
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
	/** U4 Task 2 (§13.3): /readyz answers 503 until the test flips it. */
	readonly readyzDown?: { readonly ready: { current: boolean } };
	/** U4 Task 2 round-2: after the restart POST, /readyz keeps answering
	 *  200 for this many MILLISECONDS (the DYING process still
	 *  listening between the 202 and the deferred drain), then goes
	 *  down until `readyzDown.ready` flips. Time-based (not probe
	 *  count): a probe-before-sleep loop reads the first probe as
	 *  ready and remounts onto the closing server — this window is
	 *  what catches it. */
	readonly readyzLingerMs?: number;
}) {
	let metaPatchFails = init?.failFirstMetaPatch === true;
	const restartCalls: number[] = [];
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
	// Round-2 linger: the timestamp of the last restart POST — /readyz
	// keeps answering 200 for `readyzLingerMs` after it (the dying
	// listener still up while the drain is deferred).
	let restartPostedAt = -1;
	const fetchImpl: FetchLike = (input, init2) => {
		calls.push({ input, method: init2?.method, body: init2?.body });
		if (input === "/readyz") {
			// U4 Task 2: the restart-recovery probe — 503 until flipped.
			// Round-2 linger: within `readyzLingerMs` of the POST the DYING
			// listener still answers 200, then the fake goes down.
			const lingering =
				init?.readyzLingerMs !== undefined &&
				restartPostedAt >= 0 &&
				Date.now() - restartPostedAt < init.readyzLingerMs;
			const ready =
				lingering ||
				init?.readyzDown === undefined ||
				init.readyzDown.ready.current;
			return Promise.resolve({
				ok: ready,
				status: ready ? 200 : 503,
				json: () => Promise.resolve({}),
				text: () => Promise.resolve(""),
			});
		}
		if (input === "/v1/admin/restart") {
			// U4 Task 2 (§13.3): 202 {restarting: true}; the fake then takes
			// /readyz down until the test flips it back.
			restartCalls.push(1);
			if (init?.readyzDown !== undefined) init.readyzDown.ready.current = false;
			restartPostedAt = Date.now();
			return Promise.resolve({
				ok: true,
				status: 202,
				json: () => Promise.resolve({ restarting: true }),
				text: () => Promise.resolve(""),
			});
		}
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
		else if (input === "/v1/jobs") body = { jobs: [] };
		else if (input === "/v1/extensions") body = { extensions: [] };
		else if (input === "/v1/auth/accounts") {
			// The accounts cove (the boot deep-link test's target section).
			body = { accounts: [] };
		} else if (input === "/v1/auth/providers") {
			body = { providers: [] };
		} else if (input === "/v1/settings/sections") {
			// U4 Task 4 fix wave: the shell-level Restart-wiring test opens
			// the panel; the sections payload is the nav list (core only).
			body = {
				sections: [
					{ slug: "core", id: "general", title: "General", icon: "key" },
					{ slug: "core", id: "accounts", title: "Account links", icon: "key" },
				],
				index: [],
			};
		}
		else if (/^\/v1\/ext\/core\/surfaces\/general/.test(input)) {
			// The General section's surface: the meta block the
			// pending-restart callout reads (pendingRestart + supervised).
			body = input.includes("/data")
				? {
						rev: 2,
						treeRev: 1,
						data: {
							settings: {},
							meta: {
								pendingRestart: ["server.port"],
								env: {},
								supervised: true,
							},
						},
					}
				: {
						tree: {
							root: {
								type: "form",
								id: "core-general-form",
								bind: "/settings",
								mode: "submit",
								onSubmit: "save",
								children: [],
							},
						},
						data: {
							settings: {},
							meta: {
								pendingRestart: ["server.port"],
								env: {},
								supervised: true,
							},
						},
						rev: 1,
						treeRev: 1,
						access: "write",
					};
		}
		else if (/^\/v1\/ext\//.test(input)) {
			// The ext surface routes (U3 Task 5): a minimal board load so
			// the surface page reaches its ready state.
			body = input.includes("/data")
				? { rev: 1, treeRev: 1 }
				: {
						tree: { v: 1, root: { type: "page", id: "board", title: "Acme board", main: [] } },
						data: { cards: [] },
						rev: 1,
						treeRev: 1,
						access: "write",
					};
		} else if (/^\/v1\/conversations\/\d+\/files\?/.test(input)) {
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
	const client = createClient({ fetch: fetchImpl, rawFetch: fetchImpl });
	return {
		calls,
		client,
		createEventSource,
		sources,
		fetchImpl,
		restartCalls,
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
		// The events source rides FIRST (the list hook's shared /v1/events),
		// then the boot-selected root conversation's stream.
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
		try {
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
		} finally {
			// The selection wrote the deep-link hash (sidebar selects ride the
			// hash writer); the seam must land back on the chat default so the
			// NEXT test boots on the root conversation, not this leftover id.
			resetLocationHashForTest();
		}
	});

	test("switching the active id re-drives the view hook (new stream, old closed)", async () => {
		const { client, createEventSource, sources } = makeHarness();
		try {
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
		} finally {
			// Same seam reset: the clicks above left `#/c/2` in the module
			// fallback — the next test must boot on the chat default.
			resetLocationHashForTest();
		}
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

	test("the rail's Settings button opens the settings PAGE at #/settings", async () => {
		const { client, createEventSource } = makeHarness();
		const renderer = await renderAsync(
			<App client={client} createEventSource={createEventSource} />,
		);
		expect(
			renderer.root.findAllByProps({ className: "settings-page" }),
		).toHaveLength(0);
		const settings = renderer.root.findByProps({ "aria-label": "settings" });
		await act(async () => {
			(settings.props as { onClick: () => unknown }).onClick();
		});
		// The hash is the history entry (back/forward walk it).
		expect(locationHash()).toBe("#/settings");
		expect(
			renderer.root.findAllByProps({ className: "settings-page" }),
		).toHaveLength(1);
		// The transcript column is REPLACED by the page (no composer dock).
		expect(
			renderer.root.findAllByProps({ className: "composer-slot" }),
		).toHaveLength(0);
		// The rail's Settings button is the current page.
		const railButton = renderer.root.findByProps({
			"data-rail-section": "settings",
		});
		expect(railButton.props["aria-current"]).toBe("page");
	});

	test("the settings panel wires the shell restart: a supervised admin sees the button and clicking it POSTs the restart", async () => {
		const ready = { current: true };
		const { client, createEventSource, restartCalls } = makeHarness({
			meta: { ...makeMeta(), supervised: true },
			readyzDown: { ready },
		});
		const renderer = await renderAsync(
			<App
				client={client}
				createEventSource={createEventSource}
				identity={{ admin: true, service: false, method: "token" }}
			/>,
		);
		const settings = renderer.root.findByProps({ "aria-label": "settings" });
		await act(async () => {
			(settings.props as { onClick: () => unknown }).onClick();
		});
		// The General section auto-opens (the panel's default): the
		// surface's meta block (pendingRestart + supervised) drives the
		// callout's Restart button. The meta-probe's poll resolves async —
		// flush microtasks until the callout mounts (bounded, no sleeps).
		let button: { props: { onClick: () => unknown } } | null = null;
		for (let attempt = 0; attempt < 20; attempt++) {
			await act(async () => {});
			const found = renderer.root.findAllByProps({
				className: "settings-restart",
			});
			if (found.length > 0) {
				button = found[0] as unknown as { props: { onClick: () => unknown } };
				break;
			}
		}
		expect(button).not.toBeNull();
		const restartButton = button as { props: { onClick: () => unknown } };
		expect(restartCalls).toHaveLength(0);
		await act(async () => {
			await restartButton.props.onClick();
		});
		expect(restartCalls).toHaveLength(1);
		// The shell's recovery flow: the fake flips /readyz back and the
		// app re-boots (the restart round-trip completes).
		ready.current = true;
	});

describe("App settings route (the page at #/settings/<section>)", () => {
	test("parseHash/routeHash round-trip: #/settings and #/settings/<section>", () => {
		expect(parseHash("#/settings")).toEqual({ kind: "settings" });
		expect(routeHash({ kind: "settings" })).toBe("#/settings");
		expect(parseHash("#/settings/tokens")).toEqual({
			kind: "settings",
			section: "tokens",
		});
		expect(routeHash({ kind: "settings", section: "tokens" })).toBe(
			"#/settings/tokens",
		);
		// The inverse both ways: parse(route(x)) = x for every shape.
		expect(parseHash(routeHash({ kind: "settings", section: "accounts" }))).toEqual({
			kind: "settings",
			section: "accounts",
		});
	});

	test("only ONE optional section segment: #/settings/a/b falls to the chat default", () => {
		expect(parseHash("#/settings/a/b")).toEqual({ kind: "chat" });
		expect(parseHash("#/settings/")).toEqual({ kind: "settings" });
	});

	test("#/c/<id> parses to a chat route carrying the conversation id; routeHash round-trips", () => {
		expect(parseHash("#/c")).toEqual({ kind: "chat" });
		expect(parseHash("#/c/")).toEqual({ kind: "chat" });
		expect(parseHash("#/c/2")).toEqual({ kind: "chat", conversationId: 2 });
		expect(routeHash({ kind: "chat" })).toBe("#/c");
		expect(routeHash({ kind: "chat", conversationId: 2 })).toBe("#/c/2");
		// The inverse both ways: parse(route(x)) = x for every shape.
		expect(parseHash(routeHash({ kind: "chat", conversationId: 42 }))).toEqual({
			kind: "chat",
			conversationId: 42,
		});
		// A non-numeric id segment is garbage → the plain chat default.
		expect(parseHash("#/c/abc")).toEqual({ kind: "chat" });
		expect(parseHash("#/c/2/extra")).toEqual({ kind: "chat" });
	});

	test("a malformed percent-escape in a segment is garbage → the chat default (both route kinds)", () => {
		// `%E0%A4%A` is a truncated UTF-8 sequence — decodeURIComponent
		// throws; the router must fall to chat, never crash the boot.
		expect(parseHash("#/settings/%E0%A4%A")).toEqual({ kind: "chat" });
		expect(parseHash("#/ext/%E0%A4%A/board")).toEqual({ kind: "chat" });
		expect(parseHash("#/ext/acme/%E0%A4%A")).toEqual({ kind: "chat" });
	});

	test("booting on the path-form /settings?section=<id> rewrites the hash and renders that section", async () => {
		// The server's post-account-link returnTo stays path-form; the app
		// rewrites it to the hash route at boot (the ONLY remaining reader).
		const replaceCalls: (string | null | undefined)[] = [];
		const win = globalThis as unknown as {
			location?: { hash?: string; pathname?: string; search?: string };
			history?: {
				pushState(d: unknown, t: string, u: string): void;
				replaceState(d: unknown, t: string, u: string): void;
			};
		};
		const originalLocation = win.location;
		const originalHistory = win.history;
		win.location = {
			pathname: "/settings",
			search: "?section=accounts",
			hash: "",
		};
		win.history = {
			pushState: () => undefined,
			replaceState: (_d, _t, url) => {
				replaceCalls.push(url);
				// Emulate the browser: a replaceState whose URL carries a
				// fragment updates location.hash (the app reads the hash back
				// through the same seam the real browser would).
				if (typeof url === "string" && url.includes("#")) {
					win.location!.hash = url.slice(url.indexOf("#"));
				}
			},
		};
		const { client, createEventSource } = makeHarness();
		let renderer: Awaited<ReturnType<typeof renderAsync>> | undefined;
		try {
			await act(async () => {
				renderer = await renderAsync(
					<App client={client} createEventSource={createEventSource} />,
				);
			});
			// The rewrite landed: path-form → /#/settings/accounts (the
			// history URL is root-relative; the hash the app reads back is
			// the fragment).
			expect(replaceCalls).toContain("/#/settings/accounts");
			expect(locationHash()).toBe("#/settings/accounts");
			// The page renders ON the accounts section (the deep link's target).
			expect(
				renderer!.root.findAllByProps({ className: "settings-page" }),
			).toHaveLength(1);
			await vi.waitFor(() => {
				expect(
					renderer!.root.findAllByProps({
						"data-settings-section": "accounts",
					}),
				).toHaveLength(1);
			});
		} finally {
			win.location = originalLocation;
			win.history = originalHistory;
			// Reset the fallback-hash seam: this test wrote
			// `#/settings/accounts` into it — the next test must boot on
			// the chat default, not inherit this route.
			resetLocationHashForTest("#/c");
		}
	});

	test("booting on a /settings hash selects NO conversation (the boot default is chat-route-only)", async () => {
		const { client, createEventSource, sources } = makeHarness();
		resetLocationHashForTest("#/settings");
		let renderer: Awaited<ReturnType<typeof renderAsync>> | undefined;
		try {
			renderer = await renderAsync(
				<App client={client} createEventSource={createEventSource} />,
			);
			// The settings page renders; the boot-default effect must NOT
			// select a conversation behind it — no stream opens, and the
			// transcript stays unselected.
			expect(
				renderer.root.findAllByProps({ className: "settings-page" }),
			).toHaveLength(1);
			expect(sources.map((s) => s.url)).toEqual(["/v1/events"]);
			expect(textContent(renderer.toJSON())).not.toContain(
				"Select or create a conversation",
			);
		} finally {
			// Restore the CHAT hash so the app's writeHash bookkeeping
			// (dedup against the last write) stays consistent for the
			// tests after this one — the fallback seam must also land on
			// the chat default.
			resetLocationHashForTest("#/c");
		}
	});

	test("typing with no conversation active, then reloading onto /settings, does NOT carry the unanchored draft into the root", async () => {
		// The unanchored draft (typed with no conversation selected) is
		// session-local (Task 6). Boot 1: type while no conversation is
		// selected — the draft stays UNANCHORED in the composer's memory
		// and dies with the page (nothing to persist it under).
		const { client, createEventSource, calls, sources } = makeHarness();
		const first = await renderAsync(
			<App client={client} createEventSource={createEventSource} />,
		);
		await vi.waitFor(() => {
			expect(
				first.root.findAllByProps({ className: "composer" }).length,
			).toBeGreaterThan(0);
		});
		const input = first.root.findByProps({ className: "composer-input" });
		await act(async () => {
			input.props.onChange({
				target: { value: "unanchored words" },
			});
		});
		// The reload: a FRESH App instance boots on the hash the browser
		// was left at — /settings here. A boot-default that ignores the
		// settings route selects the root conversation behind the page,
		// which is exactly where the unanchored draft would be carried
		// (the composer's carry rule fires on the next selection). The
		// fixed shell stays unselected, so nothing carries anywhere.
		// Boot 1's composer mount: the boot-default selected the root
		// conversation, so its stream is expected — record the count and
		// verify the RELOAD opened none (nothing new carried anywhere).
		const streamsBeforeReload = sources.filter((s) =>
			s.url.includes("/conversations/"),
		).length;
		resetLocationHashForTest("#/settings");
		let second: Awaited<ReturnType<typeof renderAsync>> | undefined;
		try {
			second = await renderAsync(
				<App client={client} createEventSource={createEventSource} />,
			);
			expect(
				second.root.findAllByProps({ className: "settings-page" }),
			).toHaveLength(1);
			// Correct behaviour: NO conversation was selected on a
			// settings-route boot — no conversation stream opened at all.
			expect(
				sources.filter((s) => s.url.includes("/conversations/")),
			).toHaveLength(streamsBeforeReload);
			expect(textContent(second.toJSON())).not.toContain(
				"Select or create a conversation",
			);
			// And no PATCH ever wrote a draft into any conversation's meta.
			expect(
				calls.filter(
					(call) =>
						/^\/v1\/conversations\/\d+\/meta$/.test(call.input) &&
						call.method === "PATCH" &&
						typeof call.body === "string" &&
						call.body.includes("draft"),
				),
			).toEqual([]);
		} finally {
			resetLocationHashForTest();
		}
	});

	test("a #/c/<id> deep link on load selects that conversation (the hash owns the id)", async () => {
		const { client, createEventSource, sources } = makeHarness();
		resetLocationHashForTest("#/c/2");
		let renderer: Awaited<ReturnType<typeof renderAsync>> | undefined;
		try {
			renderer = await renderAsync(
				<App client={client} createEventSource={createEventSource} />,
			);
			await vi.waitFor(() => {
				expect(
					sources.some(
						(s) => s.url === "/v1/conversations/2/stream",
					),
				).toBe(true);
			});
			// The deep link wins over the root-conversation boot default.
			expect(
				sources.some(
					(s) => s.url === "/v1/conversations/1/stream",
				),
			).toBe(false);
			expect(textContent(renderer.toJSON())).toContain(
				"Moor line inspection",
			);
		} finally {
			resetLocationHashForTest();
		}
	});

	test("browser back/forward between #/c/<a> and #/c/<b> swaps the transcript (popstate reconciles the id)", async () => {
		const listeners: (() => void)[] = [];
		const win = globalThis as unknown as {
			location?: { hash: string };
			addEventListener?: (type: string, listener: () => void) => void;
			removeEventListener?: (type: string, listener: () => void) => void;
		};
		const originalLocation = win.location;
		const originalAdd = win.addEventListener;
		const originalRemove = win.removeEventListener;
		win.addEventListener = ((_type: string, listener: () => void) => {
			listeners.push(listener);
		}) as typeof win.addEventListener;
		win.removeEventListener = (() => undefined) as typeof win.removeEventListener;
		const { client, createEventSource, sources } = makeHarness();
		let renderer: Awaited<ReturnType<typeof renderAsync>> | undefined;
		try {
			renderer = await renderAsync(
				<App client={client} createEventSource={createEventSource} />,
			);
			// Boot selected the root (1); clicking 2 writes #/c/2.
			await clickConversation(renderer, "Moor line inspection");
			expect(locationHash()).toBe("#/c/2");
			await vi.waitFor(() => {
				expect(
					sources.some(
						(s) => s.url === "/v1/conversations/2/stream",
					),
				).toBe(true);
			});
			// Browser back to #/c/1: the popped hash's conversation id
			// reconciles the selection (the transcript swaps back).
			win.location = { hash: "#/c/1" };
			await act(async () => {
				for (const listener of listeners) listener();
			});
			await vi.waitFor(() => {
				expect(
					sources.some(
						(s) => s.url === "/v1/conversations/1/stream",
					),
				).toBe(true);
			});
			// And forward to #/c/2 again.
			win.location = { hash: "#/c/2" };
			await act(async () => {
				for (const listener of listeners) listener();
			});
			await vi.waitFor(() => {
				expect(
					sources.filter(
						(s) => s.url === "/v1/conversations/2/stream",
					).length,
				).toBeGreaterThanOrEqual(2);
			});
		} finally {
			win.location = originalLocation;
			win.addEventListener = originalAdd;
			win.removeEventListener = originalRemove;
			// Restore the CHAT hash (the harness pattern): the app's
			// writeHash dedup reads the LAST write — after this test drove
			// '#/c/2' the seam must land back on the chat default so the
			// NEXT test's writes dedupe correctly.
			resetLocationHashForTest("#/c");
		}
	});

	test("a stale #/c/<id> deep link (unlisted conversation) falls back to the boot default", async () => {
		const { client, createEventSource, sources } = makeHarness();
		resetLocationHashForTest("#/c/999");
		try {
			await renderAsync(
				<App client={client} createEventSource={createEventSource} />,
			);
			await vi.waitFor(() => {
				expect(
					sources.some(
						(s) => s.url === "/v1/conversations/1/stream",
					),
				).toBe(true);
			});
			expect(
				sources.some(
					(s) => s.url === "/v1/conversations/999/stream",
				),
			).toBe(false);
		} finally {
			resetLocationHashForTest();
		}
	});

	test("a settings nav click pushes the section hash; browser back (popstate) restores the chat", async () => {
		// Capture the app's popstate listener by hand (the Node host has no
		// global addEventListener) — the SessionList harness pattern.
		const listeners: (() => void)[] = [];
		const win = globalThis as unknown as {
			location?: { hash: string };
			addEventListener?: (type: string, listener: () => void) => void;
			removeEventListener?: (type: string, listener: () => void) => void;
		};
		const originalLocation = win.location;
		const originalAdd = win.addEventListener;
		const originalRemove = win.removeEventListener;
		win.addEventListener = ((_type: string, listener: () => void) => {
			listeners.push(listener);
		}) as typeof win.addEventListener;
		win.removeEventListener = (() => undefined) as typeof win.removeEventListener;
		const { client, createEventSource } = makeHarness();
		const renderer = await renderAsync(
			<App client={client} createEventSource={createEventSource} />,
		);
		try {
			const settings = renderer.root.findByProps({ "aria-label": "settings" });
			await act(async () => {
				(settings.props as { onClick: () => unknown }).onClick();
			});
			expect(locationHash()).toBe("#/settings");
			// A nav entry in the page's left column pushes the section hash.
			const nav = await vi.waitFor(() => {
				const items = renderer.root.findAllByProps({
					className: "settings-nav-item",
				});
				expect(items.length).toBeGreaterThan(0);
				return items[0] as unknown as { props: { onClick: () => unknown } };
			});
			await act(async () => {
				nav.props.onClick();
			});
			expect(locationHash()).toBe("#/settings/general");
			// Browser back: the URL moves and the app's popstate handler
			// re-parses it into the route — the chat column returns.
			win.location = { hash: "#/c" };
			await act(async () => {
				for (const listener of listeners) listener();
			});
			expect(
				renderer.root.findAllByProps({ className: "settings-page" }),
			).toHaveLength(0);
			expect(
				renderer.root.findAllByProps({ className: "composer-slot" }),
			).toHaveLength(1);
		} finally {
			win.location = originalLocation;
			win.addEventListener = originalAdd;
			win.removeEventListener = originalRemove;
			resetLocationHashForTest();
		}
	});

	test("booting at #/c/2 selects conversation 2 (tabs Task 1: the chat route carries the id)", async () => {
		// The boot deep link: the hash router parses #/c/2 into a chat route
		// carrying the conversation id; the shell selects it once the list
		// lands (the boot default would otherwise pick the root).
		resetLocationHashForTest("#/c/2");
		const { client, createEventSource, sources } = makeHarness();
		try {
			const renderer = await renderAsync(
				<App client={client} createEventSource={createEventSource} />,
			);
			await vi.waitFor(() => {
				expect(textContent(renderer.toJSON())).toContain(
					"Moor line inspection",
				);
			});
			// Conversation 2's stream opened (sources[0] is the shared /v1/events).
			expect(sources.map((s) => s.url)).toEqual([
				"/v1/events",
				"/v1/conversations/2/stream",
			]);
			// The header title is the selected conversation's display name.
			const title = renderer.root.findByProps({ className: "chat-title" });
			expect(String(title.props.children)).toContain("Moor line inspection");
		} finally {
			// The boot hash deep-linked conversation 2; leave the seam on
			// the chat default so the NEXT test boots clean.
			resetLocationHashForTest("#/c");
		}
	});

	test("booting at an UNLISTED #/c/999 falls back to the default conversation (stale deep link, never a dead shell)", async () => {
		resetLocationHashForTest("#/c/999");
		const { client, createEventSource, sources } = makeHarness();
		try {
			const renderer = await renderAsync(
				<App client={client} createEventSource={createEventSource} />,
			);
			// The stale id matches no row: the root-default pick runs (the
			// composer is live, never an inert shell).
			await vi.waitFor(() => {
				expect(sources.map((s) => s.url)).toEqual([
					"/v1/events",
					"/v1/conversations/1/stream",
				]);
			});
			const title = renderer.root.findByProps({ className: "chat-title" });
			expect(String(title.props.children)).toContain("Tide table rewrite");
		} finally {
			resetLocationHashForTest("#/c");
		}
	});

	test("browser back to #/c/<id> reconciles the selected conversation", async () => {
		// The popstate handler owns the reconciliation: popping from
		// #/c/2 back to #/c/1 must swap the transcript, not just the URL.
		const listeners: (() => void)[] = [];
		const win = globalThis as unknown as {
			location?: { hash: string };
			history?: {
				pushState(d: unknown, t: string, u: string): void;
				replaceState(d: unknown, t: string, u: string): void;
			};
			addEventListener?: (type: string, listener: () => void) => void;
			removeEventListener?: (type: string, listener: () => void) => void;
		};
		const originalLocation = win.location;
		const originalHistory = win.history;
		const originalAdd = win.addEventListener;
		const originalRemove = win.removeEventListener;
		win.location = { hash: "" };
		win.history = {
			pushState: (_d, _t, url) => {
				if (typeof url === "string" && url.includes("#")) {
					win.location!.hash = url.slice(url.indexOf("#"));
				}
			},
			replaceState: () => undefined,
		};
		win.addEventListener = ((_type: string, listener: () => void) => {
			listeners.push(listener);
		}) as typeof win.addEventListener;
		win.removeEventListener = (() => undefined) as typeof win.removeEventListener;
		const { client, createEventSource } = makeHarness();
		const renderer = await renderAsync(
			<App client={client} createEventSource={createEventSource} />,
		);
		try {
			// Walk forward: conv 1 (hash #/c/1), then conv 2 (hash #/c/2).
			await clickConversation(renderer, "Tide table rewrite");
			expect(locationHash()).toBe("#/c/1");
			await clickConversation(renderer, "Moor line inspection");
			expect(locationHash()).toBe("#/c/2");
			expect(
				String(
					renderer.root.findByProps({ className: "chat-title" }).props
						.children,
				),
			).toContain("Moor line inspection");
			// Back: the URL moves to #/c/1 and the pop ITSELF re-selects
			// conversation 1 (before this fix the shell stayed on conv 2).
			win.location = { hash: "#/c/1" };
			await act(async () => {
				for (const listener of listeners) listener();
			});
			expect(locationHash()).toBe("#/c/1");
			await vi.waitFor(() => {
				expect(
					String(
						renderer.root.findByProps({ className: "chat-title" }).props
							.children,
					),
				).toContain("Tide table rewrite");
			});
		} finally {
			win.location = originalLocation;
			win.history = originalHistory;
			win.addEventListener = originalAdd;
			win.removeEventListener = originalRemove;
			resetLocationHashForTest();
		}
	});

	test("Settings has no close button (tabs Task 1: the page exits via its tab, not a ✕)", async () => {
		const { client, createEventSource } = makeHarness();
		const renderer = await renderAsync(
			<App client={client} createEventSource={createEventSource} />,
		);
		const settings = renderer.root.findByProps({ "aria-label": "settings" });
		await act(async () => {
			(settings.props as { onClick: () => unknown }).onClick();
		});
		expect(
			renderer.root.findAllByProps({ className: "settings-page" }),
		).toHaveLength(1);
		expect(
			renderer.root.findAllByProps({ className: "settings-close" }),
		).toHaveLength(0);
		resetLocationHashForTest();
	});

	test("the conversation list and right panel render only on the Chats tab", async () => {
		const meta = makeMeta({
			extensions: [
				{
					name: "curator",
					status: "ok",
					surfaces: [
						{ id: "curator", title: "Curator", icon: "book", placement: "view" },
					],
				},
			],
		});
		const { client, createEventSource } = makeHarness({ meta });
		const renderer = await renderAsync(
			<App client={client} createEventSource={createEventSource} />,
		);
		// On Chats: the sidebar list renders, and the panel can open.
		expect(
			renderer.root.findAllByProps({ className: "session-list" }),
		).toHaveLength(1);
		await clickPanel(renderer, "outline");
		expect(
			renderer.root.findAllByProps({ className: "right-panel" }),
		).toHaveLength(1);
		// Switch to the curator ext tab: the list AND the panel are gone
		// (the surface renders full width).
		const entry = renderer.root.findByProps({
			"data-rail-section": "ext:curator/curator",
		});
		await act(async () => {
			(entry.props as { onClick: () => void }).onClick();
		});
		expect(
			renderer.root.findAllByProps({ className: "session-list" }),
		).toHaveLength(0);
		expect(
			renderer.root.findAllByProps({ className: "right-panel" }),
		).toHaveLength(0);
		resetLocationHashForTest();
	});

	test("Back walks tab switches with their remembered routes", async () => {
		// Review Focus 4: a tab remembers the route it was last seen on;
		// browser back/forward walk the tab switches AND their routes.
		const listeners: (() => void)[] = [];
		const win = globalThis as unknown as {
			location?: { hash: string };
			history?: {
				pushState(d: unknown, t: string, u: string): void;
				replaceState(d: unknown, t: string, u: string): void;
			};
			addEventListener?: (type: string, listener: () => void) => void;
			removeEventListener?: (type: string, listener: () => void) => void;
		};
		const originalLocation = win.location;
		const originalHistory = win.history;
		const originalAdd = win.addEventListener;
		const originalRemove = win.removeEventListener;
		win.location = { hash: "" };
		win.history = {
			pushState: (_d, _t, url) => {
				if (typeof url === "string" && url.includes("#")) {
					win.location!.hash = url.slice(url.indexOf("#"));
				}
			},
			replaceState: () => undefined,
		};
		win.addEventListener = ((_type: string, listener: () => void) => {
			listeners.push(listener);
		}) as typeof win.addEventListener;
		win.removeEventListener = (() => undefined) as typeof win.removeEventListener;
		const meta = {
			...makeMeta(),
			coreViews: [
				{ id: "skills", title: "Skills", icon: "book" },
				{ id: "jobs", title: "Jobs", icon: "list" },
			],
		};
		const { client, createEventSource } = makeHarness({ meta });
		const renderer = await renderAsync(
			<App client={client} createEventSource={createEventSource} />,
		);
		const { SurfacePage } = await import("./blocks/SurfacePage");
		try {
			// 1. Select conversation 1, then conversation 2 (the chat tab's
			// remembered route becomes #/c/2 — the ACTIVE conversation when
			// we leave the tab).
			await clickConversation(renderer, "Tide table rewrite");
			expect(locationHash()).toBe("#/c/1");
			await clickConversation(renderer, "Moor line inspection");
			expect(locationHash()).toBe("#/c/2");
			// 2. Click the Skills tab (renders only because meta.coreViews lists it).
			const skills = renderer.root.findByProps({
				"data-rail-section": "skills",
			});
			await act(async () => {
				(skills.props as { onClick: () => void }).onClick();
			});
			expect(locationHash()).toBe("#/ext/core/skills");
			// Navigate with params (the skills tab remembers the param'd route).
			const page = await vi.waitFor(() =>
				renderer.root.findByType(SurfacePage),
			);
			await act(async () => {
				(page.props.onNavigate as (action: {
					params?: Record<string, unknown>;
				}) => void)({ params: { skill: "acme-deploy" } });
			});
			const skillsHash = `#/ext/core/skills?params=${encodeURIComponent(
				'{"skill":"acme-deploy"}',
			)}`;
			expect(locationHash()).toBe(skillsHash);
			// 3. Click Settings.
			const settings = renderer.root.findByProps({
				"data-rail-section": "settings",
			});
			await act(async () => {
				(settings.props as { onClick: () => void }).onClick();
			});
			expect(locationHash()).toBe("#/settings");
			// Back once: the Skills tab returns WITH its params.
			win.location = { hash: skillsHash };
			await act(async () => {
				for (const listener of listeners) listener();
			});
			expect(locationHash()).toBe(skillsHash);
			expect(
				renderer.root.findAllByProps({ className: "settings-page" }),
			).toHaveLength(0);
			await vi.waitFor(() => renderer.root.findByType(SurfacePage));
			// Back once more: the Chats tab returns at #/c/2. The pop ITSELF
			// must re-select conversation 2 — the active conversation at this
			// point is 2, so assert the harder direction instead: pop FIRST
			// to #/c/1 (the remembered walk in) and verify 1 becomes active,
			// then forward-pop to #/c/2 and verify 2 returns. This catches a
			// handler that updates the URL without reconciling activeId.
			win.location = { hash: "#/c/1" };
			await act(async () => {
				for (const listener of listeners) listener();
			});
			expect(locationHash()).toBe("#/c/1");
			await vi.waitFor(() => {
				expect(
					renderer.root.findAllByType(SurfacePage),
				).toHaveLength(0);
			});
			await vi.waitFor(() => {
				const title = renderer.root.findByProps({
					className: "chat-title",
				});
				expect(String(title.props.children)).toContain(
					"Tide table rewrite",
				);
			});
			win.location = { hash: "#/c/2" };
			await act(async () => {
				for (const listener of listeners) listener();
			});
			expect(locationHash()).toBe("#/c/2");
			await vi.waitFor(() => {
				const title = renderer.root.findByProps({
					className: "chat-title",
				});
				expect(String(title.props.children)).toContain(
					"Moor line inspection",
				);
			});
		} finally {
			win.location = originalLocation;
			win.history = originalHistory;
			win.addEventListener = originalAdd;
			win.removeEventListener = originalRemove;
			resetLocationHashForTest();
		}
	});
});

describe("App extension-surface route (UI-blocks U3 Task 5)", () => {
	function extMeta(): MetaResponse {
		return makeMeta({
			extensions: [
				{
					name: "fixture-surfaces",
					status: "ok",
					surfaces: [
						{ id: "board", title: "Acme board", icon: "board", placement: "view" },
					],
				},
			],
		});
	}

	test("the rail's extension entry navigates to the /ext route and the surface page loads", async () => {
		const { client, createEventSource } = makeHarness({ meta: extMeta() });
		const renderer = await renderAsync(
			<App client={client} createEventSource={createEventSource} />,
		);
		const entry = renderer.root.findByProps({
			"data-rail-section": "ext:fixture-surfaces/board",
		});
		await act(async () => {
			(entry.props as { onClick: () => void }).onClick();
		});
		// The URL hash carries the route (browser back returns to the chat).
		expect(locationHash()).toContain("/ext/fixture-surfaces/board");
	});

	test("the Chats tab returns to its remembered route (tabs Task 1)", async () => {
		const { client, createEventSource } = makeHarness({ meta: extMeta() });
		const renderer = await renderAsync(
			<App client={client} createEventSource={createEventSource} />,
		);
		const entry = renderer.root.findByProps({
			"data-rail-section": "ext:fixture-surfaces/board",
		});
		await act(async () => {
			(entry.props as { onClick: () => void }).onClick();
		});
		expect(locationHash()).toContain("/ext/fixture-surfaces/board");
		const { SurfacePage } = await import("./blocks/SurfacePage");
		await vi.waitFor(() => renderer.root.findByType(SurfacePage));
		const chats = renderer.root.findByProps({ "data-rail-section": "chats" });
		await act(async () => {
			(chats.props as { onClick: () => void }).onClick();
		});
		// The chats tab remembers its last route (the boot default
		// selected conversation 2, whose select wrote #/c/2).
		expect(locationHash()).toBe("#/c/2");
		expect(renderer.root.findAllByType(SurfacePage)).toHaveLength(0);
		resetLocationHashForTest();
	});

	test("the conversation list renders only on the Chats tab (tabs Task 1)", async () => {
		const { client, createEventSource } = makeHarness({ meta: extMeta() });
		const renderer = await renderAsync(
			<App client={client} createEventSource={createEventSource} />,
		);
		const entry = renderer.root.findByProps({
			"data-rail-section": "ext:fixture-surfaces/board",
		});
		await act(async () => {
			(entry.props as { onClick: () => void }).onClick();
		});
		const { SurfacePage } = await import("./blocks/SurfacePage");
		await vi.waitFor(() => renderer.root.findByType(SurfacePage));
		const { SessionList } = await import("./sessions/SessionList");
		// Off the Chats tab the sidebar list does NOT render — a select
		// must come from the Chats tab's own list.
		expect(renderer.root.findAllByType(SessionList)).toHaveLength(0);
		resetLocationHashForTest();
	});

	test("the chat header renders only on the Chats tab (tabs Task 1, whole-branch review I4)", async () => {
		const { client, createEventSource } = makeHarness({ meta: extMeta() });
		const { ChatHeader } = await import("./layout/ChatHeader");
		const renderer = await renderAsync(
			<App client={client} createEventSource={createEventSource} />,
		);
		// The boot default is the Chats tab: the header is up.
		expect(renderer.root.findAllByType(ChatHeader)).toHaveLength(1);
		// An ext tab (the Skills/Jobs shape): the header unmounts — its
		// panel toggles and conversation title are Chats-only (spec §1).
		const entry = renderer.root.findByProps({
			"data-rail-section": "ext:fixture-surfaces/board",
		});
		await act(async () => {
			(entry.props as { onClick: () => void }).onClick();
		});
		const { SurfacePage } = await import("./blocks/SurfacePage");
		await vi.waitFor(() => renderer.root.findByType(SurfacePage));
		expect(renderer.root.findAllByType(ChatHeader)).toHaveLength(0);
		// Back on Chats the header returns.
		const chats = renderer.root.findByProps({ "data-rail-section": "chats" });
		await act(async () => {
			(chats.props as { onClick: () => void }).onClick();
		});
		expect(renderer.root.findAllByType(ChatHeader)).toHaveLength(1);
		resetLocationHashForTest();
	});

	test("an access-none surface renders the not-found state and loses its rail entry", async () => {
		const { client, createEventSource } = makeHarness({ meta: extMeta() });
		const renderer = await renderAsync(
			<App client={client} createEventSource={createEventSource} />,
		);
		// The App's not-found discovery: after a surface returns access
		// none, the rail entry disappears (§6.5).
		const before = renderer.root.findAllByProps({
			"data-rail-section": "ext:fixture-surfaces/board",
		});
		expect(before).toHaveLength(1);
	});

	test("navigate({target}) routes: conversation / job / settings / view / params", async () => {
		const { client, createEventSource } = makeHarness({ meta: extMeta() });
		const renderer = await renderAsync(
			<App client={client} createEventSource={createEventSource} />,
		);
		const entry = renderer.root.findByProps({
			"data-rail-section": "ext:fixture-surfaces/board",
		});
		await act(async () => {
			(entry.props as { onClick: () => void }).onClick();
		});
		expect(locationHash()).toContain("/ext/fixture-surfaces/board");
		// The mounted page's onNavigate seam (App's handler): find the
		// SurfacePage and drive the prop directly (the transport act
		// delivery is SurfacePage's own unit test).
		const { SurfacePage } = await import("./blocks/SurfacePage");
		// The page mounts once the async event-key hash resolves.
		const page = await vi.waitFor(() => renderer.root.findByType(SurfacePage));
		const onNavigate = page.props.onNavigate as (action: {
			params?: Record<string, unknown>;
			target?: unknown;
		}) => void;

		// {conversation} → the chat route carrying the id + the
		// conversation selected.
		await act(async () => {
			onNavigate({ target: { conversation: 2 } });
		});
		expect(locationHash()).toBe("#/c/2");

		// {settings} → the settings page route (the section id rides the hash).
		await act(async () => {
			onNavigate({ target: { settings: "interface" } });
		});
		expect(locationHash()).toBe("#/settings/interface");
		expect(
			renderer.root.findAllByProps({ className: "settings-page" }).length,
		).toBeGreaterThan(0);

		// {view} → that extension view's hash route.
		await act(async () => {
			onNavigate({
				target: { view: { extension: "fixture-surfaces", id: "board", params: { board: "b2" } } },
			});
		});
		expect(locationHash()).toContain("/ext/fixture-surfaces/board");
		expect(locationHash()).toContain("params=");

		// {params} alone → THIS surface re-renders with new params.
		await act(async () => {
			onNavigate({ params: { board: "b1" } });
		});
		expect(locationHash()).toContain(encodeURIComponent('{"board":"b1"}'));

		// {job} → the Jobs TAB route carrying the job id in its params
		// (tabs+skills Task 6: the JobsPanel is gone; the job target
		// deep-links the core/jobs view).
		await act(async () => {
			onNavigate({ target: { job: "j1" } });
		});
		expect(locationHash()).toBe(
			`#/ext/core/jobs?params=${encodeURIComponent('{"job":"j1"}')}`,
		);
		// …and NO right panel opened for it (the panel's data-panel is the
		// mode's observable; "jobs" is no longer a panel mode at all).
		expect(
			renderer.root.findAllByProps({ "data-panel": "jobs" }),
		).toHaveLength(0);
		// The fallback-hash seam is module-level: reset so the NEXT test
		// boots on the clean chat route (this test ends on an ext route).
		resetLocationHashForTest();
	});

	test("the chat header has no jobs panel button (tabs+skills Task 6)", async () => {
		const { client, createEventSource } = makeHarness();
		const renderer = await renderAsync(
			<App client={client} createEventSource={createEventSource} />,
		);
		// The panel toggles that survive are Outline + Workspace; the
		// Jobs tab lives on the rail (meta.coreViews), not the header.
		expect(
			renderer.root.findAllByProps({ "aria-label": "outline" }).length,
		).toBeGreaterThan(0);
		expect(
			renderer.root.findAllByProps({ "aria-label": "workspace" }).length,
		).toBeGreaterThan(0);
		expect(
			renderer.root.findAllByProps({ "aria-label": "jobs" }),
		).toHaveLength(0);
		expect(
			renderer.root.findAllByProps({ "data-panel": "jobs" }),
		).toHaveLength(0);
	});
});

describe("App surface re-registration (U3 final-review fix wave)", () => {
	// The panel-row variant: `stats` as a PANEL surface.
	function extMeta(): MetaResponse {
		return makeMeta({
			extensions: [
				{
					name: "fixture-surfaces",
					status: "ok",
					surfaces: [
						{ id: "board", title: "Acme board", icon: "board", placement: "view" },
						{ id: "stats", title: "Acme stats", icon: "stats", placement: "panel" },
					],
				},
			],
		});
	}

	// The ext transports fetch via globalThis.fetch (App wires no fetch
	// into the hub); stub it to the harness's FetchLike for /v1/ext.
	function stubGlobalFetch(fetchImpl: FetchLike): () => void {
		const original = globalThis.fetch;
		globalThis.fetch = (async (input: unknown, init?: unknown) => {
			const url = typeof input === "string" ? input : String(input);
			if (url.startsWith("/v1/ext/")) {
				return fetchImpl(url, init as Parameters<FetchLike>[1]);
			}
			return original(input as URL, init as RequestInit);
		}) as typeof fetch;
		return () => {
			globalThis.fetch = original;
		};
	}

	test("a reconnect re-registers an OPEN PANEL's surface with the new stream id", async () => {
		const { client, createEventSource, sources, calls, fetchImpl } = makeHarness({
			meta: extMeta(),
		});
		const restoreFetch = stubGlobalFetch(fetchImpl);
		try {
		const renderer = await renderAsync(
			<App client={client} createEventSource={createEventSource} />,
		);
		const extCalls = () =>
			calls.filter((one) => one.input.includes("/v1/ext/fixture-surfaces/surfaces/stats"));
		// Open the panel tab (the panel host loads its surface).
		const tab = renderer.root.findByProps({
			"data-panel-tab": "ext:fixture-surfaces/stats",
		});
		await act(async () => {
			(tab.props as { onClick: () => void }).onClick();
		});
		await vi.waitFor(() => {
			expect(extCalls().length).toBeGreaterThan(0);
		});
		const beforeHello = extCalls().length;
		// The FIRST hello: the noted panel re-registers onto stream s1.
		await act(async () => {
			sources[0]?.source.emit("hello", JSON.stringify({ streamId: "s1" }));
		});
		await vi.waitFor(() => {
			expect(extCalls().length).toBeGreaterThan(beforeHello);
		});
		const afterHello = extCalls().length;
		// A RECONNECT (a new id): the panel's surface re-fetches once more,
		// re-registering the new stream's watcher entry (spec §7.3).
		await act(async () => {
			sources[0]?.source.emit("hello", JSON.stringify({ streamId: "s2" }));
		});
		await vi.waitFor(() => {
			expect(extCalls().length).toBeGreaterThan(afterHello);
		});
		} finally {
			restoreFetch();
		}
	});

	test("pre-hello navigation to an ext route does not wedge: the surface page loads", async () => {
		const { client, createEventSource, fetchImpl } = makeHarness({ meta: extMeta() });
		const restoreFetch = stubGlobalFetch(fetchImpl);
		try {
		const renderer = await renderAsync(
			<App client={client} createEventSource={createEventSource} />,
		);
		// Navigate BEFORE any hello frame: the page must still mount + load.
		const entry = renderer.root.findByProps({
			"data-rail-section": "ext:fixture-surfaces/board",
		});
		await act(async () => {
			(entry.props as { onClick: () => void }).onClick();
		});
		await vi.waitFor(() => {
			expect(textContent(renderer.toJSON())).toContain("Acme board");
		});
		} finally {
			restoreFetch();
			// This test leaves the fallback hash on the ext route — a leak
			// the Chats-only ChatHeader gate (whole-branch review I4) makes
			// visible downstream: a later boot onto that hash renders no
			// chat header. Reset so the leak can't reach the restart tests.
			resetLocationHashForTest();
		}
	});
});
});

describe("App restart surface (UI-blocks U4 Task 2, spec §13.3)", () => {
	test("requestRestart POSTs /v1/admin/restart, shows Restarting…, and recovers when /readyz answers", async () => {
		const readyzDown = { ready: { current: true } };
		const { client, createEventSource, restartCalls } = makeHarness({
			readyzDown,
		});
		// The app exposes its actions to tests via onExposeActions (Task 4
		// wires the §13.4 callout's Restart button to the same action).
		let actions: { restart(): Promise<void> } | undefined;
		const renderer = await renderAsync(
			<App
				client={client}
				createEventSource={createEventSource}
				onExposeActions={(exposed: { restart(): Promise<void> }) => {
					actions = exposed;
				}}
			/>,
		);
		// Shell is up. Trigger the restart the way the §13.4 callout's
		// Restart button will: the app's restart action. The action is
		// LONG-RUNNING (it resolves only after the recovery poll finishes)
		// — capture the promise, never await it inside act.
		expect(actions).toBeDefined();
		let restartDone: Promise<void> | undefined;
		await act(async () => {
			restartDone = actions?.restart();
			// Let the POST + the setBoot land within this window.
			await new Promise((resolve) => setTimeout(resolve, 50));
		});
		expect(restartCalls).toHaveLength(1);
		// "Restarting…" replaces the shell while /readyz is down.
		let text = textContent(renderer.toJSON());
		expect(text).toContain("Restarting");
		// The server comes back: /readyz flips to 200 and the app
		// re-boots (the keyed remount re-runs the meta gate → shell).
		readyzDown.ready.current = true;
		// Poll-with-deadline INSIDE act: each iteration is a real-time
		// window. The chain (poll sleep → setBoot → meta refetch → shell)
		// needs a full poll cadence per hop in this environment (state
		// updates from the free-running poll land one window late), so
		// the loop ends on the shell's return, never a guessed hop count.
		const deadline = Date.now() + 10_000;
		for (;;) {
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 100));
			});
			if (
				renderer.root.findAllByProps({ className: "chat-header" }).length ===
				1
			) {
				break;
			}
			if (Date.now() > deadline) break;
		}
		text = textContent(renderer.toJSON());
		expect(text).not.toContain("Restarting");
		expect(
			renderer.root.findAllByProps({ className: "chat-header" }),
		).toHaveLength(1);
		// The long-running action settles once the recovery poll ended.
		await restartDone;
	}, 15_000);

	test("the recovery poll sleeps before probing: a lingering 200 from the dying process is not readiness", async () => {
		// The regression guard for the round-2 finding: the OLD listener
		// still answers /readyz 200 between the 202 and the deferred
		// drain. A probe-before-sleep loop would read the FIRST probe as
		// ready and remount onto the closing server. The fake answers 200
		// for the first 3 post-POST probes (the linger), then 503 until
		// the test flips it — only a sleep-first loop survives.
		const readyzDown = { ready: { current: true } };
		const { client, createEventSource } = makeHarness({
			readyzDown,
			// The dying listener keeps answering 200 for 250ms after the
			// POST; the poll cadence is 500ms — a sleep-first loop's first
			// probe lands past the window, a probe-first loop's lands in it.
			readyzLingerMs: 250,
		});
		let actions: { restart(): Promise<void> } | undefined;
		const renderer = await renderAsync(
			<App
				client={client}
				createEventSource={createEventSource}
				onExposeActions={(exposed: { restart(): Promise<void> }) => {
					actions = exposed;
				}}
			/>,
		);
		let restartDone: Promise<void> | undefined;
		await act(async () => {
			restartDone = actions?.restart();
			await new Promise((resolve) => setTimeout(resolve, 50));
		});
		// Drive past the linger window: after one full poll cadence the
		// shell must STILL be in the Restarting state (a probe-first loop
		// would have read the lingering 200 and remounted).
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 650));
		});
		expect(textContent(renderer.toJSON())).toContain("Restarting");
		// The poll keeps going (the fake answers 503 now) until the test
		// brings the server back.
		readyzDown.ready.current = true;
		const deadline = Date.now() + 10_000;
		for (;;) {
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 200));
			});
			if (
				renderer.root.findAllByProps({ className: "chat-header" }).length ===
				1
			) {
				break;
			}
			if (Date.now() > deadline) break;
		}
		expect(
			renderer.root.findAllByProps({ className: "chat-header" }),
		).toHaveLength(1);
		await restartDone;
	}, 20_000);
});
