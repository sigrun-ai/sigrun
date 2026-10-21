/**
 * The upstream-drift tripwire (spec §5 "Captured schema", Task 9a Step 1).
 *
 * Three artifacts must agree:
 *
 * 1. `test/fixtures/view-schema.json` — the committed capture of a real
 *    ConversationView's shape (keys + value types, never values),
 * 2. `VIEW_SCHEMA` in `src/server/schema-fixture.ts` — the same shape as an
 *    embedded literal (what `SCHEMA_VERSION` hashes),
 * 3. a LIVE ConversationView re-captured from the same deterministic
 *    hermetic scenario (root conversation, one settled faux turn, empty
 *    workspace).
 *
 * Any disagreement fails: a pi-durable upgrade that adds, removes, or
 * retypes a view field shows up here as a test failure, not a runtime
 * surprise — and `GET /v1/meta`'s schemaVersion (the sha256 of the fixture)
 * changes with it, so a compiled webui refuses to render against a drifted
 * server.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationView } from "@earendil-works/pi-durable";
import {
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { loadConfig } from "../src/config.js";
import { openHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import {
	SCHEMA_VERSION,
	VIEW_SCHEMA,
	canonicalJson,
	captureViewShape,
	type Shape,
} from "../src/server/schema-fixture.js";
import { serializeConversationView } from "../src/server/views.js";

/**
 * The fixture's capture scenario, replayed exactly: faux `faux/m` model,
 * empty workspace (core sections only — identity, persona, the no-op
 * memory placeholder), root conversation, one settled turn. Task 2's
 * built-ins ARE part of the capture — the fixture describes what a DEFAULT
 * install renders (the `codemode` section and the built-ins' tools are the
 * live shape). The MCP built-in reads `process.env.SIGRUN_MCP_CONFIG` →
 * `~/.config/sigrun/mcp.json` directly (no boot-env seam — the recorded
 * known limitation), so the capture pins it to THIS tmpdir's empty
 * registry: hermetic against any workstation mcp.json (a real registry
 * would spawn servers and add their tools to the captured
 * `toolsAdded` variants).
 */
async function captureLiveView(): Promise<ConversationView> {
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	faux.setResponses([fauxAssistantMessage("hello answer")]);
	const contributor: ProviderContributor = {
		name: "ext-faux",
		providers: [{ provider: faux.provider }],
	};
	const dir = await mkdtemp(join(tmpdir(), "sigrun-schema-"));
	const mcpPath = join(dir, "mcp.json");
	await writeFile(mcpPath, JSON.stringify({ servers: {} }), "utf8");
	const savedMcpConfig = process.env.SIGRUN_MCP_CONFIG;
	process.env.SIGRUN_MCP_CONFIG = mcpPath;
	try {
		const config = loadConfig({
			SIGRUN_DEFAULT_MODEL: "faux/m",
			SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
			SIGRUN_WORKSPACE_PATH: dir,
		});
		const opened = await openHarness(config, {
			extensions: [contributor],
			env: {},
		});
		try {
			const root = await opened.harness.root(BACKGROUND_CONTEXT, {
				agent: { model: opened.defaultModel },
			});
			const submission = await root.submit(
				{ type: "input", content: "hello" },
				BACKGROUND_CONTEXT,
			);
			await submission.wait(BACKGROUND_CONTEXT);
			const viewState = await root.viewState(BACKGROUND_CONTEXT);
			const view = viewState.value;
			await viewState.dispose();
			return view;
		} finally {
			await opened.harness.close(BACKGROUND_CONTEXT);
		}
	} finally {
		if (savedMcpConfig === undefined) delete process.env.SIGRUN_MCP_CONFIG;
		else process.env.SIGRUN_MCP_CONFIG = savedMcpConfig;
		await rm(dir, { recursive: true, force: true });
	}
}

/** The live view's structural shape (the capture scenario above). */
async function captureLiveShape(): Promise<Shape> {
	return captureViewShape(await captureLiveView());
}

test("the committed fixture file matches the embedded VIEW_SCHEMA", async () => {
	const path = fileURLToPath(
		new URL("./fixtures/view-schema.json", import.meta.url),
	);
	const fixture = JSON.parse(await readFile(path, "utf8")) as Shape;
	expect(fixture).toEqual(VIEW_SCHEMA);
});

test("a live ConversationView's shape still matches the fixture", async () => {
	const live = await captureLiveShape();
	expect(live).toEqual(VIEW_SCHEMA);
});

test("the wire view is the upstream view plus exactly the steer key (T9d)", async () => {
	// The fixture pins the UPSTREAM ConversationView; serializeConversationView
	// adds sigrun's derived steer field on top (it is a sigrun-side projection,
	// NOT upstream drift). The wire is exactly view + steer — nothing else.
	const live = await captureLiveView();
	const wire = serializeConversationView(live);
	expect(wire).toEqual({ ...live, steer: { busy: false, queued: 0 } });
	expect(Object.keys(wire).sort()).toEqual(
		[...Object.keys(live), "steer"].sort(),
	);
	// And the upstream subobject is untouched: spreading did not project it.
	expect(wire.conversation).toBe(live.conversation);
	expect(wire.entries).toBe(live.entries);
	expect(wire.docs).toBe(live.docs);
});

test("SCHEMA_VERSION is the sha256 of the fixture's canonical JSON", () => {
	const expected = createHash("sha256")
		.update(canonicalJson(VIEW_SCHEMA))
		.digest("hex");
	expect(SCHEMA_VERSION).toBe(expected);
});

test("a shape change changes the canonical JSON (drift moves the hash)", () => {
	const captured = VIEW_SCHEMA as Extract<Shape, { kind: "object" }>;
	const conversation = captured.fields.conversation as Extract<
		Shape,
		{ kind: "object" }
	>;
	const mutated: Shape = {
		...captured,
		fields: {
			...captured.fields,
			conversation: {
				kind: "object",
				fields: {
					...conversation.fields,
					title: { kind: "string" },
				},
			},
		},
	};
	expect(canonicalJson(mutated)).not.toBe(canonicalJson(VIEW_SCHEMA));
});
