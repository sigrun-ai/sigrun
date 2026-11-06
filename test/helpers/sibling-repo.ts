/**
 * `siblingRepo(name)` resolves `<toplevel>/../<name>` — a sibling
 * checkout of the current repository. The plan's note: the Playwright
 * harness's `siblingRepo` lives in `webui/e2e/harness.ts`, which the
 * root vitest run excludes, so this is the root-suite copy.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";

/** The absolute path of the sibling repository `name`. */
export function siblingRepo(name: string): string {
	const toplevel = execSync("git rev-parse --show-toplevel", {
		encoding: "utf8",
	}).trim();
	return join(toplevel, "..", name);
}
