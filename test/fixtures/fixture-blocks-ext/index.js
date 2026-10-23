/**
 * Test-fixture extension package (UI-blocks U0 Task 4): exercises the
 * §14.1 authoring path end to end — the factory imports the builders
 * from `@sigrun/sigrun/blocks` and returns a block tree stamped with
 * the HOST's BLOCK_SET_VERSION.
 *
 * The manifest declares `@sigrun/sigrun` a `peerDependency: "*"` (never
 * a dependency): npm installs a tarball without solving peers (the
 * packages sync runs --legacy-peer-deps), so the bare import resolves
 * through the packages dir's host-module link — the SAME running
 * package the server validates trees with. Plain JavaScript so
 * `import(specifier)` resolves it without a build step.
 */

import { BLOCK_SET_VERSION, page, markdown, tree } from "@sigrun/sigrun/blocks";

/** The tree this fixture reports (built with the host's own builders). */
export const builtTree = tree(
	page({ title: "Fixture", main: [markdown({ text: "fixture blocks body" })] }),
);

/** The version constant as resolved through the host link. */
export const linkedBlockSetVersion = BLOCK_SET_VERSION;

export default function createBlocksFixture() {
	return {
		extension: {
			name: "sigrun-fixture-blocks-ext",
			hooks: [],
			tools: [],
			sections: [],
		},
		builtTree,
		linkedBlockSetVersion,
	};
}
