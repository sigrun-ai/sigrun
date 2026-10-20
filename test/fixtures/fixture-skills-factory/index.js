/**
 * Test-fixture extension (core hardening W5 Task 4): a loadable factory
 * whose result carries the `skills` field — absolute skill directories
 * the loader validates (existing) and contributes to the skills section.
 * The dirs point at fixture-skills-only's skills dir (computed at import
 * time, so the fixture works from any checkout location).
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineExtension } from "@earendil-works/pi-durable";

const skillsDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"fixture-skills-only",
	"skills",
);

/** Default export: factory returning the extension plus its skill dirs. */
export default function createSkillsFactoryFixture() {
	return {
		extension: defineExtension({
			name: "sigrun-fixture-skills-factory",
			sections: [],
			tools: [],
		}),
		skills: [skillsDir],
	};
}
