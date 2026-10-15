/**
 * usePrefs: the client-only interface preferences (localStorage-backed —
 * the 2026-10-15 quick-wins ruling: UI display prefs never touch the
 * server settings file, whose PATCH validates keys strictly).
 *
 * One JSON document under one storage key, merged over defaults per field
 * so a future pref addition never orphans the stored document. Garbage
 * (unparseable JSON, wrong types) falls back to the defaults field-wise.
 *
 * Injectable storage like useTheme: the app uses localStorage, tests pass
 * a fake (the webui suite runs under react-test-renderer with no DOM);
 * no localStorage falls back to a session memory store.
 */

import { act } from "react";
import { describe, expect, test } from "vitest";
import { render } from "../test-utils";
import {
	PREFS_STORAGE_KEY,
	usePrefs,
	type PrefKey,
	type Prefs,
} from "./usePrefs";

function makeStorage(initial?: Record<string, string>) {
	const map = new Map<string, string>(Object.entries(initial ?? {}));
	return {
		map,
		getItem: (key: string) => map.get(key) ?? null,
		setItem: (key: string, value: string) => {
			map.set(key, value);
		},
	};
}

function renderProbe(storage: ReturnType<typeof makeStorage>) {
	let captured: ReturnType<typeof usePrefs> | undefined;
	function Probe() {
		captured = usePrefs({ storage });
		return null;
	}
	render(<Probe />);
	if (captured === undefined) throw new Error("prefs not captured");
	return {
		state() {
			if (captured === undefined) throw new Error("prefs not captured");
			return captured;
		},
	};
}

describe("usePrefs", () => {
	test("defaults: enterToSend off, showThinking on", () => {
		const storage = makeStorage();
		const probe = renderProbe(storage);
		expect(probe.state().prefs).toEqual({
			enterToSend: false,
			showThinking: true,
		});
	});

	test("restores a stored document", () => {
		const storage = makeStorage({
			[PREFS_STORAGE_KEY]: JSON.stringify({
				enterToSend: true,
				showThinking: false,
			}),
		});
		const probe = renderProbe(storage);
		expect(probe.state().prefs.enterToSend).toBe(true);
		expect(probe.state().prefs.showThinking).toBe(false);
	});

	test("a partial stored document merges over the defaults", () => {
		const storage = makeStorage({
			[PREFS_STORAGE_KEY]: JSON.stringify({ enterToSend: true }),
		});
		const probe = renderProbe(storage);
		expect(probe.state().prefs).toEqual({
			enterToSend: true,
			showThinking: true,
		});
	});

	test("garbage JSON and wrong-typed fields fall back field-wise", () => {
		const garbage = renderProbe(
			makeStorage({ [PREFS_STORAGE_KEY]: "not json{" }),
		);
		expect(garbage.state().prefs).toEqual({
			enterToSend: false,
			showThinking: true,
		});
		const wrongTypes = renderProbe(
			makeStorage({
				[PREFS_STORAGE_KEY]: JSON.stringify({
					enterToSend: "yes",
					showThinking: 7,
				}),
			}),
		);
		expect(wrongTypes.state().prefs).toEqual({
			enterToSend: false,
			showThinking: true,
		});
	});

	test("setPref updates one field, persists, and preserves the others", () => {
		const storage = makeStorage();
		const probe = renderProbe(storage);
		act(() => {
			probe.state().setPref("enterToSend" satisfies PrefKey, true);
		});
		expect(probe.state().prefs.enterToSend).toBe(true);
		expect(probe.state().prefs.showThinking).toBe(true);
		expect(JSON.parse(storage.map.get(PREFS_STORAGE_KEY) ?? "{}")).toEqual({
			enterToSend: true,
		});
		act(() => {
			probe.state().setPref("showThinking", false);
		});
		expect(probe.state().prefs.showThinking).toBe(false);
		expect(JSON.parse(storage.map.get(PREFS_STORAGE_KEY) ?? "{}")).toEqual({
			enterToSend: true,
			showThinking: false,
		});
	});

	test("the Prefs type carries exactly the shipped keys", () => {
		const keys: readonly PrefKey[] = ["enterToSend", "showThinking"];
		const sample: Prefs = { enterToSend: false, showThinking: true };
		expect(keys.length).toBe(Object.keys(sample).length);
	});
});
