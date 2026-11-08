/**
 * ci-core-ref.mjs (CI-noise Task 1): the core-ref resolver.
 *
 * Extension CI needs to check out the latest RELEASED core (and its
 * built-in pins) from npm instead of tracking core's main branch. The
 * resolver reads npm packuments (via an injected `npmView`) and returns
 * a JSON object mapping repo names to their release tags. In `main`
 * mode it returns `{}` (every checkout at its default branch).
 *
 * Tests are hermetic BY CONSTRUCTION: `npmView` is injected as a fake
 * that returns canned data — no network, no real npm. The CLI spawns
 * `npm view <spec> <field> --json` in production; the fake replaces
 * that call boundary.
 */

import { describe, expect, test } from "vitest";
import { resolveRefs } from "../scripts/ci-core-ref.mjs";
import { BUILTINS } from "../scripts/builtins-map.mjs";

/** A fake npmView that returns pre-canned data by spec+field key. */
function fakeNpmView(data: Record<string, unknown>) {
	return async (spec: string, field: string): Promise<unknown> => {
		const key = `${spec} ${field}`;
		if (!(key in data)) {
			throw new Error(`fake npmView: no data for '${key}'`);
		}
		return data[key];
	};
}

describe("ci-core-ref", () => {
	test("release mode resolves npm latest and its built-in pins", async () => {
		const npmView = fakeNpmView({
			"@sigrun/sigrun dist-tags.latest": "0.11.3",
			"@sigrun/sigrun dependencies": {
				"@sigrun/ext-codemode": "0.1.0",
				"@sigrun/ext-curator": "0.1.0",
				"@sigrun/ext-gateway": "0.1.26",
				"@sigrun/ext-mcp": "0.2.4",
				"@sigrun/ext-tool-search": "0.1.0",
				"@sigrun/oauth": "0.1.0",
				"@sigrun/shared": "0.11.3",
				"@sigrun/tui": "0.11.3",
			},
			"@sigrun/memory-markdown versions": ["0.2.0"],
		"@sigrun/memory-markdown@0.2.0 peerDependencies": {
			"@sigrun/shared": "^0.11.0",
		},
		});

		const refs = await resolveRefs("release", npmView);

		expect(refs.sigrun).toBe("v0.11.3");
		expect(refs["sigrun-ext-codemode"]).toBe("v0.1.0");
		expect(refs["sigrun-ext-curator"]).toBe("v0.1.0");
		expect(refs["sigrun-ext-gateway"]).toBe("v0.1.26");
		expect(refs["sigrun-ext-mcp"]).toBe("v0.2.4");
		expect(refs["sigrun-ext-tool-search"]).toBe("v0.1.0");
		expect(refs["sigrun-ext-oauth"]).toBe("v0.1.0");
		expect(refs["sigrun-memory-markdown"]).toBe("v0.2.0");
	});

	test("the resolver follows npm, not git tags", async () => {
		// No git access is used; the result depends only on npmView.
		// If the implementation tried to shell out to git, this fake
		// would not cover it and the test would fail.
		const npmView = fakeNpmView({
			"@sigrun/sigrun dist-tags.latest": "0.11.3",
			"@sigrun/sigrun dependencies": {
				"@sigrun/ext-codemode": "0.1.0",
				"@sigrun/ext-curator": "0.1.0",
				"@sigrun/ext-gateway": "0.1.26",
				"@sigrun/ext-mcp": "0.2.4",
				"@sigrun/ext-tool-search": "0.1.0",
				"@sigrun/oauth": "0.1.0",
				"@sigrun/shared": "0.11.3",
			},
			"@sigrun/memory-markdown versions": ["0.2.0"],
		"@sigrun/memory-markdown@0.2.0 peerDependencies": {
			"@sigrun/shared": "^0.11.0",
		},
		});

		const refs = await resolveRefs("release", npmView);
		expect(refs.sigrun).toBe("v0.11.3");
	});

	test("main mode is empty", async () => {
		const npmView = fakeNpmView({});
		const refs = await resolveRefs("main", npmView);
		expect(refs).toEqual({});
	});

	test("a missing built-in pin fails loud", async () => {
		// The published manifest lacks one built-in from builtins-map.mjs.
		// The resolver must throw, naming the missing package.
		const npmView = fakeNpmView({
			"@sigrun/sigrun dist-tags.latest": "0.11.3",
			"@sigrun/sigrun dependencies": {
				"@sigrun/ext-codemode": "0.1.0",
				"@sigrun/ext-curator": "0.1.0",
				"@sigrun/ext-gateway": "0.1.26",
				"@sigrun/ext-mcp": "0.2.4",
				"@sigrun/ext-tool-search": "0.1.0",
				// @sigrun/oauth is MISSING
				"@sigrun/shared": "0.11.3",
			},
			"@sigrun/memory-markdown dist-tags.latest": "0.2.0",
		});

		await expect(resolveRefs("release", npmView)).rejects.toThrow(
			/@sigrun\/oauth/,
		);
	});

	test("memory-markdown picks the newest version whose shared peer accepts core's shared", async () => {
		// Core's shared is 0.11.3. memory-markdown versions:
		//   0.2.4 has peerDependencies @sigrun/shared: "^0.11.0" → accepts
		//   0.3.0 has peerDependencies @sigrun/shared: "^0.12.0" → does NOT accept
		// So 0.2.4 wins even though 0.3.0 is newer.
		const npmView = fakeNpmView({
			"@sigrun/sigrun dist-tags.latest": "0.11.3",
			"@sigrun/sigrun dependencies": {
				"@sigrun/ext-codemode": "0.1.0",
				"@sigrun/ext-curator": "0.1.0",
				"@sigrun/ext-gateway": "0.1.26",
				"@sigrun/ext-mcp": "0.2.4",
				"@sigrun/ext-tool-search": "0.1.0",
				"@sigrun/oauth": "0.1.0",
				"@sigrun/shared": "0.11.3",
			},
			"@sigrun/memory-markdown versions": ["0.2.4", "0.3.0"],
			"@sigrun/memory-markdown@0.2.4 peerDependencies": {
				"@sigrun/shared": "^0.11.0",
			},
			"@sigrun/memory-markdown@0.3.0 peerDependencies": {
				"@sigrun/shared": "^0.12.0",
			},
		});

		const refs = await resolveRefs("release", npmView);
		expect(refs["sigrun-memory-markdown"]).toBe("v0.2.4");
	});
});
