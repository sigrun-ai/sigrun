/**
 * UI-blocks U7 Task 3: the image-proxy routes (spec §11.2).
 *
 * Shapes (task-3 brief):
 * - `GET /v1/image?u=&e=&s=` is authenticated (401 unauthenticated),
 *   403s unsigned/expired/bad-signature forms (distinguishable errors:
 *   malformed vs expired vs bad-signature), and a valid signed fetch
 *   answers 200 with the sniffed type, `X-Content-Type-Options: nosniff`,
 *   and `Cache-Control: private, max-age=<clamped to 1 h–7 d>`.
 * - A second request for the same URL is served from
 *   `<cacheDir>/images/` with NO second upstream fetch; two concurrent
 *   requests make ONE upstream fetch (Review Focus 4).
 * - `?as=png` converts a JPEG to PNG (the PNG signature) and caches the
 *   converted variant beside the original.
 * - The source form `GET /v1/image?src=asset:<slug>/<path>` serves a
 *   contained asset (a traversal answers 404) and `src=data:…` serves a
 *   data URL; both convert under `as=png`. A `data:` source too long for
 *   a URL is POSTed as the body (`?as=png`): a 200 KiB body → 413 (over
 *   the §11.1 192 KiB rule), a 100 KiB one → 200.
 * - The upstream fetch's refusal reasons map to 502 naming the reason.
 *
 * The upstream is a local TLS server with a self-signed cert trusted
 * ONLY via the injected `imageFetch` deps (the images-fetch.test.ts
 * DER pattern); the injected resolver maps the test's public host onto
 * the local socket — address VETTING is Task 2's subject; these tests
 * count upstream fetches.
 */

import { createHash, createHmac, generateKeyPairSync, createSign, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as https from "node:https";
import type { AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FastifyInstance } from "fastify";
import { afterAll, describe, expect, test } from "vitest";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import { createServer } from "../src/server/index.js";
import { signUrl } from "../src/server/images/sign.js";
import { seededIdentity } from "./helpers/identity.js";

/** The public host the resolver maps onto the local TLS server. */
const UPSTREAM_HOST = "img.example.invalid";

const ASSETS_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-surfaces-assets", "index.js"),
).href;

// ---------------------------------------------------------------------------
// DER plumbing (the images-fetch.test.ts pattern, verbatim): a self-signed
// certificate for the upstream host, trusted only through the injected CA.
// ---------------------------------------------------------------------------

/** Length-prefix `body` with a DER tag. */
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

/** sha256WithRSAEncryption (1.2.840.113549.1.1.11) with NULL params. */
const SHA256_RSA = Buffer.concat([
	der(0x30, Buffer.from([
		0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b,
		0x05, 0x00,
	])),
]);

/** One RDN: CN=<value>, the only name form this cert needs. */
function cn(value: string): Buffer {
	const attr = Buffer.concat([
		Buffer.from([0x06, 0x03, 0x55, 0x04, 0x03]),
		Buffer.from([0x0c, value.length]),
		Buffer.from(value, "utf8"),
	]);
	return der(0x30, der(0x31, der(0x30, attr)));
}

/** UTCTime (YYMMDDHHMMSSZ) for `date`. */
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

/** A BIT STRING wrapper (leading unused-bits 0x00). */
function bitString(payload: Buffer): Buffer {
	return der(0x03, Buffer.concat([Buffer.from([0x00]), payload]));
}

/** The self-signed cert for `UPSTREAM_HOST` over one fresh RSA key. */
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

// ---------------------------------------------------------------------------
// The upstream TLS server
// ---------------------------------------------------------------------------

interface Upstream {
	readonly url: string;
	readonly requests: { readonly path: string }[];
	readonly ca: Buffer;
	setBody(body: Buffer, contentType?: string, maxAge?: number): void;
	close(): Promise<void>;
}

/** A self-signed TLS upstream bound on `::` + the CA that trusts it.
 *  The injected resolver maps the test's public host onto this host's
 *  own global address (the images-fetch.test.ts publicStandIn pattern:
 *  a refused-range check would reject loopback, and the vetting IS the
 *  proxy's job — these tests dial the real routable address). */
