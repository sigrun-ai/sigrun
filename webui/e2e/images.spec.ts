/**
 * UI-blocks U7 Task 3 e2e: the full image-proxy chain in a real
 * browser. The fixture surface (`fixture-images-e2e`) carries an
 * https image source in its tree; the server rewrites it to a signed
 * `/v1/image?u=…&e=…&s=…` URL (Task 1) when the surface serves; the
 * spec's browser loads that URL as an `<img>` on the app page
 * (same-origin), the proxy route (Task 3) fetches from the spec's
 * LOCAL TLS image server (a self-signed cert trusted only through the
 * injected `imageFetch` deps, the images-routes.test.ts pattern) —
 * and the image RENDERS (`naturalWidth > 0`).
 *
 * The image server counts fetches: the second page load must be served
 * from `<cacheDir>/images/` with NO second upstream fetch (Review Focus
 * 4's client-visible half).
 *
 * NOTE (scope): the interim ext-surface page (U3's SurfacePage) renders
 * boards and dumps data as JSON — it does not run the generic block
 * renderer — so the tree's rewritten URL is asserted from the SERVED
 * data and the rendering leg is driven by an explicit `<img>` element
 * on the app page (the browser's real image pipeline against the real
 * proxy route). The interim page's generic-renderer gap is U-webui
 * follow-up, not U7.
 */

import { generateKeyPairSync, createSign, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as https from "node:https";
import type { AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";
import { bootE2EServer, type E2EServer } from "./harness.js";
import { setFixtureImageUrl } from "../../test/fixtures/fixture-images-e2e/index.js";
import { isRefusedAddress } from "../../src/server/images/ranges.js";

/** The public host the resolver maps onto the local TLS image server. */
const UPSTREAM_HOST = "img.example.invalid";

const FIXTURE = pathToFileURL(
	join(import.meta.dirname, "..", "..", "test", "fixtures", "fixture-images-e2e", "index.js"),
).href;

// ---------------------------------------------------------------------------
// DER plumbing (the images-fetch.test.ts / images-routes.test.ts pattern):
// a self-signed cert for the upstream host, trusted only via the injected CA.
// ---------------------------------------------------------------------------

function der(tag: number, body: Buffer): Buffer {
	if (body.length < 0x80) {
		return Buffer.concat([Buffer.from([tag, body.length]), body]);
	}
	const bytes: number[] = [];
	for (let n = body.length; n > 0; n = Math.floor(n / 256)) bytes.unshift(n % 256);
	return Buffer.concat([
		Buffer.from([tag, 0x80 | bytes.length]),
		Buffer.from(bytes),
		body,
	]);
}

const SHA256_RSA = Buffer.concat([
	der(0x30, Buffer.from([
		0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b,
		0x05, 0x00,
	])),
]);

function cn(value: string): Buffer {
	const attr = Buffer.concat([
		Buffer.from([0x06, 0x03, 0x55, 0x04, 0x03]),
		Buffer.from([0x0c, value.length]),
		Buffer.from(value, "utf8"),
	]);
	return der(0x30, der(0x31, der(0x30, attr)));
}

function utcTime(date: Date): Buffer {
	const p = (n: number): string => String(n).padStart(2, "0");
	const body = Buffer.from(
		p(date.getUTCFullYear() % 100) +
			p(date.getUTCMonth() + 1) +
			p(date.getUTCDate()) +
			p(date.getUTCHours()) +
			p(date.getUTCMinutes()) +
			p(date.getUTCSeconds()) +
			"Z",
		"utf8",
	);
	return Buffer.concat([Buffer.from([0x17, body.length]), body]);
}

function bitString(payload: Buffer): Buffer {
	return der(0x03, Buffer.concat([Buffer.from([0x00]), payload]));
}

function selfSigned(): { certPem: string; keyPem: string } {
	const { publicKey, privateKey } = generateKeyPairSync("rsa", {
		modulusLength: 2048,
	});
	const name = cn(UPSTREAM_HOST);
	const validity = der(0x30, Buffer.concat([
		utcTime(new Date(Date.now() - 60_000)),
		utcTime(new Date(Date.now() + 86_400_000)),
	]));
	const tbs = der(0x30, Buffer.concat([
		der(0xa0, Buffer.from([0x02, 0x01, 0x02])),
		der(0x02, Buffer.concat([Buffer.from([0x01]), randomBytes(19)])),
		SHA256_RSA,
		name,
		validity,
		name,
		publicKey.export({ type: "spki", format: "der" }),
	]));
	const signer = createSign("RSA-SHA256");
	signer.update(tbs);
	const signature = signer.sign(privateKey.export({ type: "pkcs1", format: "pem" }));
	const cert = der(0x30, Buffer.concat([tbs, SHA256_RSA, bitString(signature)]));
	const b64 = cert.toString("base64").replace(/(.{64})/g, "$1\n");
	return {
		certPem: `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`,
		keyPem: privateKey.export({ type: "pkcs1", format: "pem" }),
	};
}

/** This host's first global IPv6 (or vetted IPv4 fallback): the stand-in
 *  for a public address the vetting passes while the connection dials
 *  the local fixture (images-fetch.test.ts's publicStandIn). */
function publicStandIn(): string {
	let v4: string | undefined;
	for (const list of Object.values(networkInterfaces())) {
		for (const iface of list ?? []) {
			if (iface.internal) continue;
			if (
				iface.family === "IPv6" &&
				iface.scopeid === 0 &&
				!iface.address.startsWith("fd") &&
				!iface.address.startsWith("fe80:")
			) {
				return iface.address;
			}
			if (iface.family === "IPv4" && v4 === undefined && !isRefusedAddress(iface.address)) {
				v4 = iface.address;
			}
		}
	}
	if (v4 !== undefined) return v4;
	throw new Error("no global IPv6 or vetted IPv4 address for the public stand-in");
}

// ---------------------------------------------------------------------------
// The TLS image server (fetch-counting)
// ---------------------------------------------------------------------------

interface ImageServer {
	readonly url: string;
	readonly ca: Buffer;
	/** How many requests the image server has served. */
	fetches(): number;
	close(): Promise<void>;
}

async function startImageServer(): Promise<ImageServer> {
	const { certPem, keyPem } = selfSigned();
	// A 2×2 red PNG, generated once via sharp (a REAL decodable image —
	// the naturalWidth assertion needs a valid render).
	const png = await (await import("sharp")).default({
		create: { width: 2, height: 2, channels: 3, background: { r: 200, g: 0, b: 0 } },
	})
		.png()
		.toBuffer();
	let fetches = 0;
	const server = https.createServer(
		{ key: keyPem, cert: certPem },
		(_request: IncomingMessage, response: ServerResponse) => {
			fetches += 1;
			response.writeHead(200, {
				"content-type": "image/png",
				"cache-control": "max-age=3600",
			});
			response.end(png);
		},
	);
	await new Promise<void>((resolve) => {
		server.listen(0, "::", () => resolve());
	});
	const port = (server.address() as AddressInfo).port;
	return {
		url: `https://${UPSTREAM_HOST}:${port}/shot.png`,
		ca: Buffer.from(certPem, "utf8"),
		fetches: () => fetches,
		async close() {
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
			});
		},
	};
}

