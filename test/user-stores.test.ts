/**
 * Multi-user M2 Task 2: per-user extension stores.
 *
 * The real seam host scopes the shared store roots to one extension and
 * one directory user. Secret writes are atomic 0600 files with one
 * top-level section per slug; settings and raw paths are per-user too.
 * The only unknown-user exception is the explicit, bounded deletion
 * window used by userDeleted fan-out.
 */

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { UserDirectory } from "../src/harness/identity/users.js";
import { RESERVED_EXTENSION_SLUGS } from "../src/harness/reserved-sections.js";
import { createSeamHost, type SeamHost } from "../src/harness/seam-host.js";
import {
	beginUserDeletion,
	sharedExtensionStores,
	type StoreRoots,
} from "../src/harness/stores.js";

let base: string;
let users: UserDirectory;
let host: SeamHost;
let roots: StoreRoots;

beforeEach(async () => {
	base = await mkdtemp(join(tmpdir(), "sigrun-user-stores-"));
	users = new UserDirectory(join(base, "users.json"));
	await users.add({ user: "alice", admin: false, source: "cli" });
	await users.add({ user: "bob", admin: false, source: "cli" });
	roots = {
		configDir: join(base, "config"),
		dataDir: join(base, "data"),
		stateDir: join(base, "state"),
		cacheDir: join(base, "cache"),
	};
	const shared = sharedExtensionStores(roots, {}, users);
	host = createSeamHost(
		{ name: "acme" },
		{},
		{
			bindHarness: () => {},
			harness: () => Promise.reject(new Error("not used by store tests")),
		},
		shared,
	);
});

afterEach(async () => {
	await rm(base, { recursive: true, force: true });
});

test("layout for alice/acme; every raw path is created on first access only", async () => {
	const stores = host.stores.user("alice");
	const paths = {
		data: join(roots.dataDir, "acme", "users", "alice"),
		state: join(roots.stateDir, "acme", "users", "alice"),
		cache: join(roots.cacheDir, "acme", "users", "alice"),
	};

	// Resolving the handle creates nothing. Each getter creates exactly
	// its own directory, including data/state (unlike the shared handle).
	for (const path of Object.values(paths)) {
		await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
	}
	for (const kind of ["data", "state", "cache"] as const) {
		expect(stores.paths[kind]).toBe(paths[kind]);
		expect((await stat(paths[kind])).isDirectory()).toBe(true);
	}
});

test("secrets are per-user/per-slug, 0600 on create and rewrite, and reload external writes", async () => {
	const alice = host.stores.user("alice");
	const path = join(roots.configDir, "user-secrets", "alice.json");
	await alice.secrets.set("token", "alice-first");
	expect((await stat(path)).mode & 0o777).toBe(0o600);
	expect(await alice.secrets.get("token")).toBe("alice-first");

	// A sibling extension's same-named key is a different top-level section.
	const sibling = createSeamHost(
		{ name: "other" },
		{},
		{ bindHarness: () => {}, harness: () => Promise.reject(new Error("unused")) },
		sharedExtensionStores(roots, {}, users),
	).stores.user("alice");
	await sibling.secrets.set("token", "other-value");
	expect(await alice.secrets.get("token")).toBe("alice-first");
	expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
		acme: { token: "alice-first" },
		other: { token: "other-value" },
	});

	await alice.secrets.set("token", "alice-second");
	expect((await stat(path)).mode & 0o777).toBe(0o600);
	expect(await alice.secrets.get("token")).toBe("alice-second");

	// A CLI/second-process edit is honored on the next read (the identity
	// store discipline's mtime reload; no restart and no stale section).
	const external = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
	external.acme = { token: "external-edit" };
	await writeFile(path, JSON.stringify(external));
	expect(await alice.secrets.get("token")).toBe("external-edit");

	await alice.secrets.delete("token");
	expect(await alice.secrets.get("token")).toBeUndefined();
	expect((await stat(path)).mode & 0o777).toBe(0o600);

	// Independently constructed handles still serialize on the same file:
	// two whole-file read-modify-writes cannot drop a sibling's section.
	await Promise.all([
		host.stores.user("alice").secrets.set("left", "left-value"),
		sibling.secrets.set("right-longer-key", "right-value-longer"),
	]);
	expect(await alice.secrets.get("left")).toBe("left-value");
	expect(await sibling.secrets.get("right-longer-key")).toBe("right-value-longer");
});

test("settings round-trip at user-settings/alice/acme.json", async () => {
	const stores = host.stores.user("alice");
	expect(await stores.settings.get()).toEqual({});
	await stores.settings.set({ theme: "dark", nested: { retries: 2 } });
	expect(await stores.settings.get()).toEqual({
		theme: "dark",
		nested: { retries: 2 },
	});
	const path = join(
		roots.configDir,
		"user-settings",
		"alice",
		"acme.json",
	);
	expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
		theme: "dark",
		nested: { retries: 2 },
	});
});

test("unknown users throw verbatim; M1 already reserves the per-user dir names", () => {
	expect(() => host.stores.user("ghost")).toThrow('unknown user "ghost"');
	expect(RESERVED_EXTENSION_SLUGS).toContain("user-secrets");
	expect(RESERVED_EXTENSION_SLUGS).toContain("user-settings");
});

test("the deleting marker admits only its bounded fan-out window, never a stale handle afterwards", async () => {
	await host.stores.user("alice").secrets.set("provider", "revoke-me");
	await users.remove("alice");
	expect(() => host.stores.user("alice")).toThrow('unknown user "alice"');

	const endDeletion = beginUserDeletion("alice");
	try {
		const during = host.stores.user("alice");
		expect(await during.secrets.get("provider")).toBe("revoke-me");
		expect(() => host.stores.user("ghost")).toThrow('unknown user "ghost"');
		endDeletion();
		expect(() => host.stores.user("alice")).toThrow('unknown user "alice"');
		// A handle captured in the window is not a permanent bypass either.
		await expect(during.secrets.get("provider")).rejects.toThrow(
			'unknown user "alice"',
		);
	} finally {
		endDeletion();
	}
});
