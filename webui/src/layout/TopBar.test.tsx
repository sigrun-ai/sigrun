/**
 * TopBar (Task 25): the header — the sigrun brand, the extension-set badge
 * (from `GET /v1/meta`: `extensions[].name` + `status`, a quarantined
 * extension rendering distinctly), the degraded-health badges
 * (`health.backup` unconfigured/degraded, `memory`/`providers` degraded),
 * and the theme controls (toggle + accent picker).
 */

import { act } from "react";
import type TestRenderer from "react-test-renderer";
import { describe, expect, test, vi } from "vitest";
import type { FetchLike, MetaResponse, SettingsWire } from "../api";
import { createClient } from "../api";
import { render, textContent } from "../test-utils";
import type { ThemeState } from "../theme/useTheme";
import { TopBar } from "./TopBar";

/** All text under a ReactTestInstance (findByProps results, not JSON). */
function instanceText(instance: TestRenderer.ReactTestInstance): string {
	return instance.children
		.map((child) =>
			typeof child === "string" ? child : instanceText(child),
		)
		.join("");
}

function makeMeta(init?: {
	readonly extensions?: MetaResponse["extensions"];
	readonly health?: MetaResponse["health"];
}): MetaResponse {
	return {
		harnessVersion: "1.0.2",
		schemaVersion: "abc123",
		extensions: init?.extensions ?? [
			{ name: "memory", status: "ok" },
			{ name: "approvals", status: "ok" },
		],
		health: init?.health ?? {
			backup: "configured",
			memory: "ok",
			providers: "ok",
		},
		capabilities: { backup: true, channels: ["webui"] },
	};
}

function fakeTheme(init?: Partial<ThemeState>): ThemeState {
	return {
		theme: "dark",
		accent: "indigo",
		toggleTheme: vi.fn(),
		setAccent: vi.fn(),
		...init,
	};
}

/** A client over a fetch stub that serves `{}` for every settings GET. */
function fakeClient(settings: SettingsWire = {}) {
	const fetchImpl: FetchLike = (input) =>
		Promise.resolve({
			ok: true,
			status: 200,
			json: () =>
				Promise.resolve(input === "/v1/settings" ? settings : {}),
			text: () => Promise.resolve(""),
		});
	return createClient({ fetch: fetchImpl });
}

describe("TopBar", () => {
	test("renders the sigrun brand", () => {
		const renderer = render(<TopBar meta={makeMeta()} theme={fakeTheme()} client={fakeClient()} />);
		expect(textContent(renderer.toJSON())).toContain("sigrun");
	});

	test("the extension badge lists the installed extensions", () => {
		const renderer = render(<TopBar meta={makeMeta()} theme={fakeTheme()} client={fakeClient()} />);
		const badge = renderer.root.findByProps({ className: "badge badge-extensions" });
		expect(instanceText(badge)).toContain("memory");
		expect(instanceText(badge)).toContain("approvals");
	});

	test("a quarantined extension renders distinctly (degraded badge + marker)", () => {
		const renderer = render(
			<TopBar
				meta={makeMeta({
					extensions: [
						{ name: "memory", status: "ok" },
						{ name: "approvals", status: "quarantined" },
					],
				})}
				theme={fakeTheme()}
				client={fakeClient()}
			/>,
		);
		const badges = renderer.root.findAllByProps({
			className: "badge badge-extensions badge-degraded",
		});
		expect(badges).toHaveLength(1);
		const text = instanceText(badges[0]!);
		expect(text).toContain("approvals");
		expect(text).toContain("⚠");
	});

	test("backup unconfigured renders a badge; backup configured renders none", () => {
		const unconfigured = render(
			<TopBar
				meta={makeMeta({
					health: { backup: "unconfigured", memory: "ok", providers: "ok" },
				})}
				theme={fakeTheme()}
				client={fakeClient()}
			/>,
		);
		expect(textContent(unconfigured.toJSON())).toContain("backup: unconfigured");

		const configured = render(<TopBar meta={makeMeta()} theme={fakeTheme()} client={fakeClient()} />);
		expect(textContent(configured.toJSON())).not.toContain("backup:");
	});

	test("degraded memory + providers render badges; ok renders none", () => {
		const degraded = render(
			<TopBar
				meta={makeMeta({
					health: { backup: "configured", memory: "degraded", providers: "degraded" },
				})}
				theme={fakeTheme()}
				client={fakeClient()}
			/>,
		);
		const text = textContent(degraded.toJSON());
		expect(text).toContain("memory: degraded");
		expect(text).toContain("providers: degraded");

		const ok = render(<TopBar meta={makeMeta()} theme={fakeTheme()} client={fakeClient()} />);
		expect(textContent(ok.toJSON())).not.toContain("degraded");
	});

	test("the theme toggle + accent picker forward to the theme state", () => {
		const theme = fakeTheme();
		const renderer = render(<TopBar meta={makeMeta()} theme={theme} client={fakeClient()} />);
		const toggle = renderer.root.findByProps({ className: "theme-toggle" });
		(toggle.props as { onClick: () => void }).onClick();
		expect(theme.toggleTheme).toHaveBeenCalledTimes(1);
		const accent = renderer.root.findByProps({ className: "accent-picker" });
		(accent.props as { onChange: (e: { target: { value: string } }) => void }).onChange({
			target: { value: "emerald" },
		});
		expect(theme.setAccent).toHaveBeenCalledWith("emerald");
	});

	test("the gear opens the settings panel; the close button closes it", async () => {
		const renderer = render(
			<TopBar
				meta={makeMeta()}
				theme={fakeTheme()}
				client={fakeClient({ steeringMode: "all" })}
			/>,
		);
		const gear = renderer.root.findByProps({ className: "settings-gear" });
		expect(renderer.root.findAllByProps({ className: "settings-overlay" })).toHaveLength(0);
		await act(async () => {
			(gear.props as { onClick: () => void }).onClick();
		});
		// The panel opened and rendered the served settings.
		const overlay = renderer.root.findByProps({ className: "settings-overlay" });
		expect(instanceText(overlay)).toContain("settings");
		const select = overlay.findByProps({ className: "settings-steering" });
		expect(select.props.value).toBe("all");
		await act(async () => {
			(overlay.findByProps({ className: "settings-close" })
				.props as { onClick: () => void }).onClick();
		});
		expect(renderer.root.findAllByProps({ className: "settings-overlay" })).toHaveLength(0);
	});
});
