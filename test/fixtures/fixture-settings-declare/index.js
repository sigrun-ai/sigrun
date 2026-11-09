import { defineExtension } from "@earendil-works/pi-durable";

export let declared;
export function reset() {
	declared = undefined;
}

export default function fixture(host) {
	declared = host.settings.declare({
		schema: {
			type: "object",
			properties: {
				interval: { type: "integer", default: 60 },
				group: {
					type: "object",
					properties: { label: { type: "string", default: "acme" } },
				},
				mode: { type: "string" },
				servers: {
					type: "object",
					additionalProperties: {
						type: "object",
						properties: {
							headers: {
								type: "object",
								additionalProperties: { type: "string", writeOnly: true },
							},
						},
					},
				},
				entries: {
					type: "array",
					items: {
						type: "object",
						properties: { name: { type: "string" }, port: { type: "integer" } },
						required: ["name", "port"],
					},
				},
			},
		},
		userSchema: {
			type: "object",
			properties: {
				nickname: { type: "string", default: "tester" },
				enabled: { type: "boolean", default: true },
			},
		},
	});
	return { extension: defineExtension({ name: "acme-settings" }) };
}
