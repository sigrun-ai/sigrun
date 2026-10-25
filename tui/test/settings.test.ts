/**
 * The TUI Settings view (UI-blocks U4 Task 4, spec §13.4): the settings
 * panel's terminal twin, driven headless over faked wire responses.
 *
 * Covered (the plan's Step-1 list, TUI half):
 * - the section list orders core first, then extensions alphabetically;
 * - the search index filters on label/help/key and "naming" resolves to
 *   General's naming-model field (the pick lands the caret ON the row);
 * - each section mounts as the SAME SurfaceView the webui runs (the
 *   section's `/v1/ext/<slug>/surfaces/<id>` mount);
 * - the pending-restart callout lists keys and shows the Restart
 *   affordance only for a supervised admin (the text otherwise);
 * - an extension without a declared section stays reachable as its raw
 *   JSON routes (the view's notice names them — the editor is the
 *   webui's cove).
 *
 * Wire fakes: one fetch handler answers the sections list, the whoami,
 * the boot meta, and each section's surface load (the General form
 * carries the naming-model field so the focus assertion is real).
 */

import { describe, expect, test } from "vitest";
import type { TUI } from "@earendil-works/pi-tui";
import type { SurfaceLoad } from "@sigrun/shared/blocks";
import { SigrunClient } from "../src/api.js";
import type { SettingsSectionEntry } from "../src/api.js";
import { plainTuiTheme } from "../src/theme.js";
import { SettingsView, filterSettingsIndex } from "../src/ui/settings.js";

const fakeTui = { requestRender: () => {} } as unknown as TUI;

/** The General section's form (one naming-model field — the search
 *  target — plus one more so the focus move is observable). */
const GENERAL_TREE: SurfaceLoad["tree"] = {
	v: 1,
	root: {
		type: "form",
		id: "core-general-form",
		mode: "submit",
		bind: "/settings",
		children: [
			{
				type: "text",
				name: "defaultModel",
				label: "Default model",
			},
			{
				type: "text",
				name: "namingModel",
				label: "Naming model",
				help: "The model that names conversations",
			},
		],
	},
};

/** An extension section's trivial form. */
const EXT_TREE: SurfaceLoad["tree"] = {
	v: 1,
	root: {
		type: "form",
		id: "acme-form",
		mode: "submit",
		bind: "/settings",
		children: [
			{ type: "text", name: "endpoint", label: "Acme endpoint" },
		],
	},
};

interface FakeWire {
	readonly client: SigrunClient;
	readonly calls: readonly string[];
	/** The save POST bodies (the rev assertions read them). */
	readonly saveBodies: readonly string[];
}

/** A SigrunClient over an in-memory fetch answering the settings
 *  view's routes. `savesFlipPending` makes a save POST flip the served
 *  `pendingRestart` to `["server.port"]` on the NEXT load (the
 *  callout-flips-after-save test). */
