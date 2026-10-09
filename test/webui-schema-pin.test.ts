/**
 * The webui schema-pin drift guard (Task 25, spec §5 fail-loud).
 *
 * The webui refuses to render when the server's `GET /v1/meta`
 * `schemaVersion` differs from the bundle's pinned copy. The webui is a
 * separate workspace package and CANNOT import `src/server/schema-fixture.ts`
 * (NodeNext vs bundler resolution), so the pin is a hard-coded constant in
 * `webui/src/schema-version.ts`. THIS test is the sync mechanism: it reads
 * the webui source file, extracts the pinned hash, and asserts it equals the
 * server's computed {@link SCHEMA_VERSION}. Schema-fixture drift therefore
 * fails the ROOT suite loudly — the fix is to re-pin the webui constant (and
 * ship a matching bundle rebuild).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { SCHEMA_VERSION } from "../src/server/schema-fixture.js";

const WEBUI_PIN = join(
	import.meta.dirname,
	"..",
	"webui",
	"src",
	"schema-version.ts",
);

test("the webui's pinned schemaVersion equals the server's SCHEMA_VERSION", () => {
	const source = readFileSync(WEBUI_PIN, "utf8");
	const match = /PINNED_SCHEMA_VERSION\s*=\s*"([0-9a-f]{64})"/.exec(source);
	expect(
		match,
		"webui/src/schema-version.ts must export PINNED_SCHEMA_VERSION as a 64-hex literal",
	).not.toBeNull();
	expect(match![1]).toBe(SCHEMA_VERSION);
});
