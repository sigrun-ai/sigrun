import { mkdir } from "node:fs/promises";
import { test, expect } from "@playwright/test";
import type { Context } from "@earendil-works/chord";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { SeamHost } from "../../src/harness/seam-host.js";
import type { InteractionRecord } from "@sigrun/shared/interactions";
import {
	bind,
	card,
	choice,
	collection,
	columns,
	form,
	markdown,
	meter,
	section,
	secret,
	tree,
} from "../../src/blocks/index.js";
import { bootE2EServer, type E2EServer } from "./harness.js";

/**
 * The interaction/ambient seam DOM assertions (Task 26b ship-gate item 4),
 * UI-blocks U6: every seeded record is a BLOCK TREE (spec §9.1/§9.2 —
 * legacy `text`/`options`/`fields`/`diff`/`line`/`rows`/`gauge` bodies are
 * gone, ruling 16).
 */

const SEAM_FIXTURE = new URL("../../test/fixtures/fixture-seam-visual/index.js", import.meta.url).href;
let server: E2EServer;

test.beforeAll(async () => {
	server = await bootE2EServer({ extensionSpecifiers: [SEAM_FIXTURE] });
});
test.afterAll(async () => { await server.cleanup(); });

/**
 * The harness's plain conversation id as the host's branded id.
 * SAFETY: same runtime value (the wire type and the storage key).
 */
function idOf(root: number): ConversationId {
	return root as unknown as ConversationId;
}

/** Seed one interaction through the seam host. */
async function seed(
	host: SeamHost,
	root: number,
	record: InteractionRecord,
	context: Context,
): Promise<void> {
	await host.seedInteraction(idOf(root), record, context);
}

/** The fixture's seam host (fails loudly when the fixture did not load). */
function seamHost(): SeamHost {
	const host = server.opened.seamHosts.get("sigrun-fixture-visual");
	if (host === undefined) throw new Error("seam host missing");
	return host;
}

test("the rendered DOM carries all primitive renderings", async ({ page }) => {
	const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
	const host = seamHost();
	const root = server.conversationId;

	// A gate form: prompt markdown + a toned, described choice.
	await seed(host, root, {
		kind: "gating.confirm", callId: "a1", status: "pending", createdAt: Date.now(),
		body: tree(form({
			id: "gate", bind: "/values", mode: "submit", children: [
				section({ children: [markdown({ text: "gate prompt" })] }),
				choice({ name: "decision", label: "Verdict", options: [
					{ id: "ok", label: "Allow", tone: "good", recommended: true },
					{ id: "no", label: "Deny", tone: "bad", description: "blocks the run" },
				] }),
			],
		})),
	}, BACKGROUND_CONTEXT);
	// A multi-choice question inside a section.
	await seed(host, root, {
		kind: "questions.form", callId: "a2", status: "pending", createdAt: Date.now(),
		details: { multi: true } as never,
		body: tree(form({
			id: "multi", bind: "/values", mode: "submit", children: [
				section({ children: [markdown({ text: "multi question" })] }),
				choice({ name: "envs", label: "Pick", multi: true, options: [
					{ id: "a", label: "A" }, { id: "b", label: "B" }] }),
			],
		})),
	}, BACKGROUND_CONTEXT);
	// A secret field form.
	await seed(host, root, {
		kind: "questions.form", callId: "a3", status: "pending", createdAt: Date.now(),
		body: tree(form({
			id: "creds", bind: "/values", mode: "submit", children: [
				secret({ name: "key", required: true, label: "Key" }),
			],
		})),
	}, BACKGROUND_CONTEXT);
	// A diff form.
	await seed(host, root, {
		kind: "gating.confirm", callId: "a4", status: "pending", createdAt: Date.now(),
		body: tree(form({
			id: "diffgate", bind: "/values", mode: "submit", children: [
				section({ children: [
					markdown({ text: "diff" }),
					{ type: "diff", before: "rm -rf x", after: "rm -r x" },
				] }),
			],
		})),
	}, BACKGROUND_CONTEXT);

	// Ambient: a goal panel (literal rows with status/metrics/quiet — the
	// 2026-10-24 ruling: ambient collections never bind; maxRows 2
	// exercises the panel drop budget), an audit panel (the gauge mapped
	// to a meter), a one-line status surface, and a footer with its
	// three zone columns.
	await host.setAmbient(idOf(root), {
		key: "goal", place: "panel", maxRows: 2,
		body: tree(collection({
			id: "goal",
			items: [
				{ id: "g1", label: "parse the spec", status: "running", completed: 2, total: 4 },
				{ id: "g2", label: "build", status: "pending", deps: ["g1"], completed: 0, total: 4 },
				{ id: "g3", label: "sweep", status: "done", quiet: true, completed: 4, total: 4 },
			],
			display: "list", item: card({
				title: bind("./label"),
				status: { label: bind("./status") },
				deps: bind("./deps"),
				quiet: bind("./quiet"),
				metrics: [
					{ label: "steps", value: bind("./completed") },
					{ label: "of", value: bind("./total") },
				],
			}),
		})),
	}, BACKGROUND_CONTEXT);
	await host.setAmbient(idOf(root), {
		key: "audit", place: "panel",
		body: tree(meter({ value: 0.4, format: "percent", label: "audit" })),
	}, BACKGROUND_CONTEXT);
	await host.setAmbient(idOf(root), {
		key: "powerline", place: "status",
		body: tree(markdown({ text: "acme/flash · main*" })),
	}, BACKGROUND_CONTEXT);
	await host.setAmbient(idOf(root), {
		key: "zones", place: "footer",
		body: tree(columns({
			children: [
				{ block: markdown({ text: "left-zone" }) },
				{ block: markdown({ text: "middle-zone" }) },
				{ block: markdown({ text: "right-zone" }) },
			],
		})),
	}, BACKGROUND_CONTEXT);

	await page.goto(`${server.url}/`);
	await page.waitForSelector(".interaction-card", { timeout: 30_000 });

	// Interaction cards: all four primitives present.
	await expect(page.locator(".interaction-card")).toHaveCount(4);
	await expect(page.locator(".interaction-card", { hasText: "gate prompt" })).toBeVisible();
	await expect(page.locator('input[type="password"]')).toHaveCount(1);
	await expect(page.locator(".blk-diff")).toHaveCount(1);
	const checkboxes = page.locator('input[type="checkbox"]');
	await expect(checkboxes).toHaveCount(2);
	// recommended pre-selected:
	await expect(page.locator('input[type="radio"]:checked')).toHaveCount(1);

	// Ambient surfaces: literal rows render through the collection
	// renderer; the quiet + dropped tail row folds behind the
	// collection's own bucket ("1 more"); the meter block carries the
	// audit gauge; the status surface renders its one line; the footer
	// renders its zone columns.
	await expect(page.locator(".ambient-surface")).toHaveCount(4);
	await expect(
		page.locator(".ambient-surface", { hasText: "parse the spec" }),
	).toBeVisible();
	// The quiet row is folded.
	await expect(
		page.locator(".ambient-surface", { hasText: "sweep" }),
	).toHaveCount(0);
	await expect(
		page.locator(".ambient-surface", { hasText: "1 more" }),
	).toBeVisible();
	await expect(page.locator(".ambient-surface", { hasText: "40%" })).toBeVisible();
	await expect(
		page.locator('.ambient-surface[data-place="status"]', { hasText: "acme/flash" }),
	).toBeAttached();
	const footer = page.locator('.ambient-surface[data-place="footer"]');
	await expect(footer).toContainText("left-zone");
	await expect(footer).toContainText("middle-zone");
	await expect(footer).toContainText("right-zone");
});
