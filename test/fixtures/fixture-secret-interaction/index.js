/** Test-only interaction kind whose root form contains a secret field. */

import { defineExtension } from "@earendil-works/pi-durable";

export default function createSecretInteractionFixture(host) {
	if (host === undefined) throw new Error("secret interaction fixture requires the host");
	return {
		interactionKinds: ["fixture.secret"],
		extension: defineExtension({ name: "fixture-secret-interaction" }),
	};
}
