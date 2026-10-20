/**
 * Test-fixture extension package (core hardening W5 Task 3 — extension
 * slash commands): declares `hello` (returns `{notice: "hi " + args}`) and
 * `new` (a CORE-name collision — the catalog builder drops it with one
 * warning and does NOT record it in `collisions.commands`).
 *
 * Plain JavaScript so `import(specifier)` resolves it directly (the
 * fixture-routes pattern). Contract: the default export is an arity-1
 * factory returning `{ extension, commands }` — the `commands` field is
 * the W5 Task 3 factory-result contract (`ExtensionCommandContribution`).
 */

import { defineExtension } from "@earendil-works/pi-durable";

export default function createFixtureCommands(host) {
	void host;
	return {
		extension: defineExtension({ name: "fixture-commands" }),
		commands: [
			{
				name: "hello",
				description: "Say hello",
				args: "<name>",
				run: async ({ args }) => ({ notice: "hi " + args }),
			},
			{
				name: "new",
				description: "A core-name collision (dropped at catalog build)",
				run: async () => ({}),
			},
		],
	};
}
