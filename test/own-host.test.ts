/**
 * The C5 own-host rule (proxy-trust Task 4b): a peer that IS this host
 * (loopback or any current interface address) vouches only when the
 * shared secret is configured or that exact address is explicitly
 * listed in `trustedProxies`. Covers `isOwnHostAddress` (loopback +
 * interface set, `::ffff:` unwrapped), `listedExactly` (bare or /32 /
 * /128 spellings), `ownHostPeerPermitted` (the combined rule), and
 * `listedOwnHostEntries` (the boot-warning projection).
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	isOwnHostAddress,
	listedExactly,
	listedOwnHostEntries,
	ownHostPeerPermitted,
	setOwnHostAddressesForTests,
} from "../src/server/auth/own-host.js";

const TRUSTED_RANGE = ["10.42.0.0/16"];

beforeEach(() => {
	setOwnHostAddressesForTests(["10.42.9.9", "fd00:42::9"]);
});

afterEach(() => {
	setOwnHostAddressesForTests(undefined);
});

describe("isOwnHostAddress", () => {
	test.each([
		"127.0.0.1",
		"127.3.4.5",
		"::1",
		"10.42.9.9",
		"::ffff:10.42.9.9",
		"fd00:42::9",
	])("%s → true", (address) => {
		expect(isOwnHostAddress(address)).toBe(true);
	});

	test.each([["10.42.3.4"], [undefined]])("%s → false", (address) => {
		expect(isOwnHostAddress(address)).toBe(false);
	});

	test("with the seam reset, the real os.networkInterfaces() path still treats loopback as own-host", () => {
		setOwnHostAddressesForTests(undefined);
		expect(isOwnHostAddress("127.0.0.1")).toBe(true);
	});
});

describe("listedExactly", () => {
	test("a /32 entry lists the address exactly", () => {
		expect(listedExactly("127.0.0.1", ["127.0.0.1/32"])).toBe(true);
	});

	test("a bare address lists the address exactly", () => {
		expect(listedExactly("127.0.0.1", ["127.0.0.1"])).toBe(true);
	});

	test("a containing range is NOT an exact listing", () => {
		expect(listedExactly("127.0.0.1", ["127.0.0.0/8"])).toBe(false);
	});

	test("an IPv6 /128 entry lists the address exactly", () => {
		expect(listedExactly("fd00:42::9", ["fd00:42::9/128"])).toBe(true);
	});
});

describe("ownHostPeerPermitted", () => {
	test("own-host via a range without a secret → false", () => {
		expect(ownHostPeerPermitted("10.42.9.9", TRUSTED_RANGE, false)).toBe(false);
	});

	test("own-host via a range WITH a secret → true (the secret check decides next)", () => {
		expect(ownHostPeerPermitted("10.42.9.9", TRUSTED_RANGE, true)).toBe(true);
	});

	test("own-host listed exactly without a secret → true", () => {
		expect(ownHostPeerPermitted("10.42.9.9", ["10.42.9.9/32"], false)).toBe(true);
	});

	test("non-own-host → true (C5 does not constrain remote peers)", () => {
		expect(ownHostPeerPermitted("10.42.3.4", TRUSTED_RANGE, false)).toBe(true);
	});
});

describe("listedOwnHostEntries", () => {
	test("own-host entries (bare or single-host CIDR) are returned; ranges and remote entries are not", () => {
		expect(
			listedOwnHostEntries([
				"127.0.0.1/32",
				"10.42.9.9",
				"10.42.0.0/16",
				"203.0.113.7",
			]),
		).toEqual(["127.0.0.1/32", "10.42.9.9"]);
	});
});
