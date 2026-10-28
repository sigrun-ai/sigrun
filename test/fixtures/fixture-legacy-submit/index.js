/**
 * Test-fixture extension package: the MINIMAL vehicle for the loader's
 * one-warning retirement pin (test/loader.test.ts: "a factory result
 * carrying submit loads ok and warns").
 *
 * Core hardening §6.7 retired the loader's `submit` pass-through surface.
 * A factory result still carrying one must NOT quarantine (old packages
 * keep loading): it is ignored with exactly one warning naming the
 * extension slug. This fixture exists ONLY to carry that retired
 * `{ extension, submit }` shape — deliberately separate from
 * fixture-memory, which mirrors the CURRENT per-conversation memory
 * contract and must not keep the retired shape alive.
 *
 * Plain JavaScript so `import(specifier)` resolves it directly — the same
 * dynamic-import path the loader uses for installed packages.
 */

import { defineExtension } from "@earendil-works/pi-durable";

export default function createFixtureLegacySubmit() {
	return {
		extension: defineExtension({ name: "sigrun-fixture-legacy-submit" }),
		// The retired pass-through: present but ignored by the loader.
		async submit(root, submission, context) {
			return await root.submit(submission, context);
		},
	};
}
