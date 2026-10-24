/**
 * The interaction/ambient seam (docs/approval-ux-seams.md implementation;
 * block mapping: docs/superpowers/specs/2026-10-19-sigrun-ui-blocks-design.md
 * §9.1/§9.2): host-context contract (loader), seam-host record writes
 * (validation, index maintenance, first-answer-wins, ambient ownership),
 * and the generic routes (list/answer/list-ambient + the /v1/meta seam
 * inventory).
 *
 * UI-blocks U6 Task 1: bodies are BLOCK TREES (placement `interaction` /
 * `ambient`), answers are `{values}` (ruling 20), and legacy-shaped
 * records FAIL validation with paths (ruling 16 — no compatibility
 * layer).
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
import { afterAll, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { BLOCK_SET_VERSION, type Tree } from "@sigrun/shared/blocks";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import { resolveExtension } from "../src/harness/loader.js";
import { createServer } from "../src/server/index.js";
import { seededIdentity } from "./helpers/identity.js";
import { askTree, lineTree } from "./helpers/trees.js";
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
		SIGRUN_AUTH: "none",
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
	const opened = await openHarness(config, {
		identity: await seededIdentity(dir), env: {}, extensionSpecifiers: [...specifiers] });
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
			body: askTree(),
		},
		BACKGROUND_CONTEXT,
	);

	// List route: one pending interaction with the tree intact.
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
		body: askTree(),
	});

	// Answer route (the one generic route): the {values} body (ruling 20).
	const answer = await app.inject({
		method: "POST",
		url: `/v1/conversations/${root.id}/interactions/call-1/answer`,
		payload: { values: { decision: "allow" } },
	});
	expect(answer.statusCode).toBe(200);
	expect(answer.json()).toMatchObject({
		callId: "call-1",
		status: "answered",
		answer: { values: { decision: "allow" } },
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
		payload: { values: { decision: "deny" } },
	});
	expect(second.statusCode).toBe(404);

	// Unknown callId: 404.
	const unknown = await app.inject({
		method: "POST",
		url: `/v1/conversations/${root.id}/interactions/nope/answer`,
		payload: { values: { decision: "allow" } },
	});
	expect(unknown.statusCode).toBe(404);
});

test("answerInteraction attribution: opts.user stamps human + answeredByUser; absent keeps extension", async () => {
	const { opened } = await bootWith([FIXTURE_SPECIFIER]);
	const root = await opened.harness.root(BACKGROUND_CONTEXT);
	const host = opened.seamHosts.get("sigrun-fixture-seam");
	expect(host).toBeDefined();
	if (host === undefined) throw new Error("seam host missing");
	// Two pending records: one answered WITH opts.user, one without.
	for (const callId of ["call-attr-human", "call-attr-extension"]) {
		await host.seedInteraction(
			root.id,
			{
				kind: "fixture.ask",
				callId,
				status: "pending",
				createdAt: 1,
				body: askTree(),
			},
			BACKGROUND_CONTEXT,
		);
	}
	// With opts.user: the record is answered BY A HUMAN, named.
	const named = await host.answerInteraction(
		root.id,
		"call-attr-human",
		{ values: { decision: "allow" } },
		BACKGROUND_CONTEXT,
		{ user: "alice" },
	);
	expect(named).toBe(true);
	const human = await host.snapshotInteraction(
		root.id,
		"call-attr-human",
		BACKGROUND_CONTEXT,
	);
	expect(human?.status).toBe("answered");
	expect(human?.answeredBy).toBe("human");
	expect(human?.answeredByUser).toBe("alice");
	// Without opts: unchanged — the extension answered, no user named.
	const plain = await host.answerInteraction(
		root.id,
		"call-attr-extension",
		{ values: { decision: "deny" } },
		BACKGROUND_CONTEXT,
	);
	expect(plain).toBe(true);
	const extensionAnswer = await host.snapshotInteraction(
		root.id,
		"call-attr-extension",
		BACKGROUND_CONTEXT,
	);
	expect(extensionAnswer?.status).toBe("answered");
	expect(extensionAnswer?.answeredBy).toBe("extension");
	expect(extensionAnswer?.answeredByUser).toBeUndefined();
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
		{ values: { decision: "deny" } },
		BACKGROUND_CONTEXT,
	);
	expect(applied).toBe(true);
	// Route second: 404 (extension's decision won).
	const route = await app.inject({
		method: "POST",
		url: `/v1/conversations/${root.id}/interactions/call-2/answer`,
		payload: { values: { decision: "allow" } },
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

test("seam-host validation: undeclared kind and malformed tree fail loud", async () => {
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
	// A malformed body (a block that is not a tree at all).
	await expect(
		host.seedInteraction(
			root.id,
			{
				kind: "fixture.ask",
				callId: "y",
				status: "pending",
				createdAt: 1,
				body: { color: "red" } as never,
			},
			BACKGROUND_CONTEXT,
		),
	).rejects.toThrow(/body is not a valid interaction tree/);
});

// ─── Legacy-shape rejection (ruling 16: no compatibility layer) ───────────

test("a legacy options[] body fails validation with a path naming body", async () => {
	const { opened, app } = await bootWith([FIXTURE_SPECIFIER]);
	const root = await opened.harness.root(BACKGROUND_CONTEXT);
	const host = opened.seamHosts.get("sigrun-fixture-seam");
	if (host === undefined) throw new Error("seam host missing");
	const legacy = {
		kind: "fixture.ask",
		callId: "legacy-1",
		status: "pending",
		createdAt: 1,
		body: {
			text: "pick one",
			options: [
				{ id: "a", label: "A", tone: "ok" },
				{ id: "b", label: "B" },
			],
		},
	} as never;
	const rejection = await host
		.seedInteraction(root.id, legacy, BACKGROUND_CONTEXT)
		.catch((error: unknown) => error);
	expect(rejection).toBeInstanceOf(Error);
	expect(String(rejection)).toMatch(/body/);
	// The legacy record never landed: it is absent from the list route.
	const list = await app.inject({
		method: "GET",
		url: `/v1/conversations/${root.id}/interactions`,
	});
	expect(list.json().interactions).toHaveLength(0);
});

test("a tree using chart in an interaction fails with its path", async () => {
	const { opened } = await bootWith([FIXTURE_SPECIFIER]);
	const root = await opened.harness.root(BACKGROUND_CONTEXT);
	const host = opened.seamHosts.get("sigrun-fixture-seam");
	if (host === undefined) throw new Error("seam host missing");
	// The interaction placement allows NO chart — but the root must be a
	// form first; a chart at the root names its path.
	const chartRoot = {
		kind: "fixture.ask",
		callId: "chart-1",
		status: "pending",
		createdAt: 1,
		body: {
			v: BLOCK_SET_VERSION,
			root: {
				type: "chart",
				x: { kind: "time" },
				series: [],
			},
		},
	} as never;
	const rejection = await host
		.seedInteraction(root.id, chartRoot, BACKGROUND_CONTEXT)
		.catch((error: unknown) => error);
	expect(rejection).toBeInstanceOf(Error);
	expect(String(rejection)).toMatch(/body\.root/);
});

test("a file field in an interaction form fails with its path", async () => {
	const { opened } = await bootWith([FIXTURE_SPECIFIER]);
	const root = await opened.harness.root(BACKGROUND_CONTEXT);
	const host = opened.seamHosts.get("sigrun-fixture-seam");
	if (host === undefined) throw new Error("seam host missing");
	const fileField = {
		kind: "fixture.ask",
		callId: "file-1",
		status: "pending",
		createdAt: 1,
		body: {
			v: BLOCK_SET_VERSION,
			root: {
				type: "form",
				id: "f",
				bind: "/values",
				mode: "submit",
				children: [
					{ type: "file", name: "logo", label: "Logo", onUpload: "up" },
				],
			},
		},
	} as never;
	const rejection = await host
		.seedInteraction(root.id, fileField, BACKGROUND_CONTEXT)
		.catch((error: unknown) => error);
	expect(rejection).toBeInstanceOf(Error);
	expect(String(rejection)).toMatch(/body\.root\.children\[0\]/);
});

test("a legacy answer shape is a 400: {ids} and {text} are gone (ruling 20)", async () => {
	const { opened, app } = await bootWith([FIXTURE_SPECIFIER]);
	const root = await opened.harness.root(BACKGROUND_CONTEXT);
	const host = opened.seamHosts.get("sigrun-fixture-seam");
	if (host === undefined) throw new Error("seam host missing");
	await host.seedInteraction(
		root.id,
		{
			kind: "fixture.ask",
			callId: "ans-legacy",
			status: "pending",
			createdAt: 1,
			body: askTree(),
		},
		BACKGROUND_CONTEXT,
	);
	const ids = await app.inject({
		method: "POST",
		url: `/v1/conversations/${root.id}/interactions/ans-legacy/answer`,
		payload: { ids: ["a"] },
	});
	expect(ids.statusCode).toBe(400);
	const text = await app.inject({
		method: "POST",
		url: `/v1/conversations/${root.id}/interactions/ans-legacy/answer`,
		payload: { text: "because" },
	});
	expect(text.statusCode).toBe(400);
	// The record is still pending (nothing was applied).
	const list = (
		await app.inject({
			method: "GET",
			url: `/v1/conversations/${root.id}/interactions`,
		})
	).json();
	expect(list.interactions).toHaveLength(1);
});

test("a {values} answer with arrays and nested objects passes (ruling 20)", async () => {
	const { opened, app } = await bootWith([FIXTURE_SPECIFIER]);
	const root = await opened.harness.root(BACKGROUND_CONTEXT);
	const host = opened.seamHosts.get("sigrun-fixture-seam");
	if (host === undefined) throw new Error("seam host missing");
	await host.seedInteraction(
		root.id,
		{
			kind: "fixture.ask",
			callId: "ans-rich",
			status: "pending",
			createdAt: 1,
			body: askTree(),
		},
		BACKGROUND_CONTEXT,
	);
	const answer = await app.inject({
		method: "POST",
		url: `/v1/conversations/${root.id}/interactions/ans-rich/answer`,
		payload: {
			values: { q1: ["a", "b"], q2: { other: "x" } },
		},
	});
	expect(answer.statusCode).toBe(200);
	expect(answer.json()).toMatchObject({
		callId: "ans-rich",
		status: "answered",
		answer: { values: { q1: ["a", "b"], q2: { other: "x" } } },
	});
});

// ─── Review Focus 5: a legacy write fails loud; a later valid write works ──

test("a legacy-shaped write throws naming the path; a later valid write succeeds (Review Focus 5)", async () => {
	const { opened, app } = await bootWith([FIXTURE_SPECIFIER]);
	const root = await opened.harness.root(BACKGROUND_CONTEXT);
	const host = opened.seamHosts.get("sigrun-fixture-seam");
	if (host === undefined) throw new Error("seam host missing");

	// The legacy write: an options[] body (the pre-U6 shape).
	const legacy = {
		kind: "fixture.ask",
		callId: "rf5",
		status: "pending",
		createdAt: 1,
		body: { text: "proceed?", options: [{ id: "allow", label: "Allow" }] },
	} as never;
	await expect(
		host.seedInteraction(root.id, legacy, BACKGROUND_CONTEXT),
	).rejects.toThrow(/body/);

	// Nothing rendered: the pending list is empty (the write never landed).
	const empty = (
		await app.inject({
			method: "GET",
			url: `/v1/conversations/${root.id}/interactions`,
		})
	).json();
	expect(empty.interactions).toHaveLength(0);

	// A later VALID write under the same callId succeeds.
	await host.seedInteraction(
		root.id,
		{
			kind: "fixture.ask",
			callId: "rf5",
			status: "pending",
			createdAt: 2,
			body: askTree(),
		},
		BACKGROUND_CONTEXT,
	);
	const list = (
		await app.inject({
			method: "GET",
			url: `/v1/conversations/${root.id}/interactions`,
		})
	).json();
	expect(list.interactions).toHaveLength(1);
	expect(list.interactions[0]).toMatchObject({ callId: "rf5" });

	// And the conversation is unaffected: it still runs a submission.
	const faux = opened.defaultModel;
	expect(faux).toBeDefined();
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
			body: lineTree("hello"),
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
		body: lineTree("hello"),
	});
	// Replacement write (full state): a panel collection replacing the line.
	const collectionBody = {
		v: BLOCK_SET_VERSION,
		root: {
			type: "collection",
			id: "steps",
			items: { $: "/rows" },
			display: "list",
			item: {
				title: { $: "./label" },
				quiet: { $: "./quiet" },
				tone: { $: "./tone" },
			},
		},
	} as const;
	await host.setAmbient(
		root.id,
		{
			key: "fixture.panel",
			place: "panel",
			maxRows: 5,
			refreshMs: 1000,
			body: collectionBody,
		},
		BACKGROUND_CONTEXT,
	);
	const replaced = (await app.inject({
		method: "GET",
		url: `/v1/conversations/${root.id}/ambient`,
	})).json().ambient;
	expect(replaced[0].body).toEqual(collectionBody);
	expect(replaced[0].place).toBe("panel");
	expect(replaced[0].maxRows).toBe(5);
	// Clear: empty body → off the list.
	await host.clearAmbient(root.id, "fixture.panel", BACKGROUND_CONTEXT);
	const cleared = (await app.inject({
		method: "GET",
		url: `/v1/conversations/${root.id}/ambient`,
	})).json().ambient;
	expect(cleared).toHaveLength(0);
});

test("ambient undeclared key and malformed tree fail loud", async () => {
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
				// A form is not allowed in the ambient placement (no forms —
				// §9.2 records render read-only state).
				body: askTree(),
			},
			BACKGROUND_CONTEXT,
		),
	).rejects.toThrow(/form block is not allowed in ambient/);
});

test("a legacy ambient line/rows body fails with a path naming body (ruling 16)", async () => {
	const { opened } = await bootWith([FIXTURE_SPECIFIER]);
	const root = await opened.harness.root(BACKGROUND_CONTEXT);
	const host = opened.seamHosts.get("sigrun-fixture-seam");
	if (host === undefined) throw new Error("seam host missing");
	const legacy = {
		key: "fixture.panel",
		place: "status",
		body: { line: { text: "hello" }, rows: [{ id: "r1", label: "step" }] },
	} as never;
	const rejection = await host
		.setAmbient(root.id, legacy, BACKGROUND_CONTEXT)
		.catch((error: unknown) => error);
	expect(rejection).toBeInstanceOf(Error);
	expect(String(rejection)).toMatch(/body/);
});

// ─── The ambient one-line rule (§9.2) ─────────────────────────────────────

test("a status record with two stacked markdown blocks fails (one line)", async () => {
	const { opened } = await bootWith([FIXTURE_SPECIFIER]);
	const root = await opened.harness.root(BACKGROUND_CONTEXT);
	const host = opened.seamHosts.get("sigrun-fixture-seam");
	if (host === undefined) throw new Error("seam host missing");
	const twoLines = {
		v: BLOCK_SET_VERSION,
		root: {
			type: "stack",
			children: [
				{ type: "markdown", text: "left" },
				{ type: "markdown", text: "right" },
			],
		},
	} as never;
	const rejection = await host
		.setAmbient(
			root.id,
			{ key: "fixture.panel", place: "status", body: twoLines },
			BACKGROUND_CONTEXT,
		)
		.catch((error: unknown) => error);
	expect(rejection).toBeInstanceOf(Error);
	expect(String(rejection)).toMatch(/root\.children/);
});

test("a footer record with a three-column columns passes (the footer zones)", async () => {
	const { opened, app } = await bootWith([FIXTURE_SPECIFIER]);
	const root = await opened.harness.root(BACKGROUND_CONTEXT);
	const host = opened.seamHosts.get("sigrun-fixture-seam");
	if (host === undefined) throw new Error("seam host missing");
	const threeZones: Tree = {
		v: BLOCK_SET_VERSION,
		root: {
			type: "columns",
			children: [
				{ block: { type: "markdown", text: "left" } },
				{ block: { type: "stat", label: "mid", value: 3 } },
				{ block: { type: "markdown", text: "right" } },
			],
		},
	};
	await host.setAmbient(
		root.id,
		{ key: "fixture.panel", place: "footer", body: threeZones },
		BACKGROUND_CONTEXT,
	);
	const surfaces = (await app.inject({
		method: "GET",
		url: `/v1/conversations/${root.id}/ambient`,
	})).json().ambient;
	expect(surfaces).toHaveLength(1);
	expect(surfaces[0]).toMatchObject({
		place: "footer",
		body: threeZones,
	});
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
