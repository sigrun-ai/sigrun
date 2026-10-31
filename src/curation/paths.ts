/**
 * Curator path helpers (P2): the per-user learned skills root and the
 * per-user curation state directory, both derived from the managed user
 * area (`<dataDir>/users/<user>` — `ManagedPaths.userAreas`).
 *
 * Pure derivations: no filesystem access, no validation — the sandbox
 * policy owns creation and the grant validators own admission.
 */

import { join } from "node:path";

/** The owner's learned skills root: `<userArea>/skills`. */
export function learnedSkillsDir(userArea: string): string {
	return join(userArea, "skills");
}

/** The owner's curation state directory: `<userArea>/curation`. */
export function curationDir(userArea: string): string {
	return join(userArea, "curation");
}
