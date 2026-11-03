/**
 * Task 5 (polish pass, spec §5.1): the model breadcrumb.
 *
 * `@sigrun/shared/model-label` turns a message's `provider` + `model`
 * into the two strings a client shows: `short` (the transcript meta —
 * every path segment except the leaf collapsed to its first character)
 * and `full` (the untruncated id, for a hover `title`). The provider is
 * ALWAYS a segment (user ruling): `openai` + `gpt-4o-mini` reads
 * `o/gpt-4o-mini`, an old bifrost chain message (bare `acme-flash`)
 * reads `b/acme-flash`, a new one (`chain/acme-flash`) `b/c/acme-flash`.
 * A message with no provider shows its plain model name — the archive's
 * older rows have no provider to name.
 *
 * The odd-id cases (Review Focus 2): no provider, a model id that
 * already carries its provider prefix, empty segments, and a
 * single-segment id. Expected: no duplicated provider, no empty
 * breadcrumb segments, and the plain name when there is nothing to
 * collapse. Fixtures are synthetic (tests own their literals).
 */

import { describe, expect, it } from "vitest";
import { modelBreadcrumb } from "@sigrun/shared/model-label";

describe("modelBreadcrumb", () => {
	it("collapses the chain path and prefixes the provider", () => {
		expect(modelBreadcrumb("bifrost", "chain/acme-flash")).toEqual({
			short: "b/c/acme-flash",
			full: "bifrost/chain/acme-flash",
		});
	});

	it("a bare chain name (an old message) keeps its whole leaf under the provider", () => {
		expect(modelBreadcrumb("bifrost", "acme-flash")).toEqual({
			short: "b/acme-flash",
			full: "bifrost/acme-flash",
		});
	});

	it("a first-party model id with no path collapses to the provider plus the leaf", () => {
		expect(modelBreadcrumb("openai", "gpt-4o-mini")).toEqual({
			short: "o/gpt-4o-mini",
			full: "openai/gpt-4o-mini",
		});
	});

	it("no provider shows the plain model name (absent and empty alike)", () => {
		expect(modelBreadcrumb(undefined, "acme-flash")).toEqual({
			short: "acme-flash",
			full: "acme-flash",
		});
		expect(modelBreadcrumb("", "acme-flash")).toEqual({
			short: "acme-flash",
			full: "acme-flash",
		});
	});

	it("a model id already carrying its provider never duplicates it", () => {
		expect(modelBreadcrumb("bifrost", "bifrost/chain/x")).toEqual({
			short: "b/c/x",
			full: "bifrost/chain/x",
		});
	});

	it("empty segments are dropped from both strings", () => {
		expect(modelBreadcrumb("acme", "a//b/")).toEqual({
			short: "a/a/b",
			full: "acme/a/b",
		});
	});

	it("a single-segment model under a provider keeps the leaf whole", () => {
		expect(modelBreadcrumb("synthetic", "acme-model")).toEqual({
			short: "s/acme-model",
			full: "synthetic/acme-model",
		});
	});

	it("a model id that is only the provider shows the provider alone", () => {
		expect(modelBreadcrumb("bifrost", "bifrost/")).toEqual({
			short: "b",
			full: "bifrost",
		});
	});
});
