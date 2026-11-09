import { defineExtension } from "@earendil-works/pi-durable";

export let changes = [];
export function reset() {
	changes = [];
}

export default function fixture(host) {
	host.settings.declare({
		schema: {
			type: "object",
			properties: {
				interval: { type: "integer", minimum: 1, default: 60 },
				enabled: { type: "boolean", default: true },
				mode: { type: "string" },
				token: { type: "string", writeOnly: true },
				constrainedToken: { type: "string", minLength: 8, writeOnly: true },
				servers: {
					type: "object",
					additionalProperties: {
						type: "object",
						properties: {
							url: { type: "string", title: "Gateway address", description: "The entry endpoint" },
							headers: {
								type: "object",
								additionalProperties: { type: "string", writeOnly: true },
							},
						},
						required: ["url"],
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
	return {
		extension: defineExtension({ name: "acme-schema-save" }),
		onSettingsChanged(keys, user) {
			changes.push({ keys: [...keys], user });
		},
	};
}
