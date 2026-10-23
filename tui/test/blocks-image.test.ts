/**
 * The image block (UI-blocks U2 Task 2, spec §11.3): pi-tui's `Image`
 * when `getCapabilities().images` is kitty/iterm2 and the bytes arrived;
 * `[image: <alt>]` otherwise (no protocol, TMUX without
 * `PI_IMAGE_PROTOCOL`, a failed or refused fetch, a missing alt). PNG
 * bytes render as PNG; every non-PNG source is requested with
 * `as=png` (the server-side conversion, ruling 17). The byte-fetching
 * is an injectable function (the surface transport lands in Task 4 —
 * tests fake it).
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import {
	getCapabilities,
	resetCapabilitiesCache,
	setCapabilities,
} from "@earendil-works/pi-tui";
import type { TerminalCapabilities } from "@earendil-works/pi-tui";
import type { Block, JsonObject } from "@sigrun/shared/blocks";
import { plainTuiTheme } from "../src/theme.js";
import { renderBlock } from "../src/blocks/render.js";
import type { BlockCtx } from "../src/blocks/render.js";
import type { FetchImageBytes } from "../src/blocks/image.js";

/** Build a ctx: plain theme. */
function makeCtx(data: JsonObject = {}): BlockCtx {
	return {
		data,
		theme: plainTuiTheme(),
		locale: "en-CA",
		access: "write",
		unicode: true,
		dispatch: () => {},
		view: { values: {} },
	};
}

/** A 1×1 PNG (the smallest valid file). */
const PNG_BYTES = Uint8Array.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
	0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06,
	0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44,
	0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d,
	0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42,
	0x60, 0x82,
]);

const IMG: Block = { type: "image", src: "asset:acme/diagram.png", alt: "acme cluster" };

/** A fetch fn that records its calls and answers `bytes`. */
function recordingFetch(
	bytes: Uint8Array | Error,
): { fetch: FetchImageBytes; calls: { src: string; asPng: boolean }[] } {
	const calls: { src: string; asPng: boolean }[] = [];
	const fetch: FetchImageBytes = async (src, opts) => {
		calls.push({ src, asPng: opts.asPng });
		if (bytes instanceof Error) throw bytes;
		return bytes;
	};
	return { fetch, calls };
}

/** The capabilities the tests install; restored after each. */
const ORIGINAL: TerminalCapabilities = getCapabilities();

afterEach(() => {
	setCapabilities(ORIGINAL);
	vi.unstubAllEnvs();
	resetCapabilitiesCache();
});

/** A tiny PNG image loads over several async renders. */
async function settle(comp: { render(width: number): string[] }, width = 80): Promise<string[]> {
	let out = comp.render(width);
	for (let i = 0; i < 3 && out.length === 0; i++) {
		out = await new Promise((resolve: (lines: string[]) => void) =>
			setImmediate(() => resolve(comp.render(width))),
		);
	}
	return out;
}

// ─── the capable terminal ─────────────────────────────────────────────────

describe("image on a kitty terminal", () => {
	test("fetches and renders the PNG bytes through pi-tui Image", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const { fetch, calls } = recordingFetch(PNG_BYTES);
		const comp = renderBlock(IMG, makeCtx(), { fetchImage: fetch });
		const out = await settle(comp);
		// pi-tui emits the kitty graphics sequence for the bytes we returned.
		expect(out.length).toBeGreaterThan(0);
		expect(out.some((line: string) => line.includes("\x1b_G") || line.includes("\x1b]1337"))).toBe(
			true,
		);
		expect(calls).toEqual([{ src: "asset:acme/diagram.png", asPng: false }]);
	});

	test("an iterm2 terminal renders too", async () => {
		setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: true });
		const { fetch } = recordingFetch(PNG_BYTES);
		const comp = renderBlock(IMG, makeCtx(), { fetchImage: fetch });
		const out = await settle(comp);
		expect(out.some((line: string) => line.includes("\x1b_G") || line.includes("\x1b]1337"))).toBe(
			true,
		);
	});
});

// ─── the as=png rule (ruling 17) ──────────────────────────────────────────

describe("image conversion", () => {
	test("a jpeg source is requested with as=png", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const { fetch, calls } = recordingFetch(PNG_BYTES);
		const jpeg: Block = { type: "image", src: "asset:acme/shot.jpeg", alt: "a" };
		const comp = renderBlock(jpeg, makeCtx(), { fetchImage: fetch });
		await settle(comp);
		expect(calls).toEqual([{ src: "asset:acme/shot.jpeg", asPng: true }]);
	});

	test("a webp data URL is requested with as=png", async () => {
		setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: true });
		const { fetch, calls } = recordingFetch(PNG_BYTES);
		const webp: Block = {
			type: "image",
			src: "data:image/webp;base64,AAAA",
			alt: "b",
		};
		const comp = renderBlock(webp, makeCtx(), { fetchImage: fetch });
		await settle(comp);
		expect(calls).toEqual([{ src: "data:image/webp;base64,AAAA", asPng: true }]);
	});
});

// ─── the fallbacks ────────────────────────────────────────────────────────

describe("image fallback", () => {
	test("no protocol: [image: alt]", async () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: true });
		const { fetch, calls } = recordingFetch(PNG_BYTES);
		const comp = renderBlock(IMG, makeCtx(), { fetchImage: fetch });
		const out = await settle(comp);
		expect(out).toEqual(["[image: acme cluster]"]);
		expect(calls).toEqual([]); // nothing fetched without a protocol
	});

	test("under TMUX without PI_IMAGE_PROTOCOL pi-tui reports no images", async () => {
		vi.stubEnv("TMUX", "/tmp/tmux-1000/default,123,0");
		resetCapabilitiesCache();
		expect(getCapabilities().images).toBeNull();
		const { fetch } = recordingFetch(PNG_BYTES);
		const comp = renderBlock(IMG, makeCtx(), { fetchImage: fetch });
		const out = await settle(comp);
		expect(out).toEqual(["[image: acme cluster]"]);
	});

	test("a failed fetch renders the alt", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const { fetch } = recordingFetch(new Error("proxy refused"));
		const comp = renderBlock(IMG, makeCtx(), { fetchImage: fetch });
		const out = await settle(comp);
		expect(out).toEqual(["[image: acme cluster]"]);
	});

	test("a missing alt renders [image]", async () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: true });
		const bare = { type: "image", src: "asset:acme/x.png" } as unknown as Block;
		const out = renderBlock(bare, makeCtx()).render(80);
		expect(out).toEqual(["[image]"]);
	});
});
