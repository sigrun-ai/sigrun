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
				endpoint: { type: "string", default: "https://system.example.invalid", "x-sigrun-overridable": true },
				tools: { type: "array", items: { type: "string" }, default: ["system"], "x-sigrun-overridable": true },
				enabled: { type: "boolean", default: true, "x-sigrun-overridable": true },
				paused: { type: "boolean", default: false, "x-sigrun-overridable": true },
				optional: { type: "string", "x-sigrun-overridable": true },
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
			properties: { nickname: { type: "string", default: "tester" } },
		},
	});
	return { extension: defineExtension({ name: "acme-settings-overrides" }) };
}
