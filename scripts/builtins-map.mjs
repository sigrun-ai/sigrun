/**
 * builtins-map.mjs: the single enumeration of the built-in extensions
 * and the sibling checkout each one lives in.
 *
 * ALL SIX ship in core — this map is the single list every other
 * enumeration (the workflows' checkouts, the lock regen, the image
 * smoke's resolve list, the CI core-ref resolver) derives from, so a
 * new built-in lands here ONCE (test/builtins-wiring.test.ts asserts
 * the enumerations agree).
 *
 * Extracted from publish-deps.mjs so that read-only consumers (the
 * CI core-ref resolver) can import it without triggering that script's
 * top-level argv parsing and process.exit.
 */
export const BUILTINS = {
	"@sigrun/ext-codemode": "../sigrun-ext-codemode",
	"@sigrun/ext-curator": "../sigrun-ext-curator",
	"@sigrun/ext-gateway": "../sigrun-ext-gateway",
	"@sigrun/ext-mcp": "../sigrun-ext-mcp",
	"@sigrun/ext-tool-search": "../sigrun-ext-tool-search",
	"@sigrun/oauth": "../sigrun-ext-oauth",
};