// ---------------------------------------------------------------------------
// The spec
// ---------------------------------------------------------------------------

let server: E2EServer;
let images: ImageServer;

test.beforeAll(async () => {
	images = await startImageServer();
	setFixtureImageUrl(images.url);
	server = await bootE2EServer({
		extensionSpecifiers: [FIXTURE],
		settingsFile: { namingModel: false },
		imageFetch: {
			resolve: async () => [publicStandIn()],
			ca: images.ca,
		},
	});
});

test.afterAll(async () => {
	await server.cleanup();
	await images.close();
});

test("the served surface carries the signed proxy URL, the image renders, and the cache serves the second load", async ({
	page,
}) => {
	await page.goto(`${server.url}/#/ext/fixture-images-e2e/shots`);
	// The surface renders (the interim page shows the title + the data
	// JSON); the served data carries the REWRITTEN proxy URL — Task 1's
	// rewriter ran over the fixture's https image source at serve time.
	await expect(page.locator(".ext-surface-title")).toBeVisible();
	const served = await page.evaluate(async () => {
		const response = await fetch(
			"/v1/ext/fixture-images-e2e/surfaces/shots",
			{ headers: { accept: "application/json" } },
		);
		return (await response.json()) as { tree: unknown };
	});
	const servedText = JSON.stringify(served.tree);
	expect(servedText).toContain("/v1/image?u=");
	expect(servedText).toContain(encodeURIComponent(images.url));
	const proxyPath = new RegExp(
		`(/v1/image\\?u=${encodeURIComponent(images.url).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}&e=\\d+&s=[0-9a-f]+)`,
	).exec(servedText)?.[1];
	expect(proxyPath).toBeDefined();

	// The browser loads the signed URL as a real image (same-origin on
	// the app page) and it RENDERS.
	const naturalWidth = await page.evaluate(async (path) => {
		const img = new Image();
		const loaded = new Promise<number>((resolve, reject) => {
			img.onload = () => resolve(img.naturalWidth);
			img.onerror = () => reject(new Error("image failed to load"));
		});
		img.src = path;
		return await loaded;
	}, proxyPath ?? "");
	expect(naturalWidth).toBeGreaterThan(0);
	expect(images.fetches()).toBe(1);

	// The second page load re-serves from the cache: no second upstream
	// fetch, and the image still renders.
	await page.goto(`${server.url}/#/ext/fixture-images-e2e/shots`);
	await expect(page.locator(".ext-surface-title")).toBeVisible();
	const width2 = await page.evaluate(async (path) => {
		const img = new Image();
		const loaded = new Promise<number>((resolve, reject) => {
			img.onload = () => resolve(img.naturalWidth);
			img.onerror = () => reject(new Error("image failed to load"));
		});
		img.src = path;
		return await loaded;
	}, proxyPath ?? "");
	expect(width2).toBeGreaterThan(0);
	expect(images.fetches()).toBe(1);
});
