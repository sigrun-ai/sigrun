/** Replacement fixture: package identity matches @sigrun/oauth. */
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";

const marker = defineTool({
	name: "acme_oauth_replacement",
	description: "Marker proving the configured OAuth replacement loaded.",
	parameters: Type.Object({}),
	async execute() {
		return { output: [{ type: "text", text: "oauth-replacement-loaded" }] };
	},
});

export default function fixtureReplacesOauth() {
	return {
		extension: defineExtension({
			name: "acme.oauth-replacement",
			tools: [marker],
		}),
	};
}
