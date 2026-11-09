import { defineExtension } from "@earendil-works/pi-durable";

let read;
export function factoryRead() {
	return read;
}
export function reset() {
	read = undefined;
}

export default async function fixture(host) {
	const declared = host.settings.declare({
		schema: { type: "object", properties: { endpoint: { type: "string" } } },
	});
	read = await declared.get();
	return { extension: defineExtension({ name: "sigrun.mcp" }) };
}
