/**
 * Malformed-kinds fixture: the factory result declares interactionKinds as
 * a string (not an array) — a contract violation the loader must quarantine
 * fail-loud.
 */
export default function createBadKinds() {
	return {
		extension: {
			name: "sigrun-fixture-seam-bad",
			hooks: [],
			tools: [],
		},
		interactionKinds: "fixture.ask",
	};
}
