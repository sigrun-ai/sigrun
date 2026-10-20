/**
 * Test-fixture extension package (core hardening W5 Task 5 — host
 * conversation/identity/users/access APIs): a channel-bridge-shaped
 * factory that captures the seam host and exposes the test's drive
 * surface. Plain JavaScript so `import(specifier)` resolves it directly
 * (the fixture-routes pattern). Contract: the default export is an
 * arity-1 factory returning `{ extension }`.
 *
 * Retrieval is the existing test trick (fixture-seam/fixture-stores):
 * the factory stashes the host on `globalThis.__fixtureChannelHost`
 * because the loader's `import()` and a test's static import may run in
 * different module instances — globalThis is the one shared address
 * space. `drive()` reads the stash through a module-level fast path
 * with the globalThis fallback, so it works either way.
 *
 * The factory ALSO kicks off one `host.conversations.list()` call in
 * its own body (never awaited) and records it on
 * `globalThis.__fixtureChannelEarly`: the seam binding contract says a
 * conversations call made before the boot completes must WAIT (the
 * bridge only binds at `createServer` time) — the test asserts the
 * probe is still pending after `openHarness` resolves, and settles
 * once the server exists.
 */

import { defineExtension } from "@earendil-works/pi-durable";

let stashedHost = undefined;

export default function createFixtureChannel(host) {
	if (host === undefined) {
		throw new Error("channel fixture requires the host context");
	}
	stashedHost = host;
	globalThis.__fixtureChannelHost = host;
	// The factory-body call (the seam binding contract probe): started
	// here, never awaited — factories run inside loadExtensions, and a
	// host.conversations call must not resolve before the boot completes
	// and the server binds the host bridge.
	const early = host.conversations.list();
	const probe = { settled: false, promise: early };
	globalThis.__fixtureChannelEarly = probe;
	early.then(
		() => {
			probe.settled = true;
		},
		() => {
			probe.settled = true;
		},
	);
	return {
		extension: defineExtension({ name: "fixture-channel" }),
	};
}

/**
 * The channel drive: create a conversation owned by "alice" (the source
 * defaults to the calling extension's slug), submit "hello", return the
 * conversation id. Exported at module level AND stashed on
 * `globalThis.__fixtureChannelDrive` (set by the factory) so a test
 * reaches it regardless of module-instance identity.
 */
export async function drive() {
	const host = stashedHost ?? globalThis.__fixtureChannelHost;
	if (host === undefined) {
		throw new Error("fixture-channel: drive() before the factory ran");
	}
	const id = await host.conversations.create({ owner: "alice" });
	await host.conversations.submit(id, [{ type: "text", text: "hello" }]);
	return id;
}

globalThis.__fixtureChannelDrive = drive;
