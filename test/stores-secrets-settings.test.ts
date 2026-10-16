/**
 * Task 4: the server-mediated store classes + the secret precedence
 * resolver in `src/harness/stores.ts`:
 *
 * - `SecretsStore` — whole-file read-modify-write of one `secrets.json`
 *   keyed by extension slug, atomic temp+rename at `0600`. A malformed
 *   file fails LOUD naming the path (never a silent reset — the next
 *   write must not quietly rewrite a corrupt file to `{}`).
 * - `ExtensionSettingsStore` — one JSON file per extension under
 *   `settings/`, absent → `{}`, atomic temp+rename at `0644`.
 * - `resolveSecretFor` — stored wins, env fallback, else undefined;
 *   pure over its arguments (NEVER writes env values down — Review
 *   Focus 4: the file's bytes are byte-identical before/after).
 *
 * Atomicity-under-failure (Review Focus 3) stubs `rename` to throw
 * AFTER the temp file was staged (the stub reads the staged bytes to
 * prove ordering, then rejects); the target must keep its old contents.
 * The seam is `vi.mock` on `node:fs/promises` with everything else
 * delegated to the real module — the least invasive injection the
 * suite has (no existing fs-stub idiom to follow).
 */

import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi, afterEach } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		// Default: the real rename (`actual.rename` — the closure over the
		// ORIGINAL module; a top-level import here would resolve to this
		// very mock and recurse). Tests override ONE call via
		// mockImplementationOnce to simulate a same-fs rename failure.
		rename: vi.fn((...args: Parameters<typeof actual.rename>) =>
			actual.rename(...args),
		),
	};
});

import { rename } from "node:fs/promises";
import {
	ExtensionSettingsStore,
	SecretsStore,
	resolveSecretFor,
} from "../src/harness/stores.js";

/** Every tmpdir this file created, removed after each test. */
const bases: string[] = [];
afterEach(async () => {
	await Promise.all(
		bases.splice(0).map((base) => rm(base, { recursive: true, force: true })),
	);
});

/** A synthetic tmpdir base with the secrets/settings paths under it. */
const setup = async () => {
	const base = await mkdtemp(join(tmpdir(), "sigrun-stores-sec-"));
	bases.push(base);
	// The settings dir is boot's to create (ensureStoreRoots makes
	// <configDir>/settings); the store itself assumes it exists.
	const settingsDir = join(base, "settings");
	await mkdir(settingsDir, { recursive: true });
	return { base, secretsPath: join(base, "secrets.json"), settingsDir };
};

test("secrets: absent file reads as {} (first use is not an error)", async () => {
	const { secretsPath } = await setup();
	const store = new SecretsStore(secretsPath);
	expect(await store.readSection("ext-a")).toEqual({});
});

test("secrets: writeSection/readSection roundtrip stores one keyed section in the whole file", async () => {
	const { secretsPath } = await setup();
	const store = new SecretsStore(secretsPath);
	await store.writeSection("ext-a", { "api-key": "faux-key-a" });
	expect(await store.readSection("ext-a")).toEqual({ "api-key": "faux-key-a" });
	const onDisk = JSON.parse(await readFile(secretsPath, "utf8"));
	expect(onDisk).toEqual({ "ext-a": { "api-key": "faux-key-a" } });
});

test("secrets: two extensions' sections are isolated (read-modify-write keeps the sibling)", async () => {
	const { secretsPath } = await setup();
	const store = new SecretsStore(secretsPath);
	await store.writeSection("ext-a", { token: "faux-key-a" });
	await store.writeSection("ext-b", { token: "faux-key-b" });
	expect(await store.readSection("ext-a")).toEqual({ token: "faux-key-a" });
	expect(await store.readSection("ext-b")).toEqual({ token: "faux-key-b" });
	// A second write to ext-a must not clobber ext-b.
	await store.writeSection("ext-a", { token: "faux-key-a2" });
	expect(await store.readSection("ext-a")).toEqual({ token: "faux-key-a2" });
	expect(await store.readSection("ext-b")).toEqual({ token: "faux-key-b" });
	expect(await store.readSection("ext-c")).toEqual({});
});

