/**
 * useTheme (B2, UI refresh): the mode/palette/accent theme system over
 * `@sigrun/shared/themes`. The hook resolves the stored triple, migrates
 * legacy accents, follows `prefers-color-scheme` LIVE in system mode, and
 * applies the palette's tokens as CSS custom properties plus
 * `data-mode`/`data-palette`/`data-accent` attributes on the root.
 *
 * Injectable like the old Task-25 hook: tests pass a fake storage, a fake
 * root (dataset + setProperty recorder), and a matchMedia stub — the webui
 * suite runs under react-test-renderer with no DOM. Colour literals below
 * are the shared module's values, asserted as literals (tests own them).
 */

import { act } from "react";
import { describe, expect, test } from "vitest";
import { render } from "../test-utils";
import { useTheme, type ThemeState } from "./useTheme";

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

/** A minimal fake root element: the dataset + setProperty surfaces. */
function makeRoot() {
	const properties = new Map<string, string>();
	return {
		properties,
		dataset: {} as Record<string, string | undefined>,
		setProperty(name: string, value: string) {
			properties.set(name, value);
		},
	};
}

/** A controllable matchMedia stub: `setDark` flips and notifies. */
function makeMatchMedia(startsDark: boolean) {
	const listeners = new Set<() => void>();
	let dark = startsDark;
	return {
		setDark(next: boolean) {
			dark = next;
			for (const listener of listeners) listener();
		},
		matchMedia: (_query: string) => ({
			get matches() {
				return dark;
			},
			addEventListener: (_type: string, listener: () => void) => {
				listeners.add(listener);
			},
			removeEventListener: (_type: string, listener: () => void) => {
				listeners.delete(listener);
			},
		}),
	};
}

