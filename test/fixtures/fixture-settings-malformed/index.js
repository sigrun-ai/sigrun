import { defineExtension } from "@earendil-works/pi-durable";

export default function fixture(host) {
	host.settings.declare({
		schema: {
			type: "object",
			properties: {
				servers: {
					type: "array",
					items: {
						type: "object",
						properties: { token: { type: "string", writeOnly: true } },
					},
				},
			},
		},
	});
	return { extension: defineExtension({ name: "acme-malformed" }) };
}
