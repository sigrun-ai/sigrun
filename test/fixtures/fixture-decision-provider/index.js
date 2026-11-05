/**
 * Test-fixture extension package (warden Task 6): a DECISION PROVIDER,
 * contributor-only (a factory result carrying `decisionProviders` with
 * no `extension`). Provider `acme-judge`, models `judge-1` and
 * `judge-2`, `credentialEnv` TYPESAFE_API_KEY (the tests own these
 * literals). Every `evaluate` records `{request, model, credential,
 * caller}` module-side (the fixture-hook-provider pattern: the loader
 * and the test import the SAME file:// URL, one module instance) and
 * answers every question with the matching wire type.
 *
 * `setProviderDelay(ms)` makes the provider slow (the timeout test):
 * the sleep honours the ctx signal's abort, so a capped call settles
 * promptly instead of running out the full delay.
 *
 * Plain JavaScript so `import(specifier)` resolves it directly.
 */

/** Every provider call: `{request, model, credential, caller}`. */
export const calls = [];

let delayMs = 0;
// Warden Task 7: the fixture's readiness tracker state. Default
// "not_configured" — a fresh boot with no credential resolved; tests
// flip it via `setReadiness` (the route suite's no-restart flip).
let readinessStatus = "not_configured";

/** Make the provider slow (0 restores the instant answer). */
export function setProviderDelay(ms) {
	delayMs = ms;
}

/** Set the readiness the tracker reports (warden Task 7). */
export function setReadiness(status) {
	readinessStatus = status;
}

/** Clear the records (tests own their fixtures' state). */
export function resetDecisionProvider() {
	calls.length = 0;
	delayMs = 0;
	readinessStatus = "not_configured";
}

/** A schema-valid answer set covering exactly the request's questions. */
function answersFor(request) {
	const answers = {};
	for (const [key, question] of Object.entries(request.questions)) {
		if (question.type === "noul") {
			answers[key] = { type: "noul", noul: 0.5 };
		} else if (question.type === "choice") {
			const label = Object.keys(question.criteria)[0];
			answers[key] = {
				type: "choice",
				choice: label,
				confidence: 1,
				probabilities: { [label]: 1 },
			};
		} else {
			answers[key] = {
				type: "score",
				score: 0,
				confidence: 1,
				probabilities: { "0": 1 },
			};
		}
	}
	return { answers };
}

function sleep(ms, signal) {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}

export default function createFixtureDecisionProvider() {
	return {
		name: "acme-judge",
		decisionProviders: [
			{
				id: "acme-judge",
				label: "Acme Judge",
				credentialEnv: "TYPESAFE_API_KEY",
			models: [{ id: "judge-1" }, { id: "judge-2" }],
			readiness() {
				return { status: readinessStatus };
			},
			async evaluate(request, ctx) {
					calls.push({
						request,
						model: ctx.model,
						credential: ctx.credential,
						caller: ctx.caller,
					});
					if (delayMs > 0) await sleep(delayMs, ctx.signal);
					return answersFor(request);
				},
			},
		],
	};
}
