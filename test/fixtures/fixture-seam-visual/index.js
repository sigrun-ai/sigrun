/**
 * Visual-verification fixture: declares the demo kinds/keys the
 * seam-visual.spec.ts seeds (warden/questionnaire-shaped demo records).
 */
export default function createVisual(host) {
	if (host === undefined) {
		throw new Error("visual fixture requires the host context");
	}
	return {
		interactionKinds: ["gating.confirm", "questions.form"],
		ambientKinds: ["goal", "powerline", "audit", "zones"],
		extension: { name: "sigrun-fixture-visual", hooks: [], tools: [] },
	};
}
