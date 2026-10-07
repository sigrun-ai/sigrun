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
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
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

/**
 * The fixture's capture scenario, replayed exactly: faux `faux/m` model,
 * empty workspace (so the only rendered section is the no-op memory
 * placeholder), root conversation, one settled turn.
 *
 * Returns the live view's shape.
 */
async function captureLiveShape(): Promise<Shape> {
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
	try {
		const config = loadConfig({
			SIGRUN_MODEL: "faux/m",
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
			const shape = captureViewShape(viewState.value);
			await viewState.dispose();
			return shape;
		} finally {
			await opened.harness.close(BACKGROUND_CONTEXT);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
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
