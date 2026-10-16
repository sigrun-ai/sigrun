/**
 * Test-fixture extension package (Task 5.5).
 *
 * Written as plain JavaScript so `import(specifier)` resolves it directly
 * without a build step — the same dynamic-import path the loader uses for
 * installed packages. Exercising the settled sigrun extension-package
 * contract: the default export is a factory returning `{ extension }`.
 */

import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";

const marker = defineTool({
	name: "fixture_marker",
	description: "Fixture marker tool: returns its input unchanged.",
	parameters: Type.Object({
		value: Type.String({ description: "Value echoed back." }),
	}),
	async execute(args) {
		return { value: args.value };
	},
});

/** Default export: factory returning the extension under `extension`. */
export default function createFixture() {
	return {
		extension: defineExtension({
			name: "sigrun-fixture-ext",
			tools: [marker],
			sections: [section("fixture-note", () => "fixture section")],
		}),
	};
}
