import { defineExtension } from "@earendil-works/pi-durable";

export default function fixture(host) {
	host.settings.declare({
		schema: {
			type: "object",
			$defs: {
				decisionModel: { type: "string", "x-sigrun-model": "decision" },
			},
			properties: {
				model: { $ref: "#/$defs/decisionModel" },
			},
		},
	});
	return {
		extension: defineExtension({ name: "acme-model-ref" }),
		decisionProviders: [{
			id: "acme-judge",
			models: [{ id: "judge-1" }],
			async evaluate() {
				return { answers: {} };
			},
		}],
	};
}
