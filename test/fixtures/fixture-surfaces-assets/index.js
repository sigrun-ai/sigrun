/**
 * Test-fixture extension package (UI-blocks U3 Task 3, spec §11.1):
 * the assets-serving counterpart of fixture-surfaces — declares
 * `sigrun.assets` in its package manifest and one trivial surface so
 * the loader retains the binding. The asset files live in `assets/`
 * (a real PNG in `assets/img/`); the assets test creates the
 * symlink-out case at runtime.
 */

const notesTree = {
	v: 1,
	root: {
		type: "page",
		id: "notes",
		title: "Acme notes",
		main: [{ type: "markdown", id: "note", text: "acme assets fixture" }],
	},
};

export default function createFixtureSurfacesAssets() {
	return {
		extension: {
			name: "fixture-surfaces-assets",
			hooks: [],
			tools: [],
			sections: [],
		},
		surfaces: {
			views: [
				{
					id: "notes",
					title: "Acme notes",
					icon: "board",
					placement: "view",
					render: async () => ({
						tree: notesTree,
						data: {},
						access: "write",
					}),
				},
			],
		},
	};
}
