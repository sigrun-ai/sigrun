/**
 * Test-fixture extension (UI-blocks U3 Task 4, Review Focus 4): a
 * surface-declaring extension whose factory body calls
 * `host.surfaces.changed(...)` immediately — never awaited. The lazy
 * binding contract (same as the seam host's conversations surface):
 * the call must WAIT for the surface bridge (bound when the server
 * exists), never crash boot, never resolve early.
 *
 * The probe is stashed on `globalThis.__fixtureSurfacesEarly`
 * (`{settled, done}`) — the fixture-channel pattern: globalThis is the
 * one shared address space between the loader's import and the test's.
 */

import { defineExtension } from "@earendil-works/pi-durable";
import { card, collection, page, bind, tree } from "@sigrun/sigrun/blocks";

const probe = { settled: false, done: Promise.resolve() };

export default function createFixtureSurfacesEarly(host) {
	if (host === undefined) {
		throw new Error("surfaces-early fixture requires the host context");
	}
	// The factory-body call (the binding contract probe): fired here,
	// never awaited — before the server exists it must WAIT.
	const done = Promise.resolve(
		host.surfaces.changed("board", "{}"),
	).then(
		() => {
			probe.settled = true;
		},
		() => {
			probe.settled = true;
		},
	);
	probe.done = done;
	globalThis.__fixtureSurfacesEarly = probe;
	return {
		extension: defineExtension({ name: "fixture-surfaces-early" }),
		surfaces: {
			views: [
				{
					id: "board",
					title: "Acme early board",
					icon: "board",
					placement: "view",
					render: async () => ({
						tree: tree(
							page({
								id: "board",
								title: "Acme early board",
								main: [
									collection({
										id: "cards",
										items: bind("/cards"),
										display: "lanes",
										groupBy: "status",
										groups: [{ id: "todo", title: "To do" }],
										item: card({ title: bind("./title") }),
									}),
								],
							}),
						),
						data: { cards: [] },
						access: "write",
					}),
				},
			],
		},
	};
}
