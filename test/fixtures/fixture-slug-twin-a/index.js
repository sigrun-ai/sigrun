/**
 * Slug-fixture extension (Task 3): declares `@acme/tool` — the FIRST of
 * two extensions whose names slug-collide (the last-`/` step drops both
 * scopes, leaving `tool` for each; the spec says that collapse is
 * deliberate). This twin loads; its sibling (fixture-slug-twin-b) must be
 * quarantined at load naming both declared names.
 */

export default function createSlugTwinA() {
	return {
		extension: {
			name: "@acme/tool",
			hooks: [],
			tools: [],
			sections: [],
		},
	};
}
