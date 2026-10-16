/**
 * Slug-fixture extension (Task 3): declares `@other/tool` — the SECOND of
 * two slug-colliding extensions (both slug to `tool`; see
 * fixture-slug-twin-a). The loader must quarantine THIS load naming both
 * declared names; the first twin stays installed.
 */

export default function createSlugTwinB() {
	return {
		extension: {
			name: "@other/tool",
			hooks: [],
			tools: [],
			sections: [],
		},
	};
}
