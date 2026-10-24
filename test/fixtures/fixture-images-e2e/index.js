/**
 * The images e2e fixture extension (UI-blocks U7 Task 3): ONE view whose
 * tree carries an `image` block with a literal `https://` src — the
 * server rewrites it to a signed `/v1/image?u=…` URL at serve time
 * (Task 1), and the e2e asserts the browser's img element points at the
 * proxy and RENDERS (naturalWidth > 0) against the spec's local TLS
 * image server, whose fetch counter proves the cache served the second
 * load.
 */

import { markdown, page, tree } from "@sigrun/sigrun/blocks";

/** The image URL the fixture's tree carries; the e2e sets it to the
 *  local TLS image server BEFORE the first render. */
let imageUrl = "https://img.example.invalid/placeholder.png";

export function setFixtureImageUrl(u) {
	imageUrl = u;
}

export default function createFixtureImagesE2E() {
	return {
		extension: {
			name: "fixture-images-e2e",
			hooks: [],
			tools: [],
			sections: [],
		},
		surfaces: {
			views: [
				{
					id: "shots",
					title: "Acme shots",
					icon: "image",
					placement: "view",
					render: async () => ({
						tree: tree(
							page({
								id: "shots",
								title: "Acme shots",
								main: [
									// The generic webui tree renderer (U1's BlockView)
									// renders markdown blocks — including an image
									// markdown link, whose URL Task 1's rewriter
									// turns into the signed /v1/image proxy form.
									// (The interim ext-surface page does NOT render a
									// bare `image` block — it boards collections and
									// dumps other data as JSON.)
									markdown({
										id: "shot",
										text: `![an acme shot](${imageUrl})`,
									}),
								],
							}),
						),
						data: {},
						access: "write",
					}),
				},
			],
		},
	};
}
