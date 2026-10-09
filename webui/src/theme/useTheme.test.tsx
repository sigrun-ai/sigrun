/**
 * useTheme (Task 25): the light/dark + accent theme hook. Spec §6.1's
 * "light/dark + accent theme system" — the state persists to storage and
 * applies to the root element's `data-theme` / `data-accent` attributes
 * (the mockup's CSS-custom-properties switch).
 *
 * The hook takes an injectable storage + root so the tests run under
 * react-test-renderer (no DOM): a fake storage records the writes and a
 * fake root records the dataset assignments.
 */

import { act } from "react";
import { describe, expect, test } from "vitest";
import { render } from "../test-utils";
import { ACCENTS, useTheme, type ThemeState } from "./useTheme";

/** A minimal in-memory storage (the localStorage surface the hook uses). */
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

/** A minimal fake root element (the `dataset` surface the hook writes). */
function makeRoot() {
	return { dataset: {} as Record<string, string | undefined> };
}

function renderProbe(storage: ReturnType<typeof makeStorage>, root: ReturnType<typeof makeRoot>) {
	let captured: ThemeState | undefined;
	function Probe() {
		captured = useTheme({ storage, root });
		return null;
	}
	render(<Probe />);
	if (captured === undefined) throw new Error("theme state not captured");
	return {
		state(): ThemeState {
			if (captured === undefined) throw new Error("theme state not captured");
			return captured;
		},
	};
}

describe("useTheme", () => {
	test("defaults to dark + indigo and applies them to the root dataset", () => {
		const storage = makeStorage();
		const root = makeRoot();
		const probe = renderProbe(storage, root);
		expect(probe.state().theme).toBe("dark");
		expect(probe.state().accent).toBe("indigo");
		expect(root.dataset.theme).toBe("dark");
		expect(root.dataset.accent).toBe("indigo");
	});

	test("restores a persisted theme + accent", () => {
		const storage = makeStorage({
			"sigrun.theme": "light",
			"sigrun.accent": "amber",
		});
		const root = makeRoot();
		const probe = renderProbe(storage, root);
		expect(probe.state().theme).toBe("light");
		expect(probe.state().accent).toBe("amber");
		expect(root.dataset.theme).toBe("light");
		expect(root.dataset.accent).toBe("amber");
	});

	test("toggleTheme flips dark→light→dark, persists, and re-applies", () => {
		const storage = makeStorage();
		const root = makeRoot();
		const probe = renderProbe(storage, root);
		act(() => {
			probe.state().toggleTheme();
		});
		expect(probe.state().theme).toBe("light");
		expect(storage.map.get("sigrun.theme")).toBe("light");
		expect(root.dataset.theme).toBe("light");
		act(() => {
			probe.state().toggleTheme();
		});
		expect(probe.state().theme).toBe("dark");
		expect(storage.map.get("sigrun.theme")).toBe("dark");
		expect(root.dataset.theme).toBe("dark");
	});

	test("setAccent sets, persists, and re-applies", () => {
		const storage = makeStorage();
		const root = makeRoot();
		const probe = renderProbe(storage, root);
		act(() => {
			probe.state().setAccent("emerald");
		});
		expect(probe.state().accent).toBe("emerald");
		expect(storage.map.get("sigrun.accent")).toBe("emerald");
		expect(root.dataset.accent).toBe("emerald");
	});

	test("garbage persisted values fall back to the defaults", () => {
		const storage = makeStorage({
			"sigrun.theme": "solarized-nope",
			"sigrun.accent": "chartreuse",
		});
		const root = makeRoot();
		const probe = renderProbe(storage, root);
		expect(probe.state().theme).toBe("dark");
		expect(probe.state().accent).toBe("indigo");
	});

	test("ACCENTS lists the mockup's three accents", () => {
		expect(ACCENTS).toEqual(["indigo", "emerald", "amber"]);
	});
});
