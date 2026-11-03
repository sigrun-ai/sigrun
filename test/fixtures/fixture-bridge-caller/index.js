/**
 * Test-fixture extension package (core bridge fail-fast, spec §5.2/A1):
 * a `runSettled` handler that calls a BRIDGED host member
 * (`host.users.list()`). Under the fail-fast contract a bridge-less
 * process rejects that call immediately with HostBridgeUnavailableError;
 * the event-bus `#bounded` wrapper must log ONE console.warn per
 * (extension, member) and swallow repeats — the two-settles-one-line
 * shape this fixture exercises.
 *
 * Plain JavaScript so `import(specifier)` resolves it directly. Contract:
 * the default export is an ARITY-1 factory (captures the seam host)
 * returning `{ extension, runSettled }`.
 */

import { defineExtension } from "@earendil-works/pi-durable";

/** Observed outcomes, in delivery order ("listed" | the error's class name). */
export const outcomes = [];

/** Clear the records (tests own their fixtures' state). */
export function resetOutcomes() {
	outcomes.length = 0;
}

/** Default export: factory returning the extension + its bridged runSettled. */
export default function createFixtureBridgeCaller(host) {
	return {
		extension: defineExtension({
			name: "sigrun-fixture-bridge-caller",
		}),
		async runSettled(event, api, context) {
			void event;
			void api;
			void context;
			try {
				await host.users.list();
				outcomes.push("listed");
			} catch (error) {
				outcomes.push(error?.constructor?.name ?? "unknown");
				throw error;
			}
		},
	};
}
