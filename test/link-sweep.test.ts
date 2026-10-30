/**
 * The boot-time account-link sweep (username-derivation Task 8, spec
 * §11.3 crash-orphan repair): runs ONCE at boot, after the identity
 * stores open, before serving — never on the request path and never
 * inside the claim lock.
 *
 * - a link whose user no longer exists is REMOVED (counted);
 * - a `source === "proxy"` user with NO proxy link is a crash orphan
 *   (the user row was written, the link write never landed) — listed,
 *   never auto-repaired, because the sweep cannot know the proxy
 *   username the link should carry;
 * - boot logs the removal count (only when > 0) and one repair-command
 *   line per orphan; a clean store logs nothing.
 *
 * Tests own their literals: tmp dirs, `alice`/`carol` users,
 * `example.com` proxy subjects.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { afterAll, describe, expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import { AccountStore, UserDirectory } from "../src/harness/identity/index.js";
import { sweepAccountLinks } from "../src/harness/identity/link-sweep.js";
import { unclaimedIdentity } from "./helpers/identity.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";

const dirs: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
// ONE teardown hook: drain harness closes FIRST (they may still write
// under the tmp roots), then remove the dirs — no reverse-ordering
// dependency between sibling afterAll hooks.
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
	for (const dir of dirs.splice(0)) {
		await rm(dir, { recursive: true, force: true });
	}
});

function tmpDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), `sigrun-link-sweep-${prefix}-`));
	dirs.push(dir);
	return dir;
}

/** Users alice (cli admin) + carol (proxy source), over a tmp dir. */
async function stores(prefix: string): Promise<{
	users: UserDirectory;
	accounts: AccountStore;
}> {
	const dir = tmpDir(prefix);
	const users = new UserDirectory(join(dir, "users.json"));
	await users.add({ user: "alice", admin: true, source: "cli" });
	await users.add({ user: "carol_example.com", admin: false, source: "proxy" });
	return { users, accounts: new AccountStore(join(dir, "accounts.json"), users) };
}

describe("sweepAccountLinks", () => {
	test("a link to a missing user is removed; removedDangling === 1", async () => {
		const { users, accounts } = await stores("dangling");
		await accounts.link({
			provider: "chat:telegram",
			subject: "12345",
			user: "alice",
			via: "pairing",
		});
		// A second link whose user is then deleted behind the store's back
		// (deletion normally removes links; a hand-edited file can dangle).
		await users.add({ user: "dave_example.com", admin: false, source: "proxy" });
		await accounts.link({
			provider: "proxy",
			subject: "dave@example.com",
			user: "dave_example.com",
			via: "proxy",
		});
		await users.remove("dave_example.com");
		expect(accounts.list()).toHaveLength(2);

		const result = await sweepAccountLinks(users, accounts);
		expect(result.removedDangling).toBe(1);
		// dave's user row is gone, so he is NOT an orphan (only carol is);
		// only alice's healthy link survives.
		expect(result.orphans).toEqual(["carol_example.com"]);
		expect(accounts.list()).toHaveLength(1);
		expect(accounts.lookup("chat:telegram", "12345")?.user).toBe("alice");
		expect(accounts.lookup("proxy", "dave@example.com")).toBeUndefined();
	});

	test("a proxy-source user with no proxy link is listed in orphans", async () => {
		const { users, accounts } = await stores("orphan");
		// carol has NO proxy link — the Task 3 crash-orphan shape.
		const result = await sweepAccountLinks(users, accounts);
		expect(result.removedDangling).toBe(0);
		expect(result.orphans).toEqual(["carol_example.com"]);
		// The sweep lists, never repairs: the user row is untouched.
		expect(users.get("carol_example.com")).toBeDefined();
	});

	test("a proxy-source user holding ONLY a chat link is still an orphan", async () => {
		const { users, accounts } = await stores("chat-only");
		await accounts.link({
			provider: "chat:telegram",
			subject: "67890",
			user: "carol_example.com",
			via: "pairing",
		});
		const result = await sweepAccountLinks(users, accounts);
		expect(result.removedDangling).toBe(0);
		expect(result.orphans).toEqual(["carol_example.com"]);
		// The chat link is healthy and untouched.
		expect(accounts.lookup("chat:telegram", "67890")?.user).toBe(
			"carol_example.com",
		);
	});

	test("a linked proxy user is NOT an orphan; a clean store is a no-op", async () => {
		const { users, accounts } = await stores("clean");
		await accounts.link({
			provider: "proxy",
			subject: "carol@example.com",
			user: "carol_example.com",
			via: "proxy",
		});
		const before = accounts.list();
		const result = await sweepAccountLinks(users, accounts);
		expect(result.removedDangling).toBe(0);
		expect(result.orphans).toEqual([]);
		expect(accounts.list()).toEqual(before);
	});
});

