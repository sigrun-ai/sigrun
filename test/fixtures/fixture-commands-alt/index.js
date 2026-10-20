/**
 * Test-fixture extension package (core hardening W5 Task 3 — the
 * ext-vs-ext command collision): declares `hello` again. Loaded AFTER
 * fixture-commands, its registration WINS the merged catalog
 * (last-registered-wins) and the collision is recorded in `/v1/meta`
 * `collisions.commands` with `{previous: "fixture-commands",
 * contributor: "fixture-commands-alt"}`.
 *
 * The notice is deliberately distinct from fixture-commands' ("alt
 * greets …") so the winning binding is observable through the invoke
 * route on the two-fixture server.
 */

import { defineExtension } from "@earendil-works/pi-durable";

export default function createFixtureCommandsAlt() {
	return {
		extension: defineExtension({ name: "fixture-commands-alt" }),
		commands: [
			{
				name: "hello",
				description: "Say hello (alt)",
				run: async ({ args }) => ({ notice: "alt greets " + args }),
			},
		],
	};
}