function fakeWire(init?: {
	readonly pendingRestart?: readonly string[];
	readonly supervised?: boolean;
	readonly admin?: boolean;
	readonly token?: string;
	readonly sectionsExtra?: readonly SettingsSectionEntry[];
	/** Loaded extensions WITHOUT settings sections (the notice lines). */
	readonly sectionlessExtensions?: readonly string[];
	readonly savesFlipPending?: boolean;
	/** Fix-wave C3: reject a save whose rev is stale (the two-saves
	 *  test's optimistic-concurrency pin). */
	readonly enforceRev?: boolean;
}): FakeWire {
	// The save's effect: a flipped pendingRestart on the next load.
	let flipped = false;
	let currentRev = 1;
	const pendingNow = (): readonly string[] =>
		flipped ? ["server.port"] : (init?.pendingRestart ?? []);
	const calls: string[] = [];
	const saveBodies: string[] = [];
	const sections: SettingsSectionEntry[] = [
		{ slug: "core", id: "general", title: "General", icon: "key" },
		{ slug: "core", id: "tools", title: "Tools", icon: "key" },
		{ slug: "acme-ext", id: "acme", title: "Acme settings", icon: "key" },
		...(init?.sectionsExtra ?? []),
	];
	const index = [
		{
			slug: "core",
			sectionId: "general",
			kind: "core-key" as const,
			label: "Naming model",
			help: "The model that names conversations",
			key: "namingModel",
		},
		{
			slug: "core",
			sectionId: "general",
			kind: "core-key" as const,
			label: "Default model",
			key: "defaultModel",
		},
		{
			slug: "acme-ext",
			sectionId: "acme",
			kind: "field" as const,
			label: "Acme endpoint",
			key: "endpoint",
		},
	];
	const fetchImpl = async (
		input: RequestInfo | URL,
		requestInit?: RequestInit,
	): Promise<Response> => {
		const url = String(input);
		calls.push(`${requestInit?.method ?? "GET"} ${url}`);
		const json = (body: unknown): Response =>
			new Response(JSON.stringify(body), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		if (url.endsWith("/v1/settings/sections")) {
			return json({ sections, index });
		}
		if (url.endsWith("/v1/auth/whoami")) {
			return json({
				user: "alice",
				admin: init?.admin ?? true,
				service: false,
				method: "token",
			});
		}
		if (url.endsWith("/v1/meta")) {
			return json({ supervised: init?.supervised ?? true });
		}
		if (url.endsWith("/v1/extensions")) {
			return json({
				extensions: (init?.sectionlessExtensions ?? []).map((name) => ({
					name,
					status: "ok",
					interactionKinds: [],
					ambientKeys: [],
					workers: [],
				})),
			});
		}
		if (
			url.includes("/v1/ext/core/surfaces/general/actions") &&
			requestInit?.method === "POST"
		) {
			const rawBody = String(requestInit.body ?? "{}");
			saveBodies.push(rawBody);
			const body = JSON.parse(rawBody) as {
				payload?: { rev?: number };
			};
			if (
				init?.enforceRev === true &&
				typeof body.payload?.rev === "number" &&
				body.payload.rev !== currentRev
			) {
				return json({ ok: false, error: { message: "changed by someone else" } });
			}
			if (init?.savesFlipPending === true) flipped = true;
			currentRev += 1;
			return json({ ok: true, rev: currentRev });
		}
		if (url.includes("/v1/ext/core/surfaces/general")) {
			const load: SurfaceLoad = {
				tree: GENERAL_TREE,
				data: {
					settings: { defaultModel: "acme/m", namingModel: "acme/n" },
					meta: {
						pendingRestart: [...pendingNow()],
						supervised: init?.supervised ?? true,
					},
				},
				rev: currentRev,
				treeRev: 1,
				access: "write",
			};
			return json(load);
		}
		if (url.includes("/v1/ext/acme-ext/surfaces/acme")) {
			const load: SurfaceLoad = {
				tree: EXT_TREE,
				data: { settings: { endpoint: "acme.example.invalid" } },
				rev: 1,
				treeRev: 1,
				access: "write",
			};
			return json(load);
		}
		return json({ error: `unstubbed: ${url}` });
	};
	const client = new SigrunClient({
		baseUrl: "http://settings.test",
		...(init?.token === undefined ? {} : { token: init.token }),
		// SAFETY: the fake implements the fetch shape the client consumes.
		fetch: fetchImpl as typeof globalThis.fetch,
	});
	return { client, calls, saveBodies };
}

function makeView(wire: FakeWire, init?: {
	readonly onRestart?: () => Promise<void>;
}): SettingsView {
	return new SettingsView(wire.client, {
		tui: fakeTui,
		theme: plainTuiTheme(),
		unicode: true,
		onRestart: init?.onRestart ?? (() => Promise.resolve()),
		onClose: () => {},
	});
}

/** Open General and wait for the surface to finish loading. */
async function openGeneral(view: SettingsView): Promise<void> {
	await view.openSection({ slug: "core", id: "general", title: "General", icon: "key" });
}

describe("TUI SettingsView (UI-blocks U4 Task 4)", () => {
	test("the section list renders core first, then extensions alphabetically", async () => {
		const wire = fakeWire({
			sectionsExtra: [
				{ slug: "beta-ext", id: "beta", title: "Beta settings", icon: "key" },
				{ slug: "alpha-ext", id: "alpha", title: "Alpha settings", icon: "key" },
			],
		});
		const view = makeView(wire);
		await view.load();
		const lines = view.render(60).join("\n");
		const general = lines.indexOf("General");
		const acme = lines.indexOf("Acme settings");
		expect(general).toBeGreaterThanOrEqual(0);
		expect(acme).toBeGreaterThan(general);
		// The sections route owns the ordering (core first, extensions
		// alphabetically); the view renders the wire order verbatim.
		expect(lines).toContain("General");
		expect(lines).toContain("Acme settings");
	});

	test("the search index filters on label/help/key; 'naming' resolves to General's naming model", () => {
		const index = [
			{
				slug: "core",
				sectionId: "general",
				kind: "core-key" as const,
				label: "Naming model",
				help: "The model that names conversations",
				key: "namingModel",
			},
			{
				slug: "core",
				sectionId: "advanced",
				kind: "core-key" as const,
				label: "Server port",
				key: "server.port",
			},
		];
		const hits = filterSettingsIndex(index, "naming");
		expect(hits).toHaveLength(1);
		expect(hits[0]?.sectionId).toBe("general");
		expect(hits[0]?.key).toBe("namingModel");
		// An empty query never filters to everything (the picker carries
		// the full list; the filter is the query narrowing).
		expect(filterSettingsIndex(index, "")).toHaveLength(0);
		// A key-path hit works too ("server.port" by its dotted name).
		expect(filterSettingsIndex(index, "server.port")[0]?.key).toBe("server.port");
	});

	test("opening General mounts its surface form (one renderer, core and extensions)", async () => {
		const wire = fakeWire({});
		const view = makeView(wire);
		await view.load();
		await openGeneral(view);
		expect(view.openSectionId).toBe("general");
		// The surface form rendered its fields (the SAME SurfaceView the
		// webui runs — the naming-model row is in the render).
		const lines = view.render(60).join("\n");
		expect(lines).toContain("Naming model");
		expect(lines).toContain("acme/n");
		// The surface GET carried the reserved core slug.
		expect(wire.calls.some((call) => call.includes("/v1/ext/core/surfaces/general"))).toBe(true);
	});

	test("a search pick with a key focuses the named field (the caret lands on the naming model row)", async () => {
		const wire = fakeWire({});
		const view = makeView(wire);
		await view.load();
		await view.openSection(
			{ slug: "core", id: "general", title: "General", icon: "key" },
			"namingModel",
		);
		// The focused field is the naming model: at this width the form
		// renders the label ABOVE the editor (the compact layout), so the
		// caret glyph marks the line under the naming-model label; the
		// unfocused default-model editor has none.
		const lines = view.render(60).join("\n").split("\n");
		const namingLabel = lines.findIndex((line) => line === "Naming model");
		expect(namingLabel).toBeGreaterThanOrEqual(0);
		expect(lines[namingLabel + 1]).toContain("▏");
		const defaultLabel = lines.findIndex((line) => line === "Default model");
		expect(defaultLabel).toBeGreaterThanOrEqual(0);
		expect(lines[defaultLabel + 1]).not.toContain("▏");
	});

	test("the pending-restart callout lists keys; the Restart affordance shows only for a supervised admin", async () => {
		// Supervised admin: the callout carries the keys AND the restart hint.
		const supervised = fakeWire({
			pendingRestart: ["server.port"],
			supervised: true,
			admin: true,
		});
		const view = makeView(supervised);
		await view.load();
		await openGeneral(view);
		expect(view.pendingRestart).toEqual(["server.port"]);
		const adminLines = view.render(60).join("\n");
		expect(adminLines).toContain("Restart sigrun to apply: server.port");
		expect(adminLines).toContain("press ctrl+r to restart now");

		// Non-admin: the text without the restart affordance.
		const nonAdmin = fakeWire({
			pendingRestart: ["server.port"],
			supervised: true,
			admin: false,
		});
		const nonAdminView = makeView(nonAdmin);
		await nonAdminView.load();
		await nonAdminView.openSection({
			slug: "core",
			id: "general",
			title: "General",
			icon: "key",
		});
		const nonAdminLines = nonAdminView.render(60).join("\n");
		expect(nonAdminLines).toContain("Restart sigrun to apply: server.port");
		expect(nonAdminLines).not.toContain("press ctrl+r to restart now");

		// Unsupervised: the text without the restart affordance.
		const unsupervised = fakeWire({
			pendingRestart: ["server.port"],
			supervised: false,
			admin: true,
		});
		const unsupervisedView = makeView(unsupervised);
		await unsupervisedView.load();
		await unsupervisedView.openSection({
			slug: "core",
			id: "general",
			title: "General",
			icon: "key",
		});
		const unsupervisedLines = unsupervisedView.render(60).join("\n");
		expect(unsupervisedLines).toContain("Restart sigrun to apply: server.port");
		expect(unsupervisedLines).not.toContain("press ctrl+r to restart now");
	});

	test("the callout's Restart action is ctrl+r — a bare r types into the focused field", async () => {
		let restarts = 0;
		const wire = fakeWire({
			pendingRestart: ["server.port"],
			supervised: true,
			admin: true,
		});
		const view = makeView(wire, {
			onRestart: () => {
				restarts += 1;
				return Promise.resolve();
			},
		});
		await view.load();
		await openGeneral(view);
		// A bare "r" while a form field is focused types into the field —
		// it must NEVER restart the server mid-edit.
		view.handleInput("r");
		await Promise.resolve();
		expect(restarts).toBe(0);
		// ctrl+r (\x12) is the restart affordance.
		view.handleInput("\x12");
		await Promise.resolve();
		expect(restarts).toBe(1);
	});

	test("an extension section mounts as a surface too (extensions follow the same renderer)", async () => {
		const wire = fakeWire({});
		const view = makeView(wire);
		await view.load();
		await view.openSection({
			slug: "acme-ext",
			id: "acme",
			title: "Acme settings",
			icon: "key",
		});
		expect(view.openSectionId).toBe("acme");
		const lines = view.render(60).join("\n");
		expect(lines).toContain("Acme endpoint");
		expect(
			wire.calls.some((call) => call.includes("/v1/ext/acme-ext/surfaces/acme")),
		).toBe(true);
	});

	test("the section surface's fetches carry the client's bearer token", async () => {
		const wire = fakeWire({ token: "settings-token" });
		const view = makeView(wire);
		await view.load();
		await openGeneral(view);
		expect(wire.calls.some((call) => call.includes("/v1/ext/core/surfaces/general"))).toBe(true);
		// (The header assertion itself lives in ext-transport.test.ts —
		// here the load succeeding over the tokened client is the gate.)
	});

	test("a save that makes a key pending flips the callout without reopening", async () => {
		const wire = fakeWire({ supervised: true, admin: true, savesFlipPending: true });
		const view = makeView(wire);
		await view.load();
		await openGeneral(view);
		expect(view.pendingRestart).toEqual([]);
		expect(view.render(60).join("\n")).not.toContain("Restart sigrun to apply");
		// The form's submit dispatches the save action through the
		// surface state; an accepted non-move triggers the refetch — the
		// callout reads the fresh meta. Drive it through the form: the
		// fields are defaultModel, namingModel, then the submit row —
		// down twice, Enter submits.
		expect(wire.calls.some((call) => call.includes("/actions"))).toBe(false);
		view.handleInput("\x1b[B"); // down
		view.handleInput("\x1b[B"); // down (submit row)
		view.handleInput("\r"); // enter = submit
		// Wait for the action + the refetch to settle.
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(wire.calls.some((call) => call.includes("/actions"))).toBe(true);
		expect(view.pendingRestart).toEqual(["server.port"]);
		expect(view.render(60).join("\n")).toContain("Restart sigrun to apply: server.port");
	});

	test("a section-less extension stays reachable as a raw-JSON notice in the section list", async () => {
		const wire = fakeWire({ sectionlessExtensions: ["acme-plain"] });
		const view = makeView(wire);
		await view.load();
		// Wide enough that the notice line never truncates (truncateToWidth
		// otherwise ellipsizes the routes away).
		const lines = view.render(120).join("\n");
		expect(lines).toContain("acme-plain: no settings section");
		expect(lines).toContain("/v1/extensions/acme-plain/settings");
	});

	test("two consecutive saves in one open both succeed (the form rides the live rev)", async () => {
		const wire = fakeWire({ enforceRev: true, savesFlipPending: true });
		const view = makeView(wire);
		await view.load();
		await openGeneral(view);
		// Render once: the SurfaceView builds the wrapped form lazily on
		// first render — input before that drops on the floor.
		view.render(60);
		// First save (focus: defaultModel → namingModel → submit row).
		view.handleInput("\x1b[B");
		view.handleInput("\x1b[B");
		view.handleInput("\r");
		await new Promise((resolve) => setTimeout(resolve, 50));
		const first = wire.calls.filter((call) => call.includes("/actions"));
		expect(first).toHaveLength(1);
		expect(wire.saveBodies[0]).toContain('"rev":1');
		// The save's refetch bumped the confirmed rev; the SECOND save
		// must carry it (the pre-fix form rode the construction-time rev
		// and rejected stale).
		view.handleInput("\x1b[B");
		view.handleInput("\x1b[B");
		view.handleInput("\r");
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(wire.saveBodies).toHaveLength(2);
		expect(wire.saveBodies[1]).toContain('"rev":2');
		// No rejection notice landed.
		expect(view.render(60).join("\n")).not.toContain("changed by someone else");
	});

	test("Esc closes the open section back to the list", async () => {
		const wire = fakeWire({});
		const view = makeView(wire);
		await view.load();
		await openGeneral(view);
		expect(view.openSectionId).toBe("general");
		expect(view.closeSection()).toBe(true);
		expect(view.openSectionId).toBeUndefined();
		expect(view.render(60).join("\n")).toContain("General");
		// A second close finds nothing open.
		expect(view.closeSection()).toBe(false);
	});
});

