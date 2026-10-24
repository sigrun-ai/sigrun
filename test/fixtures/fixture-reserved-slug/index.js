import { defineExtension } from "@earendil-works/pi-durable";

export default function createReservedSlugFixture() {
	return { extension: defineExtension({ name: "sandbox", tools: [] }) };
}
