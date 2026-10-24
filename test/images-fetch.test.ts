/**
 * UI-blocks U7 Task 2: vetted-address fetching (spec §11.2 verbatim
 * fetching rules; §16 Images tests — the three review-focus cases:
 * DNS rebinding, redirect vetting, the slow-drip deadline).
 *
 * The harness runs a real TLS server bound to `::` with a self-signed
 * cert issued for `example.invalid` and trusted ONLY through
 * `deps.ca` (the process trust store is never touched). The injected
 * resolver hands the fetcher the server's real routable address,
 * which stands in for `203.0.113.5`-style public documentation IPs
 * in the connection tests (a documentation IP is not dialable; the
 * range table keeps `203.0.113.5` itself as a pure literal row).
 *
 * Literals are synthetic (`example.invalid`, documentation IPs);
 * tests own their values.
 */

import { createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as https from "node:https";
import { networkInterfaces } from "node:os";
import { afterAll, describe, expect, test, vi } from "vitest";
import { FETCH_MAX_REDIRECTS, FETCH_TIMEOUT_MS, fetchImage, type FetchDeps } from "../src/server/images/fetch.js";
import { isRefusedAddress } from "../src/server/images/ranges.js";
import { sniffImage } from "../src/server/images/sniff.js";

/** A 1×1 PNG. */
const PNG_BYTES = Buffer.from(
	"89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
		"1f15c4890000000a49444154789c6300010000050001" +
		"0d0a2db40000000049454e44ae426082",
	"hex",
);
/** A minimal JPEG (SOI + APP0/JFIF + EOI). */
const JPEG_BYTES = Buffer.from("ffd8ffe000104a46494600010100000100010000ffd9", "hex");
/** SVG bytes with a misleading PNG content type in the tests. */
const SVG_BYTES = Buffer.from(
	'<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>',
	"utf8",
);
/** AVIF bytes (an `ftyp` box whose brand is `avif`, at offset 4). */
const AVIF_BYTES = Buffer.concat([
	Buffer.alloc(4),
	Buffer.from("ftypavif", "latin1"),
	Buffer.alloc(16, 1),
]);

// ---------------------------------------------------------------------------
// DER plumbing: the test issues its own self-signed certificate so no
// external tool, file, or network is needed. (Node 26 ships no cert
// API; `X509Certificate` only parses.)
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
		Buffer.from([0x06, 0x03, 0x55, 0x04, 0x03]), // OID 2.5.4.3 commonName
		Buffer.from([0x0c, value.length]), // UTF8String
		Buffer.from(value, "utf8"),
	]);
	// Name ::= SEQUENCE OF RDN; RDN ::= SET OF AttributeTypeAndValue;
	// AttributeTypeAndValue ::= SEQUENCE { type, value }.
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

