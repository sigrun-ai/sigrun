/**
 * extViews (UI-blocks U3 Task 5): the rail/panel registration derivation.
 * Pins: view entries flatten out of the extensions response in
 * declaration order (status "ok" only), the saved-order shuffle puts
 * saved keys first (declaration order for the rest), a reordered rail
 * persists to localStorage, and panels flatten separately.
 */

import { beforeEach, describe, expect, test } from "vitest";
import type { ExtensionInfoWire } from "../api";
import {
	entryKey,
	memoryStorage,
	extPanelEntries,
	extViewEntries,
	loadRailOrder,
	orderExtViews,
	RAIL_ORDER_KEY,
	saveRailOrder,
} from "./extViews";

function extension(
	name: string,
	surfaces?: readonly { id: string; title: string; icon: string; placement: "view" | "panel" }[],
	status = "ok",
): ExtensionInfoWire {
	return {
		name,
		status,
		interactionKinds: [],
		ambientKeys: [],
		workers: [],
		...(surfaces === undefined ? {} : { surfaces }),
	};
}

const fixtureSurfaces = extension("fixture-surfaces", [
	{ id: "board", title: "Acme board", icon: "board", placement: "view" },
	{ id: "stats", title: "Acme stats", icon: "chart", placement: "panel" },
]);

describe("extViewEntries / extPanelEntries", () => {
	test("views flatten out of the extensions response (status ok only)", () => {
		const entries = extViewEntries([
			extension("fixture-surfaces", [
				{ id: "board", title: "Acme board", icon: "board", placement: "view" },
			]),
			extension("quarantined-ext", [
				{ id: "ghost", title: "Ghost", icon: "board", placement: "view" },
			], "quarantined"),
		]);
		expect(entries).toEqual([
			{ slug: "fixture-surfaces", id: "board", title: "Acme board", icon: "board" },
		]);
	});

	test("panels flatten separately (the stats panel is NOT a rail entry)", () => {
		const panels = extPanelEntries([fixtureSurfaces]);
		expect(panels).toEqual([
			{ slug: "fixture-surfaces", id: "stats", title: "Acme stats", icon: "chart" },
		]);
		expect(extViewEntries([fixtureSurfaces]).map(entryKey)).toEqual([
			"fixture-surfaces/board",
		]);
	});

	test("extensions with no surfaces contribute nothing", () => {
		expect(extViewEntries([extension("plain-ext")])).toEqual([]);
		expect(extPanelEntries([extension("plain-ext")])).toEqual([]);
	});
});

describe("orderExtViews", () => {
	const entries = [
		{ slug: "a", id: "v1", title: "A1", icon: "board" },
		{ slug: "b", title: "B1", id: "v1", icon: "chart" },
		{ slug: "c", id: "v1", title: "C1", icon: "board" },
	] as const;

	test("no saved order → declaration order", () => {
		expect(orderExtViews([...entries], []).map(entryKey)).toEqual([
			"a/v1",
			"b/v1",
			"c/v1",
		]);
	});

	test("a saved order puts its keys first, the rest in declaration order", () => {
		expect(orderExtViews([...entries], ["c/v1", "a/v1"]).map(entryKey)).toEqual([
			"c/v1",
			"a/v1",
			"b/v1",
		]);
	});

	test("stale saved keys (a removed view) drop out", () => {
		expect(orderExtViews([...entries], ["gone/v1", "b/v1"]).map(entryKey)).toEqual([
			"b/v1",
			"a/v1",
			"c/v1",
		]);
	});
});

describe("rail order persistence", () => {
	beforeEach(() => {
		(globalThis as { localStorage?: Storage }).localStorage = memoryStorage();
	});

	test("a saved order round-trips through localStorage", () => {
		saveRailOrder(["c/v1", "a/v1"]);
		expect(loadRailOrder()).toEqual(["c/v1", "a/v1"]);
		expect(
			orderExtViews(
				[
					{ slug: "a", id: "v1", title: "A1", icon: "board" },
					{ slug: "c", id: "v1", title: "C1", icon: "chart" },
				],
				loadRailOrder(),
			).map(entryKey),
		).toEqual(["c/v1", "a/v1"]);
	});

	test("garbage JSON in the store → the empty order (declaration order)", () => {
		(globalThis as { localStorage?: Storage }).localStorage?.setItem(
			RAIL_ORDER_KEY,
			"{not json",
		);
		expect(loadRailOrder()).toEqual([]);
	});
});
