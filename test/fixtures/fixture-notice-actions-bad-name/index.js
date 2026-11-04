/**
 * Test-fixture extension package (notices Task 3): `noticeActions` with a
 * handler name outside the grammar — the loader quarantines it.
 */

import { defineExtension } from "@earendil-works/pi-durable";

export default function createFixtureBadName() {
	return {
		extension: defineExtension({ name: "acme-bad-name" }),
		noticeActions: { async "1ping"() {} },
	};
}
