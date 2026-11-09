import { defineExtension } from "@earendil-works/pi-durable";

export default function fixture(host) {
	host.settings.declare({
		schema: { type: "object", properties: {} },
		userSchema: {
			type: "object",
			properties: { nickname: { type: "string", default: "tester" } },
		},
	});
	return { extension: defineExtension({ name: "acme-schema-user-only" }) };
}
