/**
 * `@sigrun/sigrun/blocks` — the extension authoring surface for the
 * block set (spec §14.1): the typed builders, the wire types, and
 * `validateTree` (§14.2) so an extension can unit-test its trees
 * against the same validation the server runs.
 *
 * Extensions import this subpath, never a bundled copy: the package is
 * a `peerDependency: "*"` (see docs/extending.md) and
 * `@sigrun/sigrun` is a HOST RUNTIME MODULE (src/harness/packages.ts)
 * — the host links its own running copy into every extension packages
 * dir, so `tree(...)` always stamps the server's
 * {@link BLOCK_SET_VERSION}. The `exports` map points here at
 * `dist/blocks/index.js` (never `src/`), which is what the built
 * server ships.
 */

export * from "./builders.js";
export {
	validateTree,
	validateData,
	VALID_PLACEMENTS,
	PLACEMENT_RULES,
	LIMITS,
} from "./validate.js";
export type {
	PlacementLimits,
	PlacementRule,
	ValidateDataResult,
	ValidateErr,
	ValidateOk,
	ValidateOptions,
	ValidateResult,
	ValidationError,
} from "./validate.js";

// The wire contract (§4/§5/§6.1) and the block-set version constant,
// verbatim from the shared leaf — one import site for extension code.
export { BLOCK_SET_VERSION } from "@sigrun/shared/blocks";
export type * from "@sigrun/shared/blocks";