function renderProbe(
	storage: ReturnType<typeof makeStorage>,
	root: ReturnType<typeof makeRoot>,
	media?: ReturnType<typeof makeMatchMedia>,
) {
	let captured: ThemeState | undefined;
	function Probe() {
		captured = useTheme({
			storage,
			root,
			matchMedia: media?.matchMedia,
		});
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
	test("defaults to system mode + polar-night + baltic-amber, resolving dark under a dark system preference", () => {
		const storage = makeStorage();
		const root = makeRoot();
		const probe = renderProbe(storage, root, makeMatchMedia(true));
		expect(probe.state().mode).toBe("system");
		expect(probe.state().resolved).toBe("dark");
		expect(probe.state().palette).toBe("polar-night");
		expect(probe.state().accent).toBe("baltic-amber");
		// Applied: attributes + the palette's dark tokens as custom properties.
		expect(root.dataset.mode).toBe("dark");
		expect(root.dataset.palette).toBe("polar-night");
		expect(root.dataset.accent).toBe("baltic-amber");
		expect(root.properties.get("--bg")).toBe("#090d16");
		expect(root.properties.get("--surface")).toBe("#0f1524");
		// --accent-bg: the accent at 14% alpha in dark mode.
		expect(root.properties.get("--accent")).toBe("#d6a24a");
		expect(root.properties.get("--accent-bg")).toBe("rgba(214, 162, 74, 0.14)");
	});

	test("system mode resolves light under a light system preference", () => {
		const storage = makeStorage();
		const root = makeRoot();
		const probe = renderProbe(storage, root, makeMatchMedia(false));
		expect(probe.state().resolved).toBe("light");
		expect(root.dataset.mode).toBe("light");
		// Light-mode accent-bg uses the light accent at 16% alpha.
		expect(root.properties.get("--accent")).toBe("#a8741f");
		expect(root.properties.get("--accent-bg")).toBe("rgba(168, 116, 31, 0.16)");
	});

	test("system mode follows a live prefers-color-scheme change", () => {
		const storage = makeStorage();
		const root = makeRoot();
		const media = makeMatchMedia(true);
		const probe = renderProbe(storage, root, media);
		expect(probe.state().resolved).toBe("dark");
		act(() => {
			media.setDark(false);
		});
		expect(probe.state().resolved).toBe("light");
		expect(root.dataset.mode).toBe("light");
		expect(root.properties.get("--bg")).toBe("#f0f3f9");
	});

	test("legacy stored modes dark/light load as explicit modes (not system)", () => {
		const dark = renderProbe(
			makeStorage({ "sigrun.theme": "dark" }),
			makeRoot(),
			makeMatchMedia(false),
		);
		expect(dark.state().mode).toBe("dark");
		expect(dark.state().resolved).toBe("dark");
		const light = renderProbe(
			makeStorage({ "sigrun.theme": "light" }),
			makeRoot(),
			makeMatchMedia(true),
		);
		expect(light.state().mode).toBe("light");
		expect(light.state().resolved).toBe("light");
	});

	test("the stored legacy accent amber migrates to baltic-amber, rewritten on load", () => {
		const storage = makeStorage({ "sigrun.accent": "amber" });
		const root = makeRoot();
		const probe = renderProbe(storage, root, makeMatchMedia(true));
		expect(probe.state().accent).toBe("baltic-amber");
		expect(storage.map.get("sigrun.accent")).toBe("baltic-amber");
		expect(root.dataset.accent).toBe("baltic-amber");
	});

	test("unknown stored accents (indigo, emerald, junk) fall back to baltic-amber, rewritten on load", () => {
		for (const junk of ["indigo", "emerald", "chartreuse"]) {
			const storage = makeStorage({ "sigrun.accent": junk });
			const probe = renderProbe(storage, makeRoot(), makeMatchMedia(true));
			expect(probe.state().accent).toBe("baltic-amber");
			expect(storage.map.get("sigrun.accent")).toBe("baltic-amber");
		}
	});

	test("unknown stored palettes fall back to polar-night, rewritten on load", () => {
		const storage = makeStorage({ "sigrun.palette": "iron" });
		const probe = renderProbe(storage, makeRoot(), makeMatchMedia(true));
		expect(probe.state().palette).toBe("polar-night");
		expect(storage.map.get("sigrun.palette")).toBe("polar-night");
	});

	test("setPalette('fjord') persists and applies Fjord's dark tokens under a dark system preference", () => {
		const storage = makeStorage();
		const root = makeRoot();
		const probe = renderProbe(storage, root, makeMatchMedia(true));
		act(() => {
			probe.state().setPalette("fjord");
		});
		expect(probe.state().palette).toBe("fjord");
		expect(storage.map.get("sigrun.palette")).toBe("fjord");
		expect(root.dataset.palette).toBe("fjord");
		expect(root.properties.get("--bg")).toBe("#0b0f13");
		expect(root.properties.get("--surface-2")).toBe("#18202a");
	});

	test("setMode('light') persists and applies the light tokens regardless of the system preference", () => {
		const storage = makeStorage();
		const root = makeRoot();
		const probe = renderProbe(storage, root, makeMatchMedia(true));
		act(() => {
			probe.state().setMode("light");
		});
		expect(probe.state().mode).toBe("light");
		expect(storage.map.get("sigrun.theme")).toBe("light");
		expect(root.dataset.mode).toBe("light");
		expect(root.properties.get("--bg")).toBe("#f0f3f9");
		expect(root.properties.get("--accent-bg")).toBe("rgba(168, 116, 31, 0.16)");
	});

	test("setAccent('lichen') persists and re-applies the accent tokens", () => {
		const storage = makeStorage();
		const root = makeRoot();
		const probe = renderProbe(storage, root, makeMatchMedia(true));
		act(() => {
			probe.state().setAccent("lichen");
		});
		expect(probe.state().accent).toBe("lichen");
		expect(storage.map.get("sigrun.accent")).toBe("lichen");
		expect(root.dataset.accent).toBe("lichen");
		expect(root.properties.get("--accent")).toBe("#b9c46a");
	});
});
