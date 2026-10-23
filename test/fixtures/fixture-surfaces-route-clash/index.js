/**
 * Test-fixture extension package (UI-blocks U3 Task 1): the reserved
 * route-prefix case (spec §7.2) — an extension declaring an HTTP route
 * under `surfaces/` (a core-owned prefix under `/v1/ext/<slug>/`)
 * quarantines at load, naming the route.
 */

import { defineExtension } from "@earendil-works/pi-durable";

export default function createFixtureSurfacesRouteClash() {
	return {
		extension: defineExtension({ name: "fixture-surfaces-route-clash" }),
		routes: [
			{
				method: "GET",
				path: "surfaces/x",
				auth: "public",
				handler: async () => new Response("never mounted"),
			},
		],
	};
}