/** The self-signed cert for `example.invalid` over one fresh RSA key. */
function selfSigned(): { certPem: string; keyPem: string } {
	const { publicKey, privateKey } = generateKeyPairSync("rsa", {
		modulusLength: 2048,
	});
	const name = cn("example.invalid");
	const validity = der(0x30, Buffer.concat([
		utcTime(new Date(Date.now() - 60_000)),
		utcTime(new Date(Date.now() + 86_400_000)),
	]));
	// TBSCertificate: [0] version 3, serial, sigalg, issuer (self),
	// validity, subject, SPKI (the exported DER is already a SEQUENCE).
	// The serial keeps its first byte 0x01 so the INTEGER is positive
	// (high bit clear) and minimal (no leading zero) — a raw
	// randomBytes serial hits DER "illegal padding" on ~1% of certs
	// (leading 0x00) and reads negative on ~50% (0x80+). 
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
// The TLS harness
// ---------------------------------------------------------------------------

type Handler = (
	req: IncomingMessage,
	res: ServerResponse,
) => void;

interface TlsHarness {
	/** `FetchDeps` minus `resolve`. */
	deps: Omit<FetchDeps, "resolve">;
	/** The listening port (the hostname is always example.invalid). */
	port: number;
	/** The remote address of every connection, in order. */
	remoteAddresses(): string[];
	/** How many TCP connections the server has accepted, in order. */
	connectionCount(): number;
	/** Swap the response handler (a fresh harness starts with PNG). */
	onRequest(handler: Handler): void;
	close(): Promise<void>;
}

/** A self-signed TLS server on `::` + the `ca` that trusts it. */
async function startHarness(): Promise<TlsHarness> {
	const { certPem, keyPem } = selfSigned();
	const remotes: string[] = [];
	let handler: Handler = (_req, res) => {
		res.writeHead(200, { "content-type": "image/png" });
		res.end(PNG_BYTES);
	};
	const server = https.createServer(
		{ key: keyPem, cert: certPem },
		(req, res) => {
			remotes.push(String(req.socket.remoteAddress));
			handler(req, res);
		},
	);
	await new Promise<void>((resolve) => server.listen(0, "::", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new Error("TLS harness has no port");
	}
	let connections = 0;
	server.on("connection", () => {
		connections += 1;
	});
	return {
		deps: { now: Date.now, ca: Buffer.from(certPem, "utf8") },
		port: address.port,
		// Normalize IPv4-mapped remotes ("::ffff:192.0.2.5") to the bare
		// IPv4 literal so assertions match both the v6 and the v4
		// public stand-in shapes.
		remoteAddresses: () =>
			remotes.map((remote) => remote.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, "$1")),
		connectionCount: () => connections,
		onRequest(next) {
			handler = next;
		},
		close: () =>
			new Promise((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

/**
 * This host's first global IPv6 address: the stand-in for a public
 * address the vetting passes (documentation IPs are not dialable, so
 * the connection tests dial this one while the range table keeps the
 * `203.0.113.5` literal rows pure). Hosts with no global IPv6 (suite
 * portability) fall back to the first non-internal IPv4 the vetting
 * accepts.
 */
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

/** `FetchDeps.resolve` over a scripted answer list (last entry repeats). */
function resolver(answers: string[][]): {
	deps: Pick<FetchDeps, "resolve">;
	calls(): string[];
} {
	const seen: string[] = [];
	return {
		deps: {
			resolve(host: string): Promise<string[]> {
				seen.push(host);
				const answer = answers[Math.min(seen.length - 1, answers.length - 1)] ?? [];
				return Promise.resolve([...answer]);
			},
		},
		calls: () => [...seen],
	};
}

/** `https://example.invalid:<port><path>` — every test's URL shape. */
function urlFor(harness: TlsHarness, path = "/x.png"): string {
	return `https://example.invalid:${harness.port}${path}`;
}

const closers: Array<() => Promise<void>> = [];

/** The REAL `setTimeout`, captured before any test fakes it, so
 * deadline tests can still let real I/O settle between advances. */
const realSetTimeout = globalThis.setTimeout;
/** Real-clock sleep (milliseconds) that ignores faked timers. */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		realSetTimeout(resolve, ms);
	});
}
afterAll(async () => {
	for (const close of closers.splice(0)) await close();
});

/** A harness closed at teardown. */
async function harness(): Promise<TlsHarness> {
	const h = await startHarness();
	closers.push(() => h.close());
	return h;
}

// ---------------------------------------------------------------------------
// isRefusedAddress — one address per refused range, mapped forms, and
// the public stand-ins that must pass.
// ---------------------------------------------------------------------------

describe("isRefusedAddress", () => {
	test("refuses one address from every range", () => {
		const refused = [
			// IPv4
			"0.0.0.1", // 0.0.0.0/8
			"127.0.0.1", // 127.0.0.0/8
			"10.0.0.1", // 10.0.0.0/8
			"172.16.0.1", // 172.16.0.0/12 (first)
			"172.31.255.255", // 172.16.0.0/12 (last)
			"192.168.1.1", // 192.168.0.0/16
			"169.254.169.254", // 169.254.0.0/16 (the metadata address)
			"100.64.0.1", // 100.64.0.0/10 (first)
			"100.127.255.255", // 100.64.0.0/10 (last)
			"224.0.0.1", // 224.0.0.0/4 (first)
			"239.255.255.255", // 224.0.0.0/4 (last)
			"255.255.255.255", // the broadcast literal
			// IPv6
			"::", // ::/128
			"::1", // ::1/128
			"fc00::1", // fc00::/7 (first)
			"fd12:3456::1", // fc00::/7 (second half)
			"fe80::1", // fe80::/10
			"ff02::1", // ff00::/8
		];
		for (const ip of refused) {
			expect(isRefusedAddress(ip), ip).toBe(true);
		}
	});

	test("refuses the IPv4-mapped IPv6 form of every refused IPv4 range", () => {
		const mapped = [
			"::ffff:0.0.0.1",
			"::ffff:127.0.0.1",
			"::ffff:10.0.0.1",
			"::ffff:172.16.0.1",
			"::ffff:192.168.1.1",
			"::ffff:169.254.169.254",
			"::ffff:100.64.0.1",
			"::ffff:224.0.0.1",
			"::ffff:255.255.255.255",
		];
		for (const ip of mapped) {
			expect(isRefusedAddress(ip), ip).toBe(true);
		}
	});

	test("accepts public addresses", () => {
		// 203.0.113.5 and 192.0.2.1 are documentation ranges — the
		// tests' stand-in public addresses — so they MUST pass.
		expect(isRefusedAddress("203.0.113.5")).toBe(false);
		expect(isRefusedAddress("192.0.2.1")).toBe(false);
		expect(isRefusedAddress("2001:db8::1")).toBe(false);
	});

	test("refuses just-outside range edges and non-IP strings (fail closed)", () => {
		expect(isRefusedAddress("172.32.0.1")).toBe(false); // above /12
		expect(isRefusedAddress("100.128.0.1")).toBe(false); // above /10
		expect(isRefusedAddress("example.invalid")).toBe(true); // not an IP
	});
});

// ---------------------------------------------------------------------------
// sniffImage
// ---------------------------------------------------------------------------

describe("sniffImage", () => {
	test("sniffs each accepted type from its magic bytes", () => {
		expect(sniffImage(PNG_BYTES)).toBe("png");
		expect(sniffImage(JPEG_BYTES)).toBe("jpeg");
		expect(sniffImage(Buffer.from("GIF89a\x01\x00\x01\x00\x00", "latin1"))).toBe("gif");
		expect(
			sniffImage(
				Buffer.concat([Buffer.from("RIFF\x24\x00\x00\x00WEBPVP8 ", "latin1"), Buffer.alloc(8)]),
			),
		).toBe("webp");
	});

	test("identifies SVG and AVIF (the refused types)", () => {
		expect(sniffImage(SVG_BYTES)).toBe("svg");
		expect(sniffImage(AVIF_BYTES)).toBe("avif");
	});

	test("returns undefined for non-images", () => {
		expect(sniffImage(Buffer.from("hello world", "utf8"))).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// fetchImage — the happy path and the three review-focus cases.
// ---------------------------------------------------------------------------

describe("fetchImage", () => {
	test("fetches a PNG over the vetted address", async () => {
		const h = await harness();
		const standIn = publicStandIn();
		const r = resolver([[standIn]]);
		const image = await fetchImage(urlFor(h), {
			...h.deps,
			resolve: r.deps.resolve,
		});
		expect(image.type).toBe("png");
		expect(image.bytes.equals(PNG_BYTES)).toBe(true);
		expect(h.remoteAddresses()).toEqual([standIn]);
	});

	test("passes max-age through from the final response", async () => {
		const h = await harness();
		h.onRequest((_req, res) => {
			res.writeHead(200, {
				"content-type": "image/png",
				"cache-control": "public, max-age=3600",
			});
			res.end(PNG_BYTES);
		});
		const image = await fetchImage(urlFor(h), {
			...h.deps,
			resolve: resolver([[publicStandIn()]]).deps.resolve,
		});
		expect(image.maxAge).toBe(3600);
	});

	test("refuses a non-https scheme", async () => {
		const h = await harness();
		const r = resolver([[publicStandIn()]]);
		await expect(
			fetchImage(`http://example.invalid:${h.port}/x.png`, {
				...h.deps,
				resolve: r.deps.resolve,
			}),
		).rejects.toThrow(/not https:/);
		expect(r.calls()).toEqual([]);
	});

	test("refuses a host where ANY resolved address is private", async () => {
		const h = await harness();
		await expect(
			fetchImage(urlFor(h), {
				...h.deps,
				resolve: resolver([[publicStandIn(), "10.0.0.7"]]).deps.resolve,
			}),
		).rejects.toThrow(/refused address 10\.0\.0\.7/);
		expect(h.remoteAddresses()).toEqual([]); // never connected
	});

	// Review Focus 1: DNS rebinding. The resolver answers a public
	// address first and 127.0.0.1 on any second call; the connection
	// must use the FIRST, vetted address (asserted via the test
	// server's socket remote address).
	test("rebinding: connects to the first vetted address, never loopback", async () => {
		const h = await harness();
		const first = publicStandIn();
		const r = resolver([[first], ["127.0.0.1"]]);
		const image = await fetchImage(urlFor(h), {
			...h.deps,
			resolve: r.deps.resolve,
		});
		expect(image.bytes.equals(PNG_BYTES)).toBe(true);
		expect(r.calls()).toEqual(["example.invalid"]); // resolved ONCE
		// The socket the server saw is the vetted public address —
		// never 127.0.0.1, even though the resolver offered it second.
		expect(h.remoteAddresses()).toEqual([first]);
	});

	// Review Focus 2: redirects. http: and private targets are
	// refused, and every hop (accepted or refused) counts against the
	// budget of 3.
	test("follows an https redirect to a vetted address", async () => {
		const h = await harness();
		h.onRequest((req, res) => {
			if (req.url === "/start") {
				res.writeHead(302, { location: "/x.png" });
				res.end();
				return;
			}
			res.writeHead(200, { "content-type": "image/png" });
			res.end(PNG_BYTES);
		});
		const standIn = publicStandIn();
		const image = await fetchImage(urlFor(h, "/start"), {
			...h.deps,
			resolve: resolver([[standIn], [standIn]]).deps.resolve,
		});
		expect(image.type).toBe("png");
	});

	test("refuses an http: redirect", async () => {
		const h = await harness();
		const standIn = publicStandIn();
		h.onRequest((_req, res) => {
			res.writeHead(302, { location: `http://example.invalid:${h.port}/x.png` });
			res.end();
		});
		await expect(
			fetchImage(urlFor(h), {
				...h.deps,
				resolve: resolver([[standIn], [standIn]]).deps.resolve,
			}),
		).rejects.toThrow(/redirect to http:/);
	});

	test("refuses a redirect whose target host resolves private", async () => {
		const h = await harness();
		const standIn = publicStandIn();
		h.onRequest((_req, res) => {
			res.writeHead(302, { location: "https://private.example.invalid/y.png" });
			res.end();
		});
		const r = resolver([[standIn], ["192.168.1.50"]]);
		await expect(
			fetchImage(urlFor(h), {
				...h.deps,
				resolve: r.deps.resolve,
			}),
		).rejects.toThrow(/refused address 192\.168\.1\.50/);
	});

	test("refuses a fourth redirect (budget of 3 in total)", async () => {
		const h = await harness();
		const standIn = publicStandIn();
		h.onRequest((req, res) => {
			res.writeHead(302, { location: `${req.url}n` });
			res.end();
		});
		const r = resolver(Array.from({ length: FETCH_MAX_REDIRECTS + 2 }, () => [standIn]));
		await expect(
			fetchImage(urlFor(h, "/hop"), {
				...h.deps,
				resolve: r.deps.resolve,
			}),
		).rejects.toThrow(/too many redirects|over 3 redirects/);
		// The refused fourth attempt still counted: exactly 3 redirects
		// were followed (4 request hops total).
		expect(r.calls()).toHaveLength(FETCH_MAX_REDIRECTS + 1);
	});

	// Review Focus 3: a 1-byte-per-second drip is cut at the 10 s
	// TOTAL deadline, not a per-read timeout. Each drip byte arrives
	// well within any socket idle timeout — only the whole-fetch
	// budget kills it. Vitest fake timers stand in for the 10 s of wall
	// clock (`setTimeout` only — the socket machinery keeps its real
	// timers so the drip itself keeps flowing).
	test("cuts a drip response at the 10s total deadline", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout"] });
		try {
			const h = await harness();
			h.onRequest((_req, res) => {
				res.writeHead(200, { "content-type": "image/png" });
				// One byte per second, forever; PNG_BYTES' first byte first
				// so the body alone can never satisfy the sniffer.
				res.write(PNG_BYTES.subarray(0, 1));
				const drip = setInterval(() => {
					res.write("x");
				}, 1000);
				res.on("close", () => clearInterval(drip));
			});
			const attempt = fetchImage(urlFor(h), {
				...h.deps,
				resolve: resolver([[publicStandIn()]]).deps.resolve,
			});
			// Attach the assertion BEFORE advancing so the (guaranteed)
			// rejection is never momentarily unhandled.
			const assertion = expect(attempt).rejects.toThrow(/^deadline reached reading body$/);
			// Let the real I/O (handshake, headers, first drip byte)
			// settle first: otherwise the fake advance fires the
			// connect+header phase's timer instead of exercising the
			// body-read deadline. `sleep` uses the captured REAL
			// `setTimeout`, untouched by the fake.
			await sleep(1_200);
			// Advance the 10 s budget while the drip keeps delivering
			// bytes within every per-read window.
			await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS + 100);
			await assertion;
		} finally {
			vi.useRealTimers();
		}
	}, 20_000);

	// Deadline absoluteness (review finding 2a): a resolver that never
	// resolves has NO socket, so no socket timeout could ever cut it —
	// only the absolute whole-fetch deadline does.
	test("cuts a resolver that never resolves at the 10s total deadline", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout"] });
		try {
			const attempt = fetchImage("https://example.invalid/x.png", {
				now: Date.now,
				// A resolver that neither resolves nor rejects, forever.
				resolve: () => new Promise<string[]>(() => {}),
			});
			const assertion = expect(attempt).rejects.toThrow(
				/deadline reached resolving example\.invalid/,
			);
			await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS + 100);
			await assertion;
		} finally {
			vi.useRealTimers();
		}
	});

	// Deadline absoluteness (review finding 2b): a server dripping
	// HEADER bytes one per 9 s stays inside every socket-inactivity
	// window forever — `req.setTimeout` could never cut it. The
	// absolute connect+header deadline timer does.
	test("cuts a header-drip server at the 10s total deadline", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout"] });
		try {
			const h = await harness();
			h.onRequest((_req, res) => {
				// Raw socket writes: a status line that never completes.
				res.socket?.write("HTTP/1.1 200 OK\\r");
				const drip = setInterval(() => {
					res.socket?.write("x");
				}, 9_000);
				res.on("close", () => clearInterval(drip));
			});
			const attempt = fetchImage(urlFor(h), {
				...h.deps,
				resolve: resolver([[publicStandIn()]]).deps.resolve,
			});
			const assertion = expect(attempt).rejects.toThrow(
				/deadline reached awaiting headers from example\.invalid/,
			);
			// Let the connection establish and the first header byte land
			// (the next one would be 9 s later on the real clock).
			await sleep(500);
			await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS + 100);
			await assertion;
		} finally {
			vi.useRealTimers();
		}
	}, 20_000);

	// No agent reuse across hops (review finding 1): a same-origin
	// redirect must open a SECOND TCP connection — Node >= 19's default
	// keep-alive agent would serve the second hop from the pooled
	// first-hop socket, whose `lookup` (and vetted address) is the
	// first hop's. The second `resolve` stalls ~300 ms so the first
	// hop's socket has long settled into any keep-alive pool: if the
	// fetcher did not pass `agent: false`, hop 2 would ride the pooled
	// socket and the server would see ONE connection.
	test("a same-origin redirect uses two connections (no agent reuse)", async () => {
		const h = await harness();
		h.onRequest((req, res) => {
			if (req.url === "/start") {
				res.writeHead(302, { location: "/x.png" });
				res.end();
				return;
			}
			res.writeHead(200, { "content-type": "image/png" });
			res.end(PNG_BYTES);
		});
		const standIn = publicStandIn();
		let calls = 0;
		const resolve: FetchDeps["resolve"] = (_host) => {
			calls += 1;
			if (calls === 1) return Promise.resolve([standIn]);
			// The redirect hop's resolution stalls: any pooled first-hop
			// socket is FREE by the time hop 2 connects.
			return new Promise<string[]>((r) => {
				setTimeout(() => r([standIn]), 300);
			});
		};
		const image = await fetchImage(urlFor(h, "/start"), { ...h.deps, resolve });
		expect(image.type).toBe("png");
		// Two hops, TWO TCP connections — the pooled-socket shortcut
		// never happened.
		expect(h.connectionCount()).toBe(2);
		expect(h.remoteAddresses()).toEqual([standIn, standIn]);
	});

	test("refuses a body over 10 MiB", async () => {
		const h = await harness();
		const standIn = publicStandIn();
		h.onRequest((_req, res) => {
			res.writeHead(200, { "content-type": "image/png" });
			// 11 MiB: PNG magic then filler, well over the cap.
			const filler = Buffer.alloc(11 * 1024 * 1024, 0x41);
			res.end(Buffer.concat([PNG_BYTES, filler]));
		});
		await expect(
			fetchImage(urlFor(h), {
				...h.deps,
				resolve: resolver([[standIn]]).deps.resolve,
			}),
		).rejects.toThrow(/over 10485760 bytes/);
	}, 20_000);

	test("refuses SVG bytes even with an image/png content type", async () => {
		const h = await harness();
		h.onRequest((_req, res) => {
			res.writeHead(200, { "content-type": "image/png" });
			res.end(SVG_BYTES);
		});
		await expect(
			fetchImage(urlFor(h), {
				...h.deps,
				resolve: resolver([[publicStandIn()]]).deps.resolve,
			}),
		).rejects.toThrow(/sniffed as svg/);
	});

	test("refuses AVIF bytes even with an image/png content type", async () => {
		const h = await harness();
		h.onRequest((_req, res) => {
			res.writeHead(200, { "content-type": "image/png" });
			res.end(AVIF_BYTES);
		});
		await expect(
			fetchImage(urlFor(h), {
				...h.deps,
				resolve: resolver([[publicStandIn()]]).deps.resolve,
			}),
		).rejects.toThrow(/sniffed as avif/);
	});

	test("refuses a non-image body", async () => {
		const h = await harness();
		h.onRequest((_req, res) => {
			res.writeHead(200, { "content-type": "image/png" });
			res.end(Buffer.from("just text, honest", "utf8"));
		});
		await expect(
			fetchImage(urlFor(h), {
				...h.deps,
				resolve: resolver([[publicStandIn()]]).deps.resolve,
			}),
		).rejects.toThrow(/did not sniff/);
	});

	test("refuses an http error status", async () => {
		const h = await harness();
		h.onRequest((_req, res) => {
			res.writeHead(404, { "content-type": "text/plain" });
			res.end("no such image");
		});
		await expect(
			fetchImage(urlFor(h), {
				...h.deps,
				resolve: resolver([[publicStandIn()]]).deps.resolve,
			}),
		).rejects.toThrow(/status 404/);
	});

	test("keeps the original host for SNI and the Host header", async () => {
		const h = await harness();
		const seenHosts: string[] = [];
		h.onRequest((req, res) => {
			seenHosts.push(String(req.headers.host));
			res.writeHead(200, { "content-type": "image/png" });
			res.end(PNG_BYTES);
		});
		await fetchImage(urlFor(h), {
			...h.deps,
			resolve: resolver([[publicStandIn()]]).deps.resolve,
		});
		// Host stays the ORIGINAL name (with the port), never the
		// resolved address; TLS already proved SNI matched the cert.
		expect(seenHosts).toEqual([`example.invalid:${h.port}`]);
	});

	test("range-checks an IP-literal host through the resolver path", async () => {
		const h = await harness();
		// A literal URL host: the resolver (the real one passes
		// literals through verbatim) still answers it, and the vetting
		// refuses the loopback literal before any connection.
		const r = resolver([["127.0.0.1"]]);
		await expect(
			fetchImage(`https://127.0.0.1:${h.port}/x.png`, {
				...h.deps,
				resolve: r.deps.resolve,
			}),
		).rejects.toThrow(/refused address 127\.0\.0\.1/);
		expect(h.remoteAddresses()).toEqual([]);
	});

	test("refuses a URL that is not parseable", async () => {
		const h = await harness();
		await expect(
			fetchImage("not a url at all", {
				...h.deps,
				resolve: resolver([[publicStandIn()]]).deps.resolve,
			}),
		).rejects.toThrow(/not a URL/);
	});
});
