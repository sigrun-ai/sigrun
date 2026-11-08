import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { join } from "node:path";

/** Build the one dist/ tree shared by the test run, before workers start. */
export function setup(): void {
	const root = realpathSync(join(import.meta.dirname, ".."));
	execFileSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" });
}
