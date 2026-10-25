/**
 * UI-blocks U7 Task 1: the image-source rewriter (spec §11.1/§11.2).
 * `rewriteImages` walks every tree and data object and replaces
 * `https://` image sources — `image` block `src`, card `image` slots
 * (in trees AND in data items), and `![x](https://…)` markdown image
 * links — with the `sign` callback's proxy URL; `asset:` and `data:`
 * sources are untouched. It is pure: the input is never mutated and a
 * changed branch is a new structure.
 *
 * The wiring half: `SurfaceService.render`/`data` responses pass
 * through the rewriter before leaving the server (the shared service
 * method is the hook point U5's chat surfaces reuse when they land).
 *
 * Literals are synthetic (`example.invalid`, `acme/`); the fake signer
 * is a pure mapping, so the tests pin WHAT gets rewritten, not the
 * signature format (images-sign.test.ts owns that).
 */

import { describe, expect, test } from "vitest";
import type { JsonObject, Tree } from "@sigrun/shared/blocks";
import { rewriteImages } from "../src/server/images/rewrite.js";
import { SurfaceService } from "../src/server/surfaces/service.js";
import type { ExtensionSurfaceBinding } from "../src/harness/loader.js";
import type { Principal } from "../src/server/auth/principal.js";

/** A pure fake signer: the rewritten value names the original URL. */
const fakeSign = (u: string): string => `PROXY:${u}`;

const HTTPS = "https://images.example.invalid/acme/pic.png";
const HTTPS2 = "https://cdn.example.invalid/acme/other.png";

const PRINCIPAL: Principal = {
	user: "alice",
	name: "Alice Acme",
	admin: false,
	service: false,
	method: "token",
};

describe("rewriteImages: image blocks", () => {
	test("rewrites an https:// src in an image block", () => {
		const tree = {
			v: 1,
			root: {
				type: "page",
				title: "Acme gallery",
				main: [
					{ type: "image", src: HTTPS, alt: "acme pic" },
				],
			},
		};
		const out = rewriteImages(tree, fakeSign);
		const node = (out.root.main as { src: string }[])[0];
		expect(node.src).toBe(`PROXY:${HTTPS}`);
	});

	test("leaves asset: and data: sources untouched", () => {
		const tree = {
			v: 1,
			root: {
				type: "page",
				title: "Acme gallery",
				main: [
					{ type: "image", src: "asset:acme/diagram.png", alt: "a" },
					{ type: "image", src: "data:image/png;base64,AAAA", alt: "b" },
				],
			},
		};
		const out = rewriteImages(tree, fakeSign);
		const [asset, data] = out.root.main as { src: string }[];
		expect(asset.src).toBe("asset:acme/diagram.png");
		expect(data.src).toBe("data:image/png;base64,AAAA");
	});

	test("leaves a bound src untouched (the binding object is not a string)", () => {
		const tree = {
			v: 1,
			root: {
				type: "page",
				title: "t",
				main: [{ type: "image", src: { $: "/hero" }, alt: "h" }],
			},
		};
		const out = rewriteImages(tree, fakeSign);
		const node = (out.root.main as { src: unknown }[])[0];
		expect(node.src).toEqual({ $: "/hero" });
	});
});

describe("rewriteImages: card image slots", () => {
	test("rewrites a card image slot in a tree item template", () => {
		const tree = {
			v: 1,
			root: {
				type: "page",
				title: "t",
				main: [
					{
						type: "collection",
						id: "cards",
						items: { $: "/cards" },
						item: { title: "Acme", image: HTTPS },
					},
				],
			},
		};
		const out = rewriteImages(tree, fakeSign);
		const item = (out.root.main[0] as { item: { image: string } }).item;
		expect(item.image).toBe(`PROXY:${HTTPS}`);
	});

	test("rewrites card image slots in data items", () => {
		const data: JsonObject = {
			cards: [
				{ title: "First", image: HTTPS },
				{ title: "Second", image: HTTPS2 },
				{ title: "Third", image: "asset:acme/third.png" },
			],
		};
		const out = rewriteImages(data, fakeSign);
		const cards = out.cards as { image: string }[];
		expect(cards[0]?.image).toBe(`PROXY:${HTTPS}`);
		expect(cards[1]?.image).toBe(`PROXY:${HTTPS2}`);
		expect(cards[2]?.image).toBe("asset:acme/third.png");
	});

	test("leaves a non-https image slot and a bound slot untouched", () => {
		const data: JsonObject = {
			cards: [
				{ title: "A", image: "asset:acme/a.png" },
				{ title: "B", image: { $: "./b" } },
			],
		};
		const out = rewriteImages(data, fakeSign);
		const cards = out.cards as { image: unknown }[];
		expect(cards[0]?.image).toBe("asset:acme/a.png");
		expect(cards[1]?.image).toEqual({ $: "./b" });
	});
});

