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

function coreDependencies(overrides: Record<string, string> = {}) {
	return {
		"@sigrun/ext-codemode": "0.1.0",
		"@sigrun/ext-curator": "0.1.0",
		"@sigrun/ext-gateway": "0.1.26",
		"@sigrun/ext-mcp": "0.2.4",
		"@sigrun/ext-tool-search": "0.1.0",
		"@sigrun/oauth": "0.1.0",
		"@sigrun/shared": "0.11.3",
		"@sigrun/tui": "0.11.3",
		...overrides,
	};
}

function releaseFixture(overrides: Record<string, unknown> = {}) {
	return {
		"@sigrun/sigrun dist-tags.latest": "0.11.3",
		"@sigrun/sigrun@0.11.3 dependencies": coreDependencies(),
		"@sigrun/memory-markdown versions": ["0.2.0"],
		"@sigrun/memory-markdown@0.2.0 peerDependencies": {
			"@sigrun/shared": "^0.11.0",
		},
		...overrides,
	};
}

describe("ci-core-ref", () => {
	test("release mode resolves npm latest and its built-in pins", async () => {
		const refs = await resolveRefs("release", fakeNpmView(releaseFixture()));

		expect(refs).toEqual({
			sigrun: "v0.11.3",
			"sigrun-ext-codemode": "v0.1.0",
			"sigrun-ext-curator": "v0.1.0",
			"sigrun-ext-gateway": "v0.1.26",
			"sigrun-ext-mcp": "v0.2.4",
			"sigrun-ext-tool-search": "v0.1.0",
			"sigrun-ext-oauth": "v0.1.0",
			"sigrun-memory-markdown": "v0.2.0",
		});
	});

	test("the resolver follows npm, not git tags", async () => {
		const first = await resolveRefs("release", fakeNpmView(releaseFixture()));
		const second = await resolveRefs(
			"release",
			fakeNpmView(
				releaseFixture({
					"@sigrun/sigrun dist-tags.latest": "0.12.0",
					"@sigrun/sigrun@0.12.0 dependencies": coreDependencies({
						"@sigrun/ext-gateway": "0.2.0",
					}),
				}),
			),
		);

		expect(first.sigrun).toBe("v0.11.3");
		expect(first["sigrun-ext-gateway"]).toBe("v0.1.26");
		expect(second.sigrun).toBe("v0.12.0");
		expect(second["sigrun-ext-gateway"]).toBe("v0.2.0");
	});

	test("main mode is empty", async () => {
		const refs = await resolveRefs("main", fakeNpmView({}));
		expect(refs).toEqual({});
	});

	test("an unknown mode fails loud", async () => {
		await expect(resolveRefs("latest" as "main", fakeNpmView({}))).rejects.toThrow(
			/unknown mode.*latest/,
		);
	});

	test("a missing built-in pin fails loud", async () => {
		const dependencies = coreDependencies();
		delete (dependencies as Record<string, string>)["@sigrun/oauth"];
		const npmView = fakeNpmView(
			releaseFixture({ "@sigrun/sigrun@0.11.3 dependencies": dependencies }),
		);

		await expect(resolveRefs("release", npmView)).rejects.toThrow(
			/@sigrun\/oauth/,
		);
	});

	test("a non-version built-in pin fails loud", async () => {
		const npmView = fakeNpmView(
			releaseFixture({
				"@sigrun/sigrun@0.11.3 dependencies": coreDependencies({
					"@sigrun/ext-gateway": "^0.1.26",
				}),
			}),
		);

		await expect(resolveRefs("release", npmView)).rejects.toThrow(
			/@sigrun\/ext-gateway.*\^0\.1\.26/,
		);
	});

	test("memory-markdown picks the newest version whose shared peer accepts core's shared", async () => {
		const npmView = fakeNpmView(
			releaseFixture({
				"@sigrun/memory-markdown versions": ["0.2.4", "0.3.0"],
				"@sigrun/memory-markdown@0.2.4 peerDependencies": {
					"@sigrun/shared": "^0.11.0",
				},
				"@sigrun/memory-markdown@0.3.0 peerDependencies": {
					"@sigrun/shared": "^0.12.0",
				},
			}),
		);

		const refs = await resolveRefs("release", npmView);
		expect(refs["sigrun-memory-markdown"]).toBe("v0.2.4");
	});

	test("memory-markdown skips a version with no peerDependencies", async () => {
		const npmView = fakeNpmView(
			releaseFixture({
				"@sigrun/memory-markdown versions": ["0.2.4", "0.3.0"],
				"@sigrun/memory-markdown@0.2.4 peerDependencies": {
					"@sigrun/shared": "^0.11.0",
				},
				"@sigrun/memory-markdown@0.3.0 peerDependencies": undefined,
			}),
		);

		const refs = await resolveRefs("release", npmView);
		expect(refs["sigrun-memory-markdown"]).toBe("v0.2.4");
	});

	test("memory-markdown sorts releases and skips prereleases", async () => {
		const npmView = fakeNpmView(
			releaseFixture({
				"@sigrun/memory-markdown versions": [
					"0.10.0",
					"0.3.0-rc.1",
					"0.2.4",
				],
				"@sigrun/memory-markdown@0.2.4 peerDependencies": {
					"@sigrun/shared": "^0.11.0",
				},
				"@sigrun/memory-markdown@0.10.0 peerDependencies": {
					"@sigrun/shared": "^0.11.0",
				},
			}),
		);

		const refs = await resolveRefs("release", npmView);
		expect(refs["sigrun-memory-markdown"]).toBe("v0.10.0");
	});
});
