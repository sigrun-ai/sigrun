/**
 * UI-blocks U7 Task 3: the on-disk image cache (spec §11.2).
 *
 * Shapes (task-3 brief):
 * - entries live under `<cacheDir>/images/`, keyed by `sha256(u)` plus
 *   the `as` variant;
 * - the index (type, size, added-at, last-hit, pin) survives a cache
 *   re-open (`close()` + a new instance over the same dir);
 * - capacity is 256 MiB; eviction is LRU by last-hit, and an entry being
 *   STREAMED (or written) is never evicted — eviction skips it and takes
 *   the next-oldest entry instead (Review Focus 5);
 * - misses open a file STREAMING reader (bounded live-file memory).
 */

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "vitest";
import { ImageCache } from "../src/server/images/cache.js";

const dirs: string[] = [];
const caches: ImageCache[] = [];

/** One cache + dir per test (hermetic tmpdir, cleaned up after). */
async function makeCache(
	capacityBytes?: number,
): Promise<{ cache: ImageCache; dir: string }> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-images-cache-"));
	dirs.push(dir);
	const cache = new ImageCache(
		dir,
		capacityBytes === undefined ? {} : { capacityBytes },
	);
	caches.push(cache);
	return { cache, dir };
}

afterEach(async () => {
	while (caches.length > 0) await caches.pop()?.close();
	while (dirs.length > 0) await rm(dirs.pop() ?? "", { recursive: true, force: true });
});

/** The expected file name for one (url, variant) key. */
function fileNameOf(u: string, variant: string): string {
	return `${createHash("sha256").update(u, "utf8").digest("hex")}.${variant}`;
}

describe("image cache", () => {
	test("a miss; put then get streams the bytes; the file sits under images/", async () => {
		const { cache, dir } = await makeCache();
		const u = "https://img.acme.example/pixel.png";
		expect(await cache.get(u, "orig")).toBeUndefined();
		const body = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
		await cache.put(u, "orig", "png", body, 1234);
		const hit = await cache.get(u, "orig");
		expect(hit?.type).toBe("png");
		const chunks: Buffer[] = [];
		for await (const chunk of hit!.stream) chunks.push(chunk as Buffer);
		expect(Buffer.concat(chunks)).toEqual(body);
		// The data files under images/ are the entry file alone
		// (index.json rides beside them, not an entry itself).
		expect(
			(await readdir(join(dir, "images"))).filter((f) => f !== "index.json"),
		).toEqual([fileNameOf(u, "orig")]);
	});

	test("the two variants of one URL are distinct entries", async () => {
		const { cache } = await makeCache();
		const u = "https://img.acme.example/photo.jpg";
		await cache.put(u, "orig", "jpeg", Buffer.from("jpeg-bytes"), 10);
		await cache.put(u, "png", "png", Buffer.from("png-bytes"), 10);
		expect((await cache.get(u, "orig"))?.type).toBe("jpeg");
		expect((await cache.get(u, "png"))?.type).toBe("png");
	});

	test("the index survives close() + re-open over the same dir", async () => {
		const { cache, dir } = await makeCache();
		const u = "https://img.acme.example/a.png";
		await cache.put(u, "orig", "png", Buffer.from("persisted"), 42);
		await cache.close();
		caches.pop(); // closed already
		const reopened = new ImageCache(dir);
		caches.push(reopened);
		const hit = await reopened.get(u, "orig");
		expect(hit?.type).toBe("png");
		const chunks: Buffer[] = [];
		for await (const chunk of hit!.stream) chunks.push(chunk as Buffer);
		expect(Buffer.concat(chunks).toString()).toBe("persisted");
	});

	test("LRU eviction drops the least-recently-hit entry over capacity", async () => {
		const { cache } = await makeCache(10);
		// a=4 (added 1), b=4 (added 2, hit later at 5), c=4 (added 3).
		await cache.put("https://img.acme.example/a.png", "orig", "png", Buffer.from("aaaa"), 1);
		await cache.put("https://img.acme.example/b.png", "orig", "png", Buffer.from("bbbb"), 2);
		await cache.put("https://img.acme.example/c.png", "orig", "png", Buffer.from("cccc"), 3);
		// a is the LRU victim (b's hit at t=5 is newer than a's t=1).
		const hitB = await cache.get("https://img.acme.example/b.png", "orig", 5);
		expect(hitB).toBeDefined();
		if (hitB !== undefined) for await (const _ of hitB.stream) void _;
		expect(await cache.get("https://img.acme.example/a.png", "orig", 6)).toBeUndefined();
		expect(await cache.get("https://img.acme.example/b.png", "orig", 7)).toBeDefined();
		expect(await cache.get("https://img.acme.example/c.png", "orig", 8)).toBeDefined();
	});

	test("Review Focus 5: an entry being streamed is never evicted", async () => {
		const { cache } = await makeCache(10);
		// a is held mid-stream when c arrives; eviction must skip the
		// pinned oldest (a) and take b instead.
		await cache.put("https://img.acme.example/a.png", "orig", "png", Buffer.from("aaaa"), 1);
		await cache.put("https://img.acme.example/b.png", "orig", "png", Buffer.from("bbbb"), 2);
		const held = await cache.get("https://img.acme.example/a.png", "orig", 3);
		expect(held).toBeDefined();
		await cache.put("https://img.acme.example/c.png", "orig", "png", Buffer.from("cccc"), 4);
		// a survived eviction because it was pinned; b (the next-oldest,
		// unpinned) was evicted instead.
		expect(await cache.get("https://img.acme.example/a.png", "orig", 5)).toBeDefined();
		expect(await cache.get("https://img.acme.example/b.png", "orig", 6)).toBeUndefined();
		// The held stream still reads the full bytes.
		const chunks: Buffer[] = [];
		for await (const chunk of held!.stream) chunks.push(chunk as Buffer);
		expect(Buffer.concat(chunks).toString()).toBe("aaaa");
	});
});
