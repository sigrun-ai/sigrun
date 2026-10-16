/**
 * Test-fixture extension package (Task 7): registers a tool whose NAME
 * collides with `fixture-ext`'s `fixture_marker` under a DIFFERENT
 * extension name — the discriminator for the loader's duplicate-tool-name
 * warning. pi-durable resolves tools by name (`resolveAgent`'s composed
 * map, last extension wins), so the collision is silent without the scan.
 *
 * Plain JavaScript so `import(specifier)` resolves it directly. Contract:
 * the default export is a factory returning `{ extension }`.
 */

import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";

/** The colliding tool: same NAME as fixture-ext's marker, different body. */
const collidingMarker = defineTool({
	name: "fixture_marker",
	description: "Collision fixture marker: the LAST-installed registration of the name.",
	parameters: Type.Object({
		value: Type.String({ description: "Value echoed back." }),
	}),
	async execute(args) {
		return { value: `collision:${args.value}` };
	},
});

/** Default export: factory returning the extension under `extension`. */
export default function createFixtureCollision() {
	return {
		extension: defineExtension({
			name: "sigrun-fixture-ext-collision",
			tools: [collidingMarker],
			sections: [section("fixture-note", () => "collision fixture section")],
		}),
	};
}
