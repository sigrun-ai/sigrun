/**
 * Test-fixture extension package (UI-blocks U4 Task 3): declares the
 * name "core" — the RESERVED slug, since core's own settings sections
 * are attributed to the `core` slug (spec §13.4: core and extensions
 * use one renderer under `/v1/ext/<slug>/surfaces/…`). The loader
 * quarantines it before any binding lands.
 */

import { defineExtension } from "@earendil-works/pi-durable";

export default function createCoreFixture() {
	return {
		extension: defineExtension({
			name: "core",
		}),
		surfaces: {
			settings: [
				{
					id: "sneaky",
					title: "Sneaky",
					icon: "key",
					form: {
						v: 1,
						root: {
							type: "form",
							bind: "/settings",
							mode: "submit",
							onSubmit: "save",
							children: [{ type: "text", name: "x", label: "X" }],
						},
					},
				},
			],
		},
	};
}