// ---------------------------------------------------------------------------
// boot wiring: the sweep runs after the identity stores open and logs
// ---------------------------------------------------------------------------

/**
 * Boot one hermetic harness over a seeded identity bundle (the
 * onboarding test's pattern: faux provider + tmp roots; no listener —
 * openHarness is where the sweep runs).
 */
async function bootHarness(
	dir: string,
	seed: (identity: Awaited<ReturnType<typeof unclaimedIdentity>>) => Promise<void>,
): Promise<OpenedHarness> {
	const identity = await unclaimedIdentity(dir);
	await seed(identity);
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	faux.setResponses([fauxAssistantMessage("ok")]);
	const contributor: ProviderContributor = {
		name: "ext-faux",
		providers: [{ provider: faux.provider }],
	};
	const env = {
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_ISOLATION: "off",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
		SIGRUN_CONFIG_DIR: join(dir, "config"),
		SIGRUN_CACHE_DIR: join(dir, "cache"),
		SIGRUN_STATE_DIR: join(dir, "state"),
	};
	const config = loadConfig(env, { server: {} } as Parameters<typeof loadConfig>[1]);
	const opened = await openHarness(config, {
		extensions: [contributor],
		env,
		identity,
		isolationProbe: async () => ({ available: false, abi: 0, reason: "not linux" }),
	});
	cleanups.push(async () => {
		await opened.harness.close(BACKGROUND_CONTEXT);
	});
	return opened;
}

describe("boot sweep logging", () => {
	test("boot logs the dangling-link removal and the orphan repair command", async () => {
		const dir = tmpDir("boot-dirty");
		const identity = await unclaimedIdentity(dir);
		await identity.users.add({ user: "tester", admin: true, source: "cli" });
		await identity.users.add({
			user: "carol_example.com",
			admin: false,
			source: "proxy",
		});
		// A dangling link: write the accounts file directly with a user the
		// directory does not carry (the store's own link() would refuse it).
		writeFileSync(
			join(dir, "accounts.json"),
			JSON.stringify([
				{
					provider: "proxy",
					subject: "ghost@example.com",
					user: "ghost_example.com",
					linkedAt: 1,
					via: "proxy",
				},
			]),
			{ mode: 0o600 },
		);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			await bootHarness(dir, async () => {});
			const lines = log.mock.calls.map((call) => String(call[0]));
			expect(lines).toContain("identity: removed 1 dangling account link(s)");
			expect(lines).toContain(
				'identity: proxy user "carol_example.com" has no proxy link; repair with: sigrun user link carol_example.com --proxy <username>',
			);
		} finally {
			log.mockRestore();
		}
	});

	test("a corrupt accounts.json warns and CONTINUES boot (sweep is best-effort)", async () => {
		const dir = tmpDir("boot-corrupt");
		const identity = await unclaimedIdentity(dir);
		await identity.users.add({ user: "tester", admin: true, source: "cli" });
		// Garbage bytes: the store's reader throws on read, which must NOT
		// turn into a boot-fatal error.
		writeFileSync(join(dir, "accounts.json"), "not json at all{{{", {
			mode: 0o600,
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const opened = await bootHarness(dir, async () => {});
			expect(opened.harness).toBeDefined();
			const lines = warn.mock.calls.map((call) => String(call[0]));
			expect(
				lines.some((line) =>
					line.startsWith("identity: account-link sweep failed: "),
				),
			).toBe(true);
		} finally {
			warn.mockRestore();
		}
	});

	test("a clean store logs nothing from the sweep", async () => {
		const dir = tmpDir("boot-clean");
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			await bootHarness(dir, async (identity) => {
				await identity.users.add({ user: "tester", admin: true, source: "cli" });
				await identity.users.add({
					user: "carol_example.com",
					admin: false,
					source: "proxy",
				});
				await identity.accounts.link({
					provider: "proxy",
					subject: "carol@example.com",
					user: "carol_example.com",
					via: "proxy",
				});
			});
			const sweepLines = log.mock.calls
				.map((call) => String(call[0]))
				.filter((line) => line.startsWith("identity: "));
			expect(sweepLines).toEqual([]);
		} finally {
			log.mockRestore();
		}
	});
});
