import { defineExtension } from "@earendil-works/pi-durable";

export default function fixture(host) {
	host.settings.declare({
		schema: { type: "object", properties: {} },
		userSchema: {
			type: "object",
			properties: { known: { type: "string" } },
			additionalProperties: {
				type: "object",
				properties: {
					features: {
						type: "object",
						title: "Features",
						properties: { enabled: { type: "boolean" } },
					},
				},
			},
		},
	});
	return { extension: defineExtension({ name: "acme-root-table-nested" }) };
}