async function startUpstream(): Promise<Upstream> {
	const { certPem, keyPem } = selfSigned();
	const requests: { path: string }[] = [];
	let body = await jpegBytes();
	let contentType: string | undefined = "image/jpeg";
	let maxAge: number | undefined = 3600;
	const server = https.createServer(
		{ key: keyPem, cert: certPem },
		(request: IncomingMessage, response: ServerResponse) => {
			requests.push({ path: request.url ?? "/" });
			response.writeHead(200, {
				"content-type": contentType ?? "application/octet-stream",
				...(maxAge === undefined
					? {}
					: { "cache-control": `max-age=${maxAge}` }),
			});
			response.end(body);
		},
	);
	await new Promise<void>((resolve) => {
		server.listen(0, "::", () => resolve());
	});
	const port = (server.address() as AddressInfo).port;
	return {
		url: `https://${UPSTREAM_HOST}:${port}/img.jpg`,
		requests,
		ca: Buffer.from(certPem, "utf8"),
		setBody(nextBody, nextType, nextMaxAge) {
			body = nextBody;
			contentType = nextType;
			maxAge = nextMaxAge;
		},
		async close() {
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
			});
		},
	};
}

// ---------------------------------------------------------------------------
// The public stand-in (images-fetch.test.ts's pattern)
// ---------------------------------------------------------------------------

import { isRefusedAddress } from "../src/server/images/ranges.js";

/** This host's first global IPv6 (or vetted IPv4 fallback): the stand-in
 *  for a public address the vetting passes while the connection dials
 *  the local fixture. */
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
// Image bytes (sharp generates the JPEG once per suite run)
// ---------------------------------------------------------------------------

/** A 1×1 opaque red JPEG, generated once via sharp. */
let jpegBody: Buffer | undefined;
async function jpegBytes(): Promise<Buffer> {
	jpegBody ??= await (await import("sharp")).default({
		create: {
			width: 1,
			height: 1,
			channels: 3,
			background: { r: 255, g: 0, b: 0 },
		},
	})
		.jpeg()
		.toBuffer();
	return jpegBody;
}

/** The fixture asset's PNG bytes as a data URL. */
async function pngDataUrl(): Promise<string> {
	const png = await readFile(
		join(
			import.meta.dirname,
			"fixtures",
			"fixture-surfaces-assets",
			"assets",
			"img",
			"a.png",
		),
	);
	return `data:image/png;base64,${png.toString("base64")}`;
}

// ---------------------------------------------------------------------------
// The hermetic server
// ---------------------------------------------------------------------------

interface TestServer {
	readonly app: FastifyInstance;
	readonly opened: OpenedHarness;
	readonly aliceToken: string;
	readonly listenUrl: string;
	readonly cacheDir: string;
	readonly stateDir: string;
	sign(u: string): string;
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

/** Boot a hermetic server: token auth (alice), the assets fixture
 *  loaded, the upstream's CA pinned for the proxy fetcher. */
async function bootServer(upstream: Upstream): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-images-routes-"));
	const configDir = join(dir, "config");
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "openai/gpt-test",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
		SIGRUN_WEBUI: "false",
		SIGRUN_AUTH: "token",
		SIGRUN_CONFIG_DIR: configDir,
		// The image cache is keyed only by upstream URL, so each fixture
		// server needs its own root instead of the suite-wide fallback.
		SIGRUN_CACHE_DIR: join(dir, "cache"),
		SIGRUN_STATE_DIR: join(dir, "state"),
	});
	const identity = await seededIdentity(join(dir, "seed"), "alice");
	const opened = await openHarness(config, {
		identity,
		extensionSpecifiers: [ASSETS_SPECIFIER],
		env: { SIGRUN_CONFIG_DIR: configDir },
		settingsDir: dir,
	});
	const { token: aliceToken } = await opened.identity.tokens.create(
		"alice-cli",
		"alice",
	);
	const app = await createServer(opened, config, [], {
		listenHost: "127.0.0.1",
		// The proxy fetcher is test-driven: the resolver maps the public
		// host onto this host's own global address (vetting passes) and
		// the CA pin trusts the fixture's self-signed cert.
		imageFetch: {
			resolve: async () => [publicStandIn()],
			ca: upstream.ca,
		},
	});
	await app.listen({ host: "127.0.0.1", port: 0 });
	const address = app.server.address();
	if (address === null || typeof address === "string") {
		throw new Error("no listen address");
	}
	const listenUrl = `http://127.0.0.1:${address.port}`;
	cleanups.push(async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	});
	const key = await readFile(join(config.stateDir, "image-proxy.key"));
	return {
		app,
		opened,
		aliceToken,
		listenUrl,
		cacheDir: config.cacheDir,
		stateDir: config.stateDir,
		sign: (u) => signUrl(key, u, Date.now()),
	};
}

