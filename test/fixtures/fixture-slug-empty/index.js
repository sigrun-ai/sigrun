/**
 * Slug-fixture extension (Task 3): declares `@scope/` — a name whose last
 * `/`-segment is EMPTY, so the slug rule yields "". The loader must fail
 * the LOAD (quarantine) naming the declared name, never install it.
 */

export default function createSlugEmpty() {
	return {
		extension: {
			name: "@scope/",
			hooks: [],
			tools: [],
			sections: [],
		},
	};
}
