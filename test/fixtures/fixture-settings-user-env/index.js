import { defineExtension } from "@earendil-works/pi-durable";

export default function fixture(host) {
	host.settings.declare({
		schema: { type: "object", properties: {} },
		userSchema: {
			type: "object",
			properties: {
				profile: {
					type: "object",
					properties: {
						endpoint: { type: "string", "x-sigrun-env": "ACME_USER_URL" },
					},
				},
			},
		},
	});
	return { extension: defineExtension({ name: "acme-user-env" }) };
}
