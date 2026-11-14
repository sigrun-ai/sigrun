import { defineExtension } from "@earendil-works/pi-durable";

export default function fixture(host) {
	host.settings.declare({
		schema: {
			type: "object",
			properties: {
				group: {
					type: "object",
					properties: {
						threshold: { type: "integer", default: 10, "x-sigrun-overridable": true },
					},
				},
			},
		},
		userSchema: {
			type: "object",
			properties: {
				group: { type: "object", properties: { threshold: { type: "integer" } } },
			},
		},
	});
	return { extension: defineExtension({ name: "acme-settings-overrides-conflict" }) };
}