async function get(
	server: TestServer,
	path: string,
	token?: string,
): Promise<Response> {
	return await fetch(`${server.listenUrl}${path}`, {
		headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /v1/image (the signed form)", () => {
	test("unauthenticated → 401", async () => {
		const upstream = await startUpstream();
		cleanups.push(upstream.close);
		const server = await bootServer(upstream);
		const response = await get(server, server.sign(upstream.url));
		expect(response.status).toBe(401);
		expect((await response.json()).error).toBe("unauthenticated");
	});

	test("an unsigned signature → 403 bad_signature; a tampered u → 403 bad_signature", async () => {
		const upstream = await startUpstream();
		cleanups.push(upstream.close);
		const server = await bootServer(upstream);
		const e = String(Date.now() + 60_000);
		const unsigned = await get(
			server,
			`/v1/image?u=${encodeURIComponent(upstream.url)}&e=${e}&s=${"0".repeat(64)}`,
			server.aliceToken,
		);
		expect(unsigned.status).toBe(403);
		expect((await unsigned.json()).error).toBe("bad_signature");
		const signed = server.sign(upstream.url);
		const tampered = await get(
			server,
			signed.replace(
				encodeURIComponent(upstream.url),
				encodeURIComponent("https://img.example.invalid/other.png"),
			),
			server.aliceToken,
		);
		expect(tampered.status).toBe(403);
		expect((await tampered.json()).error).toBe("bad_signature");
	});

	test("a malformed expiry → 403 malformed_expiry; an expired signature → 403 expired", async () => {
		const upstream = await startUpstream();
		cleanups.push(upstream.close);
		const server = await bootServer(upstream);
		const u = encodeURIComponent(upstream.url);
		const malformed = await get(
			server,
			`/v1/image?u=${u}&e=tomorrow&s=${"0".repeat(64)}`,
			server.aliceToken,
		);
		expect(malformed.status).toBe(403);
		expect((await malformed.json()).error).toBe("malformed_expiry");
		// A signature valid for an ALREADY-past expiry: 403 expired (the
		// signature itself verifies — the distinction is the point).
		const past = String(Date.now() - 60_000);
		const key = await readFile(join(server.stateDir, "image-proxy.key"));
		const s = createHmac("sha256", key)
			.update(`${upstream.url}\n${past}`, "utf8")
			.digest("hex");
		const expired = await get(
			server,
			`/v1/image?u=${u}&e=${past}&s=${s}`,
			server.aliceToken,
		);
		expect(expired.status).toBe(403);
		expect((await expired.json()).error).toBe("expired");
	});

	test("a valid signed fetch → 200 with the sniffed type, nosniff, clamped max-age; a second request serves the cache with NO upstream call", async () => {
		const upstream = await startUpstream();
		cleanups.push(upstream.close);
		const server = await bootServer(upstream);
		upstream.setBody(await jpegBytes(), "image/jpeg", 300);
		const signed = server.sign(upstream.url);
		const first = await get(server, signed, server.aliceToken);
		expect(first.status).toBe(200);
		expect(first.headers.get("content-type")).toBe("image/jpeg");
		expect(first.headers.get("x-content-type-options")).toBe("nosniff");
		// The upstream's 300 s clamps UP to the 1 h floor.
		expect(first.headers.get("cache-control")).toBe("private, max-age=3600");
		const bytes = Buffer.from(await first.arrayBuffer());
		expect(bytes).toEqual(await jpegBytes());
		expect(upstream.requests).toHaveLength(1);
		// The second request: the cache serves it — no second fetch. The
		// entry file sits under <cacheDir>/images/ keyed sha256(u).
		const second = await get(server, signed, server.aliceToken);
		expect(second.status).toBe(200);
		expect(upstream.requests).toHaveLength(1);
		const key = createHash("sha256").update(upstream.url, "utf8").digest("hex");
		const cached = await readFile(join(server.cacheDir, "images", `${key}.orig`));
		expect(cached).toEqual(await jpegBytes());
	});

	test("max-age clamps down to the 7 d ceiling and defaults to 1 h without an upstream hint", async () => {
		const upstream = await startUpstream();
		cleanups.push(upstream.close);
		const server = await bootServer(upstream);
		upstream.setBody(await jpegBytes(), "image/jpeg", 30 * 24 * 3600);
		const huge = await get(server, server.sign(upstream.url), server.aliceToken);
		expect(huge.headers.get("cache-control")).toBe(
			`private, max-age=${7 * 24 * 3600}`,
		);
		// No upstream Cache-Control at all → the 1 h floor applies.
		upstream.setBody(await jpegBytes(), "image/jpeg", undefined);
		const noHint = await get(
			server,
			server.sign(`${upstream.url}?fresh=1`),
			server.aliceToken,
		);
		expect(noHint.headers.get("cache-control")).toBe("private, max-age=3600");
	});

	test("?as=png converts a JPEG to PNG and caches the converted variant beside the original", async () => {
		const upstream = await startUpstream();
		cleanups.push(upstream.close);
		const server = await bootServer(upstream);
		upstream.setBody(await jpegBytes(), "image/jpeg", 3600);
		const signedPng = `${server.sign(upstream.url)}&as=png`;
		const response = await get(server, signedPng, server.aliceToken);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("image/png");
		const bytes = Buffer.from(await response.arrayBuffer());
		// The PNG magic signature: 89 50 4E 47 0D 0A 1A 0A.
		expect(bytes.subarray(0, 8)).toEqual(
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		);
		const key = createHash("sha256").update(upstream.url, "utf8").digest("hex");
		const orig = await readFile(join(server.cacheDir, "images", `${key}.orig`));
		const converted = await readFile(join(server.cacheDir, "images", `${key}.png`));
		expect(orig.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
		expect(converted).toEqual(bytes);
		// One upstream fetch served BOTH variants.
		expect(upstream.requests).toHaveLength(1);
	});

	test("Review Focus 4: two concurrent requests make ONE upstream fetch", async () => {
		const upstream = await startUpstream();
		cleanups.push(upstream.close);
		const server = await bootServer(upstream);
		const signed = server.sign(upstream.url);
		const [first, second] = await Promise.all([
			get(server, signed, server.aliceToken),
			get(server, signed, server.aliceToken),
		]);
		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		expect(upstream.requests).toHaveLength(1);
	});

	test("an upstream refusal answers 502 naming the reason", async () => {
		const upstream = await startUpstream();
		cleanups.push(upstream.close);
		const server = await bootServer(upstream);
		upstream.setBody(Buffer.from("not an image"), "text/plain", 3600);
		const response = await get(server, server.sign(upstream.url), server.aliceToken);
		expect(response.status).toBe(502);
		expect((await response.json()).error).toBe("bad-type");
	});
});

describe("GET /v1/image (the src form)", () => {
	test("an asset source serves the contained file; a traversal answers 404", async () => {
		const upstream = await startUpstream();
		cleanups.push(upstream.close);
		const server = await bootServer(upstream);
		const asset = await get(
			server,
			`/v1/image?src=${encodeURIComponent("asset:fixture-surfaces-assets/img/a.png")}`,
			server.aliceToken,
		);
		expect(asset.status).toBe(200);
		expect(asset.headers.get("content-type")).toBe("image/png");
		expect(asset.headers.get("x-content-type-options")).toBe("nosniff");
		const traversal = await get(
			server,
			`/v1/image?src=${encodeURIComponent("asset:fixture-surfaces-assets/../../package.json")}`,
			server.aliceToken,
		);
		expect(traversal.status).toBe(404);
		const unknownSlug = await get(
			server,
			`/v1/image?src=${encodeURIComponent("asset:fixture-no-such/x.png")}`,
			server.aliceToken,
		);
		expect(unknownSlug.status).toBe(404);
	});

	test("a data: source serves its bytes; both forms convert under as=png", async () => {
		const upstream = await startUpstream();
		cleanups.push(upstream.close);
		const server = await bootServer(upstream);
		const dataUrl = await pngDataUrl();
		const direct = await get(
			server,
			`/v1/image?src=${encodeURIComponent(dataUrl)}`,
			server.aliceToken,
		);
		expect(direct.status).toBe(200);
		expect(direct.headers.get("content-type")).toBe("image/png");
		// The asset is a PNG already; conversion still answers a PNG.
		const assetPng = await get(
			server,
			`/v1/image?src=${encodeURIComponent("asset:fixture-surfaces-assets/img/a.png")}&as=png`,
			server.aliceToken,
		);
		expect(assetPng.status).toBe(200);
		const assetPngBytes = Buffer.from(await assetPng.arrayBuffer());
		expect(assetPngBytes.subarray(0, 8)).toEqual(
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		);
		expect(assetPng.headers.get("content-type")).toBe("image/png");
	});

	test("a malformed src form → 400 bad_source; an over-long data: URL → 413", async () => {
		const upstream = await startUpstream();
		cleanups.push(upstream.close);
		const server = await bootServer(upstream);
		const malformed = await get(
			server,
			`/v1/image?src=https://img.example.invalid/x.png`,
			server.aliceToken,
		);
		expect(malformed.status).toBe(400);
		expect((await malformed.json()).error).toBe("bad_source");
		const tooLong = `data:image/png;base64,${"A".repeat(192 * 1024 + 8)}`;
		const over = await get(
			server,
			`/v1/image?src=${encodeURIComponent(tooLong)}`,
			server.aliceToken,
		);
		expect(over.status).toBe(413);
	});
});

describe("POST /v1/image (the long data: body form)", () => {
	test("a 200 KiB data URL body → 413 too_large; a 100 KiB one → 200", async () => {
		const upstream = await startUpstream();
		cleanups.push(upstream.close);
		const server = await bootServer(upstream);
		const png = await pngDataUrl();
		// 200 KiB: over the 192 KiB rule → 413 (Fastify's bodyLimit).
		const over = png + "A".repeat(200 * 1024 - png.length);
		const overResponse = await fetch(`${server.listenUrl}/v1/image?as=png`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${server.aliceToken}`,
				"content-type": "text/plain",
			},
			body: over,
		});
		expect(overResponse.status).toBe(413);
		// 100 KiB: under the limit → 200. A data URL of exactly 100 KiB
		// built from the fixture PNG plus base64 padding (the decoded
		// bytes stay the fixture's PNG).
		const pngBase64 = png.split(",")[1] ?? "";
		const targetLength = 100 * 1024;
		const padding = targetLength - "data:image/png;base64,".length - pngBase64.length;
		const body100k = `data:image/png;base64,${pngBase64}${"=".repeat(padding)}`;
		const underResponse = await fetch(`${server.listenUrl}/v1/image?as=png`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${server.aliceToken}`,
				"content-type": "text/plain",
			},
			body: body100k,
		});
		expect(underResponse.status).toBe(200);
		expect(underResponse.headers.get("content-type")).toBe("image/png");
	});
});
