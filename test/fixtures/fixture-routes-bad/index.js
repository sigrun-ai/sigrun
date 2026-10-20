/**
 * Test-fixture extension package (core hardening W5 Task 2 — the
 * load-time validation): declares one route whose `path` escapes its
 * mount point (`"../x"`), the quarantine case — the loader validates
 * every `routes` entry at load and a bad path fails the LOAD (the
 * extension is quarantined naming the rule), never a mid-request
 * traversal at serve time.
 */

import { defineExtension } from "@earendil-works/pi-durable";

export default function createFixtureRoutesBad() {
	return {
		extension: defineExtension({ name: "fixture-routes-bad" }),
		routes: [
			{
				method: "GET",
				path: "../x",
				auth: "public",
				handler: async () => new Response("never mounted"),
			},
		],
	};
}
