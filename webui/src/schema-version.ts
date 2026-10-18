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
 * THE SYNC MECHANISM: the pin is a hard-coded literal. Importing the
 * server's runtime constant would pin the client to whatever the BUILD
 * machine resolved — the point is a fixed pin a drift guard compares the
 * server against, so the value stays a literal by design. The ROOT test
 * `test/webui-schema-pin.test.ts` reads this file, extracts the literal,
 * and asserts it equals the server's
 * computed SCHEMA_VERSION — schema-fixture drift fails the root suite
 * loudly, and the fix is to re-pin this constant and rebuild the bundle.
 * Keep the value a bare 64-hex literal on the `=` line so the guard's regex
 * can extract it.
 */
export const PINNED_SCHEMA_VERSION =
	"8a10509d8decf282cfbd247143aa75ff8494356960734818ca29b314bb17c1b6";
