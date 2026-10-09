/**
 * The webui's pinned §5 schema version (Task 25, spec §5 fail-loud).
 *
 * `GET /v1/meta` serves the server's `schemaVersion` — the sha256 of the
 * captured view-schema fixture (`src/server/schema-fixture.ts`,
 * `SCHEMA_VERSION`, computed from the fixture at module load). The webui
 * refuses to render when the served hash differs from this pinned copy: a
 * mismatch means the bundle was built against a different wire shape than
 * the server speaks, and rendering would misread the contract.
 *
 * THE SYNC MECHANISM: the webui is a separate workspace package and cannot
 * import the server sources (NodeNext vs bundler resolution), so the pin is
 * this hard-coded literal. The ROOT test `test/webui-schema-pin.test.ts`
 * reads this file, extracts the literal, and asserts it equals the server's
 * computed SCHEMA_VERSION — schema-fixture drift fails the root suite
 * loudly, and the fix is to re-pin this constant and rebuild the bundle.
 * Keep the value a bare 64-hex literal on the `=` line so the guard's regex
 * can extract it.
 */
export const PINNED_SCHEMA_VERSION =
	"5de4936712b52c5d0a6f49e01dae042b74e115844f1f8f0a24ffd02a473e3589";
