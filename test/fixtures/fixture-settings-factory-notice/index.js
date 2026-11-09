import { defineExtension } from "@earendil-works/pi-durable";

export let declared;
export let factoryRead;
export function reset() {
	declared = undefined;
	factoryRead = undefined;
}

export default async function fixture(host) {
	declared = host.settings.declare({
		schema: {
			type: "object",
			properties: {
				interval: { type: "integer", default: 60 },
				untyped: {
					type: "object",
					additionalProperties: { type: "integer", default: 0 },
				},
			},
		},
	});
	factoryRead = await declared.get();
	return { extension: defineExtension({ name: "acme-factory-notice" }) };
}
