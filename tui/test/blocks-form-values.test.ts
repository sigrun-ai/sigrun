/**
 * `initialValue`'s toggle default (UI-blocks U4 Task 4 fix wave): an
 * absent bound value initializes a toggle to its DECLARED default —
 * the default-on settings toggles (absent = on) render ON untouched so
 * a full-form save submits the default the server then skips, never
 * writing the key.
 */

import { describe, expect, test } from "vitest";
import type { ToggleField } from "@sigrun/shared/blocks";
import { initialValue } from "../src/blocks/form/values.js";

const toggle = (extra: Partial<ToggleField> = {}): ToggleField => ({
	type: "toggle",
	name: "enabled",
	label: "Enabled",
	...extra,
});

describe("initialValue toggle defaults", () => {
	test("an absent value initializes a plain toggle to false", () => {
		expect(initialValue(toggle(), {})).toBe(false);
	});

	test("an absent value initializes a default-on toggle to true", () => {
		expect(initialValue(toggle({ default: true }), {})).toBe(true);
	});

	test("a stored value wins over the default", () => {
		expect(initialValue(toggle({ default: true }), { enabled: false })).toBe(false);
		expect(initialValue(toggle(), { enabled: true })).toBe(true);
	});
});
