/**
 * Multi-user M2 fixture: declares the per-user tool surface. Tests publish
 * concrete tools through the captured seam host after boot.
 */
import { defineExtension } from "@earendil-works/pi-durable";

export default function createUserTools() {
	return {
		perUserTools: true,
		extension: defineExtension({ name: "acme" }),
	};
}
