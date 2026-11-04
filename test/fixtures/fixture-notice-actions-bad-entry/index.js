/**
 * Test-fixture extension package (notices Task 3): `noticeActions` with a
 * NON-FUNCTION entry — the loader quarantines it.
 */

import { defineExtension } from "@earendil-works/pi-durable";

export default function createFixtureBadEntry() {
	return {
		extension: defineExtension({ name: "acme-bad-entry" }),
		noticeActions: { ping: "not a function" },
	};
}
