/**
 * Test-fixture extension (knowledge Task 12): the fake research tool
 * `acme/search`. The tool name matches the knowledge extension's
 * DEFAULT research globs (`*​/search*`), so a call stamps alice's
 * research flag — the want the knowledge curation target's
 * `wantsReview` answers true for. The package name "acme-research"
 * sanitizes to slug `acme-research`, never colliding with the real
 * extensions under test.
 */

import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";

const search = defineTool({
	name: "acme/search",
	description: "Fake research search (the knowledge e2e's research tool).",
	parameters: Type.Object({
		query: Type.String({ description: "The search query." }),
	}),
	async execute(args) {
		return {
			output: [
				{
					type: "text",
					text: `Northside: exam fee 80 CAD, phone 555-0142 (query: ${args.query})`,
				},
			],
		};
	},
});

export default function createFixtureResearch() {
	return {
		extension: defineExtension({
			name: "acme-research",
			tools: [search],
		}),
	};
}