test("secrets: a failing rename leaves the target unchanged with old contents intact (atomicity)", async () => {
	const { secretsPath, base } = await setup();
	await writeFile(secretsPath, `${JSON.stringify({ "ext-a": { token: "faux-old" } }, null, "\t")}\n`, "utf8");
	const before = await readFile(secretsPath, "utf8");
	const store = new SecretsStore(secretsPath);

	vi.mocked(rename).mockImplementationOnce(async (fromPath) => {
		// Prove the temp file was staged with the NEW contents before
		// rename was attempted (Review Focus 3's "after the temp write").
		const staged = await readFile(fromPath, "utf8");
		expect(JSON.parse(staged)).toEqual({
			"ext-a": { token: "faux-new" },
		});
		throw new Error("simulated rename failure");
	});

	await expect(
		store.writeSection("ext-a", { token: "faux-new" }),
	).rejects.toThrow("simulated rename failure");
	// The target never saw the new bytes, and no temp file was left behind
	// (base also legitimately holds the setup-created settings/ dir).
	expect(await readFile(secretsPath, "utf8")).toBe(before);
	expect((await readdir(base)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});

test("secrets: malformed secrets.json fails loud naming the path (read AND write)", async () => {
	const { secretsPath } = await setup();
	await writeFile(secretsPath, "{ not json", "utf8");
	const store = new SecretsStore(secretsPath);
	await expect(store.readSection("ext-a")).rejects.toThrow(secretsPath);
	await expect(
		store.writeSection("ext-a", { token: "faux-key" }),
	).rejects.toThrow(secretsPath);
});

test("secrets: the file is written 0600 (including on replace, not just creation)", async () => {
	const { secretsPath } = await setup();
	const store = new SecretsStore(secretsPath);
	await store.writeSection("ext-a", { token: "faux-key-a" });
	expect((await stat(secretsPath)).mode & 0o777).toBe(0o600);
	await store.writeSection("ext-b", { token: "faux-key-b" });
	expect((await stat(secretsPath)).mode & 0o777).toBe(0o600);
});

test("settings: absent file reads as {}", async () => {
	const { settingsDir } = await setup();
	const store = new ExtensionSettingsStore(settingsDir);
	expect(await store.read("ext-a")).toEqual({});
});

test("settings: one file per extension, contents isolated", async () => {
	const { settingsDir } = await setup();
	const store = new ExtensionSettingsStore(settingsDir);
	await store.write("ext-a", { interval: 30, label: "alpha" });
	await store.write("ext-b", { nested: { flag: true } });
	expect(await store.read("ext-a")).toEqual({ interval: 30, label: "alpha" });
	expect(await store.read("ext-b")).toEqual({ nested: { flag: true } });
	// Overwriting one extension leaves the sibling file untouched.
	await store.write("ext-a", { interval: 60 });
	expect(await store.read("ext-a")).toEqual({ interval: 60 });
	expect(await store.read("ext-b")).toEqual({ nested: { flag: true } });
});

test("settings: write is atomic (failing rename leaves the old file intact, no temp residue)", async () => {
	const { settingsDir } = await setup();
	const store = new ExtensionSettingsStore(settingsDir);
	await store.write("ext-a", { interval: 30 });
	const path = join(settingsDir, "ext-a.json");
	const before = await readFile(path, "utf8");

	vi.mocked(rename).mockImplementationOnce(async (fromPath) => {
		const staged = await readFile(fromPath, "utf8");
		expect(JSON.parse(staged)).toEqual({ interval: 60 });
		throw new Error("simulated rename failure");
	});

	await expect(store.write("ext-a", { interval: 60 })).rejects.toThrow(
		"simulated rename failure",
	);
	expect(await readFile(path, "utf8")).toBe(before);
	expect(await readdir(settingsDir)).toEqual(["ext-a.json"]);
});

test("settings: malformed file fails loud naming the path", async () => {
	const { settingsDir } = await setup();
	const path = join(settingsDir, "ext-a.json");
	await writeFile(path, "[1, 2,", "utf8");
	const store = new ExtensionSettingsStore(settingsDir);
	await expect(store.read("ext-a")).rejects.toThrow(path);
});

test("settings: files are written 0644", async () => {
	const { settingsDir } = await setup();
	const store = new ExtensionSettingsStore(settingsDir);
	await store.write("ext-a", { interval: 30 });
	expect((await stat(join(settingsDir, "ext-a.json"))).mode & 0o777).toBe(0o644);
});

test("precedence: stored wins over env; env-only resolves from env; neither is undefined", async () => {
	const { secretsPath } = await setup();
	const store = new SecretsStore(secretsPath);
	await store.writeSection("my-ext", { "api-key": "faux-stored" });
	const section = await store.readSection("my-ext");
	const env = { SIGRUN_EXT_MY_EXT_API_KEY: "faux-env" };

	// env + stored → stored
	expect(resolveSecretFor("my-ext", section, "api-key", env)).toEqual({
		value: "faux-stored",
		source: "stored",
	});
	// env-only (the section lacks the key) → env
	expect(resolveSecretFor("my-ext", section, "other-key", {
		SIGRUN_EXT_MY_EXT_OTHER_KEY: "faux-env",
	})).toEqual({ value: "faux-env", source: "env" });
	// neither → undefined
	expect(
		resolveSecretFor("my-ext", section, "missing", {
			SIGRUN_EXT_MY_EXT_API_KEY: "faux-env",
		}),
	).toBeUndefined();
	// an empty-string env var counts as unset (the module's dir tiers'
	// ""-means-unset reading, applied to secrets)
	expect(
		resolveSecretFor("my-ext", section, "blank", { SIGRUN_EXT_MY_EXT_BLANK: "" }),
	).toBeUndefined();
});

test("precedence: env-only resolution never writes the file (bytes identical before/after)", async () => {
	const { secretsPath } = await setup();
	const store = new SecretsStore(secretsPath);
	await store.writeSection("my-ext", { "api-key": "faux-stored" });
	const before = await readFile(secretsPath, "utf8");
	const section = await store.readSection("my-ext");

	// Resolve env-only (section lacks the key), stored-wins, and absent —
	// none of these may touch the file (Review Focus 4).
	expect(resolveSecretFor("my-ext", section, "webhook-url", {
		SIGRUN_EXT_MY_EXT_WEBHOOK_URL: "faux-env",
	})).toEqual({ value: "faux-env", source: "env" });
	expect(resolveSecretFor("my-ext", section, "api-key", {})).toEqual({
		value: "faux-stored",
		source: "stored",
	});
	expect(resolveSecretFor("my-ext", section, "missing", {})).toBeUndefined();

	expect(await readFile(secretsPath, "utf8")).toBe(before);
});
