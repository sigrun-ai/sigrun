/**
 * Test-fixture extension package (warden Task 6): the EARLY decision
 * caller — fires ONE `host.decisions.evaluate` from its factory body
 * WITHOUT awaiting it (the documented rule is "never AWAIT a call
 * inside a factory body"; firing one is the wait case: the call's
 * deferreds resolve when boot builds the registry right after
 * `loadExtensions` returns and the bridge binds).
 *
 * Records share the fixture-decision-caller module (one file://
 * instance): the settled result lands in `results`, the in-flight
 * promise in `pending`.
 */

import { defineExtension } from "@earendil-works/pi-durable";
import { pending, results } from "../fixture-decision-caller/index.js";

export default function createFixtureEarlyDecisionCaller(host) {
	pending.push(
		host.decisions
			.evaluate({ state: "acme", questions: { q: { type: "noul" } } })
			.then((result) => results.push(result)),
	);
	return {
		extension: defineExtension({ name: "acme-early-decider" }),
	};
}
