import { defineExtension } from "@earendil-works/pi-durable";

export default function fixture(host) {
	host.settings.declare({ schema: { type: "object", properties: {} } });
	host.settings.declare({ schema: { type: "object", properties: {} } });
	return { extension: defineExtension({ name: "acme-twice" }) };
}
