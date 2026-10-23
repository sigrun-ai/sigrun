/**
 * Test-fixture extension package (gateway C2): the SECOND gateway engine
 * — declares another `gateway` so the one-engine rule's test can load it
 * after fixture-gateway-engine and assert the quarantine naming the first
 * slug. Any valid engine shape suffices (the rule keys on the field
 * alone). The twin does NOT carry `runSettled` — only the ordering test's
 * engine needs it.
 *
 * Plain JavaScript so `import(specifier)` resolves it directly. Contract:
 * the default export is an arity-0 factory returning `{ extension, gateway }`.
 */

import { defineExtension } from "@earendil-works/pi-durable";

export default function createFixtureGatewayEngineTwin() {
	return {
		extension: defineExtension({
			name: "fixture-gateway-engine-twin",
			sections: [],
		}),
		gateway: {
			async start() {},
			async stopIntake() {},
			async stop() {},
			health() {
				return "ok";
			},
		},
	};
}
