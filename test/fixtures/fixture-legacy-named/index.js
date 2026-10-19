/**
 * Test-fixture extension package (core hardening §6.7): the PRE-CONTRACT
 * package shape — a named `createMemory` factory export (no default
 * export) whose factory result still carries a `submit` pass-through.
 *
 * Loading it must SUCCEED (never quarantined) while logging BOTH
 * deprecation warnings: the named-export bridge warning and the
 * retired-submit warning. Deletion of the bridge is the next release;
 * until then old packages keep loading.
 *
 * Plain JavaScript so `import(specifier)` resolves it directly — the
 * same dynamic-import path the loader uses for installed packages.
 */

import { defineExtension } from "@earendil-works/pi-durable";

/** Named-export factory (the pre-contract bridge form). */
export function createMemory() {
	return {
		extension: defineExtension({
			name: "sigrun-legacy-named",
			hooks: [],
			tools: [],
			sections: [],
		}),
		// The retired submit pass-through: present-but-ignored, warned once.
		submit: async (conversation, submission, context) =>
			conversation.submit(submission, context),
	};
}
