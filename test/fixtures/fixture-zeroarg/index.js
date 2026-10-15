/**
 * Test-fixture extension package: the length-0 factory contract.
 *
 * The loader passes the seam host ONLY to factories that declare the
 * arity-1 signature (factory.length > 0). A zero-arg factory — including
 * one whose first parameter is defaulted (`function createMemory(backend =
 * new Backend())`) — is a closure over its own dependencies and must be
 * invoked with NO arguments: an argument would land in a real dependency
 * slot (the sigrun-ext-memory-markdown regression where the host landed in
 * the `backend` slot and every submit 500ed on `bindRecallSource is not a
 * function`).
 *
 * This fixture fails loud at load time if the loader ever passes it an
 * argument, so the loader test can assert the gate.
 */

import { defineExtension } from "@earendil-works/pi-durable";

export default function createZeroArgFixture() {
	if (arguments.length !== 0) {
		throw new Error(
			`zero-arg factory invoked with ${arguments.length} argument(s)`,
		);
	}
	return {
		extension: defineExtension({
			name: "sigrun.fixture-zeroarg",
			tools: [],
			sections: [],
		}),
	};
}
