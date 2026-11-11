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
				endpoint: { type: "string", minLength: 1, "x-sigrun-env": "ACME_SCHEMA_SAVE_URL" },
			group: {
				type: "object",
				properties: { label: { type: "boolean", default: true } },
			},
			mode: { type: "string" },
				enabled: { type: "boolean", default: true },
				mode: { type: "string" },
				labels: {
					type: "object",
					additionalProperties: { type: "string", title: "Label" },
				},
				token: { type: "string", writeOnly: true },
				constrainedToken: { type: "string", minLength: 8, writeOnly: true },
				servers: {
					type: "object",
					additionalProperties: {
						type: "object",
						properties: {
							url: { type: "string", minLength: 1, title: "Gateway address", description: "The entry endpoint" },
							label: { type: "string", minLength: 1 },
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
