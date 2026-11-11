import { defineExtension } from "@earendil-works/pi-durable";

/** The default factory carries a title; tests set a global ONLY to exercise
 * the invalid/trimmed title variants without adding another fixture package. */
export default function fixture(host) {
	host.settings.declare({
		schema: {
			type: "object",
			properties: {
				endpoint: { type: "string", title: "Endpoint" },
			},
		},
	});
	return {
		extension: defineExtension({ name: "acme-titled" }),
		title: globalThis.__sigrunTitledFixtureTitle ?? "Acme Titled",
	};
}
