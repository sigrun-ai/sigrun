/**
 * The interaction/ambient seam (docs/approval-ux-seams.md implementation):
 * host-context contract (loader), seam-host record writes (validation,
 * index maintenance, first-answer-wins, ambient ownership), and the generic
 * routes (list/answer/list-ambient + the /v1/meta seam inventory).
 *
 * Hermetic pattern (server-configure.test.ts): faux provider + tmpdir +
 * app.inject(); the fixture extension (test/fixtures/fixture-seam/) loads
 * through the REAL loader with the host context and drives both seams
 * through its tools.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import { resolveExtension } from "../src/harness/loader.js";
import { createServer } from "../src/server/index.js";
import type { FastifyInstance } from "fastify";

const FIXTURE_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-seam", "index.js"),
).href;

/** An extension whose factory result carries malformed kinds (contract test). */
const BAD_KINDS_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-seam-bad-kinds", "index.js"),
).href;

let dirs: string[] = [];

afterAll(async () => {
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-seam-"));
	dirs.push(dir);
	return dir;
}

function configWith(dir: string) {
	return loadConfig({
		SIGRUN_MODEL: "openai/gpt-4o",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
	});
}

interface Boot {
	opened: OpenedHarness;
	app: FastifyInstance;
}

async function bootWith(
	specifiers: readonly string[],
): Promise<Boot> {
	const dir = await tempDir();
	const config = configWith(dir);
	const opened = await openHarness(config, { env: {}, extensionSpecifiers: [...specifiers] });
	const app = await createServer(opened, config);
	return { opened, app };
}

// ─── Loader contract: kinds validation + host-context pass ────────────────

test("the loader passes the host context to arity-1 factories and retains kinds", async () => {
	const { opened } = await bootWith([FIXTURE_SPECIFIER]);
	const kinds = opened.seamKinds.get("sigrun-fixture-seam");
	expect(kinds).toEqual({
		interaction: ["fixture.ask"],
		ambient: ["fixture.panel"],
	});
	// The extension installed and its tools registered.
	expect(opened.extensionOutcomes).toContainEqual({
		name: "sigrun-fixture-seam",
		status: "ok",
	});
	// A seam host exists for the extension.
	expect(opened.seamHosts.get("sigrun-fixture-seam")).toBeDefined();
});

test("a malformed kinds declaration quarantines the extension (fail-loud)", async () => {
	const { opened } = await bootWith([BAD_KINDS_SPECIFIER]);
	const outcome = opened.extensionOutcomes.find(
		(o) => o.status === "quarantined",
	);
	expect(outcome?.status).toBe("quarantined");
	expect(outcome?.error).toContain("kinds declaration");
	// No seam host or kinds recorded for a quarantined extension.
	expect(opened.seamHosts.has("sigrun-fixture-seam-bad")).toBe(false);
});

test("resolveExtension: a zero-arg factory still resolves with a host passed (arity-safe)", async () => {
	const ext = { name: "sigrun.zero-arg", hooks: [], tools: [] };
	const result = await resolveExtension({
		default: () => ({ extension: ext }),
	});
	expect(result?.extension).toBe(ext);
});

// ─── Seam host writes: index maintenance + first-answer-wins ──────────────

test("seedInteraction maintains the pending index; answer flips the record and drains it", async () => {
	const { opened, app } = await bootWith([FIXTURE_SPECIFIER]);
	const root = await opened.harness.root(BACKGROUND_CONTEXT);
	// Seed through the fixture's tool (the extension-side path).
	const emit = await app.inject({
		method: "POST",
		url: `/v1/conversations/${root.id}/submissions`,
		payload: { input: [{ type: "text", text: "/noop" }] },
	});
	void emit;
	// Direct seam call (the host is the contract surface; a tool is one
	// caller among several — testing the host directly keeps this suite
	// focused on the seam, not the model loop).
	const host = opened.seamHosts.get("sigrun-fixture-seam");
	expect(host).toBeDefined();
	if (host === undefined) throw new Error("seam host missing");
	await host.seedInteraction(
		root.id,
		{
			kind: "fixture.ask",
			callId: "call-1",
			status: "pending",
			createdAt: 1,
			body: {
				text: "pick one",
				options: [
					{ id: "a", label: "A", tone: "ok" },
					{ id: "b", label: "B" },
				],
			},
		},
		BACKGROUND_CONTEXT,
	);

	// List route: one pending interaction with the body intact.
	const list = await app.inject({
		method: "GET",
		url: `/v1/conversations/${root.id}/interactions`,
	});
	expect(list.statusCode).toBe(200);
	const listed = list.json();
	expect(listed.interactions).toHaveLength(1);
	expect(listed.interactions[0]).toMatchObject({
		kind: "fixture.ask",
		callId: "call-1",
		status: "pending",
		body: { text: "pick one", options: [{ id: "a" }, { id: "b" }] },
	});

	// Answer route (the one generic route): human path.
	const answer = await app.inject({
		method: "POST",
		url: `/v1/conversations/${root.id}/interactions/call-1/answer`,
		payload: { ids: ["a"] },
	});
	expect(answer.statusCode).toBe(200);
	expect(answer.json()).toMatchObject({
		callId: "call-1",
		status: "answered",
		answer: { ids: ["a"] },
	});

	// The record is terminal and off the list.
	const after = await app.inject({
		method: "GET",
		url: `/v1/conversations/${root.id}/interactions`,
	});
	expect(after.json().interactions).toHaveLength(0);
	const snapshot = await host.snapshotInteraction(
		root.id,
		"call-1",
		BACKGROUND_CONTEXT,
	);
	expect(snapshot?.status).toBe("answered");
	expect(snapshot?.answeredBy).toBe("human");

	// Second answer: 404 (not pending; first-answer-wins held).
	const second = await app.inject({
		method: "POST",
		url: `/v1/conversations/${root.id}/interactions/call-1/answer`,
		payload: { ids: ["b"] },
	});
	expect(second.statusCode).toBe(404);

	// Unknown callId: 404.
	const unknown = await app.inject({
		method: "POST",
		url: `/v1/conversations/${root.id}/interactions/nope/answer`,
		payload: { text: "x" },
	});
	expect(unknown.statusCode).toBe(404);
});

test("the extension-side answer path works and is first-answer-wins with the route", async () => {
	const { opened, app } = await bootWith([FIXTURE_SPECIFIER]);
	const root = await opened.harness.root(BACKGROUND_CONTEXT);
	const host = opened.seamHosts.get("sigrun-fixture-seam");
	expect(host).toBeDefined();
	if (host === undefined) throw new Error("seam host missing");
	await host.seedInteraction(
		root.id,
		{
			kind: "fixture.ask",
			callId: "call-2",
			status: "pending",
			createdAt: 1,
		},
		BACKGROUND_CONTEXT,
	);
	// Extension answers first.
	const applied = await host.answerInteraction(
		root.id,
		"call-2",
		{ ids: ["b"] },
		BACKGROUND_CONTEXT,
	);
	expect(applied).toBe(true);
	// Route second: 404 (extension's decision won).
	const route = await app.inject({
		method: "POST",
		url: `/v1/conversations/${root.id}/interactions/call-2/answer`,
		payload: { ids: ["a"] },
	});
	expect(route.statusCode).toBe(404);
	// answeredBy is the extension.
	const snapshot = await host.snapshotInteraction(
		root.id,
		"call-2",
		BACKGROUND_CONTEXT,
	);
	expect(snapshot?.answeredBy).toBe("extension");
});

test("seam-host validation: undeclared kind and malformed body fail loud", async () => {
	const { opened } = await bootWith([FIXTURE_SPECIFIER]);
	const root = await opened.harness.root(BACKGROUND_CONTEXT);
	const host = opened.seamHosts.get("sigrun-fixture-seam");
	expect(host).toBeDefined();
	if (host === undefined) throw new Error("seam host missing");
	// Undeclared kind.
	await expect(
		host.seedInteraction(
			root.id,
			{ kind: "other.kind", callId: "x", status: "pending", createdAt: 1 },
			BACKGROUND_CONTEXT,
		),
	).rejects.toThrow(/not declared by/);
	// Malformed body (unknown primitive).
	await expect(
		host.seedInteraction(
			root.id,
			{
				kind: "fixture.ask",
				callId: "y",
				status: "pending",
				createdAt: 1,
				body: { color: "red" } as unknown as undefined,
			},
			BACKGROUND_CONTEXT,
		),
	).rejects.toThrow(/outside the closed primitives/);
});

// ─── Ambient seam: ownership, replacement, list route ─────────────────────

test("setAmbient writes; the list serves the surface; clear empties it", async () => {
	const { opened, app } = await bootWith([FIXTURE_SPECIFIER]);
	const root = await opened.harness.root(BACKGROUND_CONTEXT);
	const host = opened.seamHosts.get("sigrun-fixture-seam");
	expect(host).toBeDefined();
	if (host === undefined) throw new Error("seam host missing");
	await host.setAmbient(
		root.id,
		{
			key: "fixture.panel",
			place: "status",
			body: { line: { text: "hello" } },
		},
		BACKGROUND_CONTEXT,
	);
	const list = await app.inject({
		method: "GET",
		url: `/v1/conversations/${root.id}/ambient`,
	});
	expect(list.statusCode).toBe(200);
	const surfaces = list.json().ambient;
	expect(surfaces).toHaveLength(1);
	expect(surfaces[0]).toMatchObject({
		key: "fixture.panel",
		owner: "sigrun-fixture-seam",
		place: "status",
		body: { line: { text: "hello" } },
	});
	// Replacement write (full state).
	await host.setAmbient(
		root.id,
		{
			key: "fixture.panel",
			place: "status",
			maxRows: 5,
			refreshMs: 1000,
			body: {
				rows: [{ id: "r1", label: "step", status: "running", metrics: { completed: 2, total: 5 } }],
			},
		},
		BACKGROUND_CONTEXT,
	);
	const replaced = (await app.inject({
		method: "GET",
		url: `/v1/conversations/${root.id}/ambient`,
	})).json().ambient;
	expect(replaced[0].body.line).toBeUndefined();
	expect(replaced[0].body.rows).toHaveLength(1);
	expect(replaced[0].maxRows).toBe(5);
	// Clear: empty body → off the list.
	await host.clearAmbient(root.id, "fixture.panel", BACKGROUND_CONTEXT);
	const cleared = (await app.inject({
		method: "GET",
		url: `/v1/conversations/${root.id}/ambient`,
	})).json().ambient;
	expect(cleared).toHaveLength(0);
});

test("ambient undeclared key and malformed row fail loud", async () => {
	const { opened } = await bootWith([FIXTURE_SPECIFIER]);
	const root = await opened.harness.root(BACKGROUND_CONTEXT);
	const host = opened.seamHosts.get("sigrun-fixture-seam");
	expect(host).toBeDefined();
	if (host === undefined) throw new Error("seam host missing");
	await expect(
		host.setAmbient(
			root.id,
			{ key: "other.panel", place: "status" },
			BACKGROUND_CONTEXT,
		),
	).rejects.toThrow(/not declared by/);
	await expect(
		host.setAmbient(
			root.id,
			{
				key: "fixture.panel",
				place: "panel",
				body: { rows: [{ id: "r", label: "x", severity: 9 } as unknown as never] },
			},
			BACKGROUND_CONTEXT,
		),
	).rejects.toThrow(/severity/);
});

// ─── /v1/meta seam inventory ──────────────────────────────────────────────

test("the meta route inventories declared kinds", async () => {
	const { app } = await bootWith([FIXTURE_SPECIFIER]);
	const meta = (await app.inject({ method: "GET", url: "/v1/meta" })).json();
	expect(meta.seam).toEqual({
		interactions: [{ extension: "sigrun-fixture-seam", kinds: ["fixture.ask"] }],
		ambient: [{ extension: "sigrun-fixture-seam", keys: ["fixture.panel"] }],
	});
});
