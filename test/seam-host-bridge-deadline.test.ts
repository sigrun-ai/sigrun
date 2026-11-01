/**
 * The seam host's pre-bind bridge bound (final review fix wave,
 * adjudication 2A): every bridge-forwarding member (`conversations`/
 * `users`/`accounts`/`access`/`identity`/`curation`/`models`/`commands`)
 * awaits the host bridge, which `createServer` binds at boot. An embed
 * that never starts a server would otherwise await an eternally pending
 * promise — the jobs-task fake-clock hang's root. The pin: a call on a
 * NEVER-bound host rejects within the deadline with a loud error naming
 * the member and asking whether createServer is running.
 *
 * Focused unit shape: a directly constructed seam host over a resolved
 * (never-bound) bridge, fake timers advancing the deadline. No boot, no
 * server — the suite stays fast.
 */

import { afterAll, expect, test, vi } from "vitest";
import type { Harness } from "@earendil-works/pi-durable";
import { createSeamHost } from "../src/harness/seam-host.js";
import { sharedExtensionStores, type StoreRoots } from "../src/harness/stores.js";
import type { HostBridge } from "../src/server/host-bridge.js";

/** The bind deadline the seam host arms on every bridge wait. */
const BRIDGE_DEADLINE_MS = 60_000;

/** Minimal store roots (the scoped-stores view only joins paths). */
const ROOTS: StoreRoots = {
	configDir: "/tmp/sigrun-deadline-test/config",
	dataDir: "/tmp/sigrun-deadline-test/data",
	cacheDir: "/tmp/sigrun-deadline-test/cache",
	stateDir: "/tmp/sigrun-deadline-test/state",
};

/** A seam host whose bridge is NEVER bound (the serverless-embed shape). */
function neverBoundHost() {
	return createSeamHost(
		{ name: "fixture.deadline" },
		{},
		{
			bindHarness: () => {},
			// The harness "opens" (the call passes that gate) but no bridge
			// ever binds: the forwarder must reject, not hang.
			harness: () => Promise.resolve({} as unknown as Harness),
		},
		sharedExtensionStores(ROOTS),
	);
}

test("a never-bound host member rejects at the deadline, naming the member", async () => {
	const host = neverBoundHost();
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	try {
		const pending = host.users.list();
		const assertion = expect(pending).rejects.toThrow(
			/users\.list.*bridge never bound.*createServer running/s,
		);
		await vi.advanceTimersByTimeAsync(BRIDGE_DEADLINE_MS);
		await assertion;
	} finally {
		vi.useRealTimers();
	}
});

test("the curation proxy's pre-bind forwarders reject the same way", async () => {
	const host = neverBoundHost();
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	try {
		// A pre-bind member read returns an async forwarder; calling it
		// waits on the same bounded bridge promise.
		const pending = host.curation.overlays("alice");
		const assertion = expect(pending).rejects.toThrow(/curation/);
		await vi.advanceTimersByTimeAsync(BRIDGE_DEADLINE_MS);
		await assertion;
	} finally {
		vi.useRealTimers();
	}
});

test("a late bind still wins: the same member resolves once the bridge lands", async () => {
	const host = neverBoundHost();
	// Bind a minimal bridge BEFORE the deadline passes (production shape:
	// createServer binds at boot).
	const bridge = {
		users: { list: () => Promise.resolve([]) },
	} as unknown as HostBridge;
	host.bindBridge(bridge);
	await expect(host.users.list()).resolves.toEqual([]);
});

afterAll(() => {
	vi.useRealTimers();
});
