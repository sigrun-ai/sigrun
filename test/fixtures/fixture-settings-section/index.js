/**
 * Test-fixture extension package (UI-blocks U4 Task 3): declares TWO
 * settings sections through `surfaces.settings` (spec §13.3) — an
 * admin one with a text + a number field plus one declared secret, and
 * a non-admin one. The loader validates the forms at load; the
 * settings-surfaces adapter serves them at
 * `/v1/ext/<slug>/surfaces/<id>` like any surface.
 *
 * Plain JavaScript so `import(specifier)` resolves it directly (the
 * same dynamic-import path the loader uses). The `received` array is
 * the test seam observing `onSettingsChanged` deliveries (the
 * fixture-settings-changed pattern — the loader and the test see ONE
 * module instance).
 */

import { defineExtension } from "@earendil-works/pi-durable";

/** Delivered `onSettingsChanged` key lists, in delivery order. */
export const received = [];

/** Clear the records (tests own their fixtures' state). */
export function reset() {
	received.length = 0;
}

/** The section forms the fixture declares (tests assert against these). */
export const SECTION_FORM = {
	v: 1,
	root: {
		type: "form",
		bind: "/settings",
		mode: "submit",
		onSubmit: "save",
		children: [
			{ type: "text", name: "apiUrl", label: "API URL" },
			{ type: "number", name: "limit", label: "Limit", min: 1, max: 100 },
		],
	},
};

export default function createSettingsSectionFixture() {
	return {
		extension: defineExtension({
			name: "acme-settings-section",
		}),
		surfaces: {
			settings: [
				{
					id: "connection",
					title: "Connection",
					icon: "key",
					form: SECTION_FORM,
					secrets: [{ key: "api-token", label: "API token" }],
					admin: true,
				},
				{
					id: "display",
					title: "Display",
					icon: "key",
					admin: false,
					form: {
						v: 1,
						root: {
							type: "form",
							bind: "/settings",
							mode: "submit",
							onSubmit: "save",
							children: [
								{ type: "text", name: "theme", label: "Theme" },
							],
						},
					},
				},
			],
		},
		onSettingsChanged(keys) {
			received.push([...keys]);
		},
	};
}
