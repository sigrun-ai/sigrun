import { defineExtension } from "@earendil-works/pi-durable";

export default function fixture(host) {
	host.settings.declare({
		schema: {
			type: "object",
			properties: {
				servers: {
					type: "object",
					additionalProperties: {
						type: "object",
						properties: {
							url: { type: "string", title: "Gateway address" },
							headers: {
								type: "object",
								additionalProperties: { type: "string", writeOnly: true },
							},
						},
						required: ["url"],
					},
					"x-sigrun-summary": ["url", "headers"],
				},
				mode: {
					oneOf: [
						{
							type: "object",
							title: "Remote",
							properties: {
								kind: { const: "remote", title: "Mode" },
								endpoint: { type: "string", title: "Endpoint" },
							},
							required: ["kind"],
						},
						{
							type: "object",
							title: "Local",
							properties: {
								kind: { const: "local", title: "Mode" },
								path: { type: "string", title: "Path" },
							},
							required: ["kind"],
						},
					],
				},
				nested: {
					type: "object",
					title: "Nested group",
					properties: {
						enabled: { type: "boolean", title: "Enabled", default: true },
					},
				},
			},
		},
		userSchema: {
			type: "object",
			properties: {
				nickname: { type: "string", title: "Nickname" },
			},
		},
	});
	return { extension: defineExtension({ name: "acme-settings-page" }) };
}