describe("rewriteImages: markdown image links", () => {
	test("rewrites ![alt](https://…) in a markdown block's text", () => {
		const tree = {
			v: 1,
			root: {
				type: "page",
				title: "t",
				main: [
					{
						type: "markdown",
						text: "before ![acme pic](https://images.example.invalid/a.png) after",
					},
				],
			},
		};
		const out = rewriteImages(tree, fakeSign);
		const node = (out.root.main as { text: string }[])[0];
		expect(node.text).toBe(
			"before ![acme pic](PROXY:https://images.example.invalid/a.png) after",
		);
	});

	test("rewrites every https link and leaves http, asset, data and tel links alone", () => {
		const text =
			"![one](https://images.example.invalid/1.png) ![two](http://images.example.invalid/2.png) " +
			"![three](asset:acme/3.png) ![four](data:image/png;base64,AAAA) [link](tel:5550100)";
		const out = rewriteImages({ body: text } as unknown as JsonObject, fakeSign);
		expect(out.body).toBe(
			"![one](PROXY:https://images.example.invalid/1.png) ![two](http://images.example.invalid/2.png) " +
			"![three](asset:acme/3.png) ![four](data:image/png;base64,AAAA) [link](tel:5550100)",
		);
	});

	test("rewrites markdown image links in a data string (a bound card body)", () => {
		const data: JsonObject = {
			cards: [{ title: "T", body: "see ![pic](https://images.example.invalid/b.png)" }],
		};
		const out = rewriteImages(data, fakeSign);
		const cards = out.cards as { body: string }[];
		expect(cards[0]?.body).toBe(
			"see ![pic](PROXY:https://images.example.invalid/b.png)",
		);
	});
});

describe("rewriteImages: purity", () => {
	test("never mutates the input", () => {
		const data = {
			cards: [{ image: HTTPS }],
			note: "![x](https://images.example.invalid/c.png)",
			n: 1,
		} as unknown as JsonObject;
		const snapshot = JSON.stringify(data);
		rewriteImages(data, fakeSign);
		expect(JSON.stringify(data)).toBe(snapshot);
	});

	test("returns a new structure for a changed branch, and the identical reference for an untouched value", () => {
		const data: JsonObject = { cards: [{ image: HTTPS }], plain: "acme" };
		const out = rewriteImages(data, fakeSign);
		expect(out).not.toBe(data);
		const outCards = out.cards as unknown[];
		const inCards = data.cards as unknown[];
		expect(outCards).not.toBe(inCards);
		expect(outCards[0]).not.toBe(inCards[0]);
		// Untouched leaves are shared, not cloned (copy-on-write).
		expect(out.plain).toBe(data.plain);
	});

	test("returns a scalar or array input untouched when nothing matches", () => {
		expect(rewriteImages("acme", fakeSign)).toBe("acme");
		expect(rewriteImages(3, fakeSign)).toBe(3);
		const arr = [1, "asset:acme/x.png"];
		expect(rewriteImages(arr, fakeSign)).toBe(arr);
	});
});

describe("SurfaceService wiring (the U3 service hook point)", () => {
	/** A binding whose surface holds an https image + a card-image data slot. */
	function service(imageSign: (u: string) => string): SurfaceService {
		const tree: Tree = {
			v: 1,
			root: {
				type: "page",
				title: "Acme gallery",
				main: [
					{ type: "image", src: HTTPS, alt: "acme pic" },
					{
						type: "markdown",
						text: "pic ![inline](https://images.example.invalid/inline.png)",
					},
				],
			},
		} as unknown as Tree;
		const data: JsonObject = { cards: [{ title: "T", image: HTTPS }] };
		const binding: ExtensionSurfaceBinding = {
			extension: "acme",
			defs: [
				{
					id: "gallery",
					title: "Acme gallery",
					icon: "board",
					placement: "view",
					render: async () => ({ tree, data, access: "write" }),
					data: async () => ({ data, access: "write" }),
				},
			],
		};
		return new SurfaceService([binding], { imageSign });
	}

	test("render() returns a rewritten tree and data", async () => {
		const out = await service(fakeSign).render("acme", "gallery", {}, PRINCIPAL);
		expect(out).not.toBeUndefined();
		const main = (out?.tree.root as unknown as { main: { src?: string; text?: string }[] }).main;
		expect(main[0]?.src).toBe(`PROXY:${HTTPS}`);
		expect(main[1]?.text).toBe(
			"pic ![inline](PROXY:https://images.example.invalid/inline.png)",
		);
		const cards = out?.data.cards as { image: string }[] | undefined;
		expect(cards?.[0]?.image).toBe(`PROXY:${HTTPS}`);
	});

	test("data() returns rewritten data", async () => {
		const out = await service(fakeSign).data("acme", "gallery", {}, PRINCIPAL);
		const cards = out?.data?.cards as { image: string }[] | undefined;
		expect(cards?.[0]?.image).toBe(`PROXY:${HTTPS}`);
	});

	test("without imageSign the responses pass through unchanged", async () => {
		const out = await service(fakeSign).render("acme", "gallery", {}, PRINCIPAL);
		// control: the same surface served by a service without a signer
		const plain = new SurfaceService(
			[
				{
					extension: "acme",
					defs: [
						{
							id: "gallery",
							title: "Acme gallery",
							icon: "board",
							placement: "view",
							render: async () => ({
								tree: {
									v: 1,
									root: {
										type: "page",
										title: "Acme gallery",
										main: [{ type: "image", src: HTTPS, alt: "acme pic" }],
									},
								} as unknown as Tree,
								data: {} as JsonObject,
								access: "write",
							}),
						},
					],
				},
			],
		);
		const out2 = await plain.render("acme", "gallery", {}, PRINCIPAL);
		const node = (out2?.tree.root as unknown as { main: { src: string }[] }).main[0];
		expect(node.src).toBe(HTTPS);
		expect(out).not.toBeUndefined();
	});
});
