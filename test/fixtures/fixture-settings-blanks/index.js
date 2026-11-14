/**
 * Fixture for the blank-means-unset settings pass: every schema shape
 * dropBlankUnsets must handle (optional scalars of any type,
 * additionalProperties table rows, minItems lists, required children
 * that still reject blank strings).
 */
import { defineExtension } from "@earendil-works/pi-durable";

export default function fixture(host) {
	host.settings.declare({
		schema: {
			type: "object",
			properties: {
				embeddings: {
					type: "object",
					properties: {
						enabled: { type: "boolean", default: false },
						maxBatch: { type: "integer", minimum: 1, default: 2048, title: "Max batch" },
					},
				},
				servers: {
					type: "object",
					additionalProperties: {
						type: "object",
						properties: {
							url: { type: "string", minLength: 1 },
							timeout: { type: "number", minimum: 0.001 },
						},
						required: ["url"],
					},
				},
				names: {
					type: "array",
					items: { type: "string" },
					minItems: 1,
					default: ["default-name"],
				},
				tools: {
					type: "array",
					items: { type: "string" },
					default: ["*/search*"],
				},
				limits: {
					type: "object",
					required: ["n"],
					properties: { n: { type: "integer" } },
				},
			},
		},
	});
	return {
		extension: defineExtension({ name: "acme-blanks" }),
	};
}
