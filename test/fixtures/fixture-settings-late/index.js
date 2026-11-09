import { defineExtension } from "@earendil-works/pi-durable";

export default function fixture() {
	return { extension: defineExtension({ name: "acme-late" }) };
}
