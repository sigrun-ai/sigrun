import { defineExtension } from "@earendil-works/pi-durable";

let read;
let stateDir;
export function factoryRead() {
	return read;
}
export function factoryStateDir() {
	return stateDir;
}
export function reset() {
	read = undefined;
	stateDir = undefined;
}

export default async function fixture(host) {
	stateDir = host.stores.paths.state;
	const declared = host.settings.declare({
		schema: { type: "object", properties: { endpoint: { type: "string" } } },
	});
	read = await declared.get();
	return { extension: defineExtension({ name: "sigrun.mcp" }) };
}
