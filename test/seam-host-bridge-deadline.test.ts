/**
 * The seam host's pre-bind bridge bound (final review fix wave,
 * adjudication 2A, revised by polish A1/spec §5.2): every
 * bridge-forwarding member (`conversations`/`users`/`accounts`/`access`/
 * `identity`/`curation`/`models`/`commands`) awaits the host bridge,
 * which `createServer` binds at boot. When a server is EXPECTED
 * (`expectBridge`, fanned out from `createServer`'s entry or the
 * `expectHostBridge: true` open option), a call on a never-bound host
 * rejects within the deadline with a loud error naming the member and
 * asking whether createServer is running. When NO server is expected
 * (the serverless-embed default), the same call rejects IMMEDIATELY
 * with `HostBridgeUnavailableError`.
 *
 * Focused unit shape: a directly constructed seam host over a resolved
 * (never-bound) bridge, fake timers advancing the deadline. No boot, no
 * server — the suite stays fast.
 */

import { afterAll, expect, test, vi } from "vitest";
import type { Harness } from "@earendil-works/pi-durable";
import {
	createSeamHost,
	HostBridgeUnavailableError,
} from "../src/harness/seam-host.js";
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
function neverBoundHost(options: { expected?: boolean } = {}) {
	const host = createSeamHost(
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
	// The deadline cases pin the EXPECTED shape (a server will bind);
	// the default (no expectation) is the immediate-reject case below.
	if (options.expected === true) host.expectBridge();
	return host;
}

test("a never-bound host member rejects IMMEDIATELY when no server is expected", async () => {
	const host = neverBoundHost();
	const pending = host.users.list();
	const assertion = expect(pending).rejects.toThrow(HostBridgeUnavailableError);
	await assertion;
	const error = await host.users.list().catch((one: unknown) => one);
	expect(error).toBeInstanceOf(HostBridgeUnavailableError);
	expect((error as HostBridgeUnavailableError).member).toBe("users.list");
	expect((error as HostBridgeUnavailableError).caller).toBe("fixture.deadline");
});

test("a never-bound host member rejects at the deadline, naming the member", async () => {
	const host = neverBoundHost({ expected: true });
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
	const host = neverBoundHost({ expected: true });
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	try {
		// A pre-bind member read returns a forwarder; SYNC store members
		// (`overlays`) return the lazy store whose METHOD waits on the
		// bounded bridge promise.
		const pending = host.curation.overlays("alice").list();
		const assertion = expect(pending).rejects.toThrow(/curation/);
		await vi.advanceTimersByTimeAsync(BRIDGE_DEADLINE_MS);
		await assertion;
	} finally {
		vi.useRealTimers();
	}
});

test("pre-bind curation.skills(user) is a STORE (methods callable, deadline-bounded)", async () => {
	const host = neverBoundHost({ expected: true });
	const store = host.curation.skills("alice");
	// The sync-return contract: the store comes back at once (not a
	// promise) and every method is a function.
	expect(typeof store).toBe("object");
	expect(typeof store.list).toBe("function");
	expect(typeof store.view).toBe("function");
	// A method call waits on the bridge and rejects at the bind deadline,
	// naming the surface (the eval idle-pass regression: `.list` used to
	// be undefined on a promise-of-store).
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	try {
		const pending = store.list();
		const assertion = expect(pending).rejects.toThrow(/curation|bridge never bound/s);
		await vi.advanceTimersByTimeAsync(BRIDGE_DEADLINE_MS);
		await assertion;
	} finally {
		vi.useRealTimers();
	}
	// Same shape for overlays.
	const overlays = host.curation.overlays("alice");
	expect(typeof overlays.list).toBe("function");
});

test("a late bind still wins: the same member resolves once the bridge lands", async () => {
	const host = neverBoundHost({ expected: true });
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
