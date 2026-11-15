import { defineExtension } from "@earendil-works/pi-durable";

export let declared;
export function reset() {
	declared = undefined;
}

export default function fixture(host) {
	declared = host.settings.declare({
		schema: {
			type: "object",
			$defs: { Endpoint: { type: "string", minLength: 3 } },
			properties: {
				endpoint: { type: "string", default: "https://system.example.invalid", "x-sigrun-overridable": true },
				tools: { type: "array", items: { type: "string" }, default: ["system"], "x-sigrun-overridable": true },
				enabled: { type: "boolean", default: true, "x-sigrun-overridable": true },
				paused: { type: "boolean", default: false, "x-sigrun-overridable": true },
				optional: { type: "string", "x-sigrun-overridable": true },
				referenced: { $ref: "#/$defs/Endpoint", "x-sigrun-overridable": true },
				envEndpoint: {
					type: "string",
					default: "https://system.example.invalid",
					"x-sigrun-env": "ACME_OVERRIDE_ENDPOINT_URL",
					"x-sigrun-overridable": true,
				},
				destinations: {
					type: "array",
					items: {
						type: "object",
						properties: {
							itemEndpoint: { type: "string", "x-sigrun-env": "ACME_OVERRIDE_ITEM_URL" },
							nested: {
								type: "array",
								items: { type: "string", "x-sigrun-env": "ACME_OVERRIDE_DEEP_ITEM_URL" },
							},
						},
					},
					"x-sigrun-overridable": true,
				},
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
			$defs: { PersonalName: { type: "string", pattern: "^acme-" } },
			properties: { nickname: { $ref: "#/$defs/PersonalName", default: "acme-tester" } },
		},
	});
	return { extension: defineExtension({ name: "acme-settings-overrides" }) };
}
