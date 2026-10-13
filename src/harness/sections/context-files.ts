/**
 * Context-file prompt sections (spec §3): `SOUL.md` → persona,
 * `AGENTS.md` → workspace instructions.
 *
 * Both files are read through `PromptInput.env` — the same `ExecutionEnv`
 * the harness builds per request — so the sections follow the workspace the
 * conversation actually resolves without this module knowing which. The
 * bare file names resolve against the env's `cwd`: the workspace root unless the
 * conversation narrowed its working directory (`agent.cwd`, T3), in which
 * case the convention follows that directory — the same cwd-anchored
 * `AGENTS.md` convention pi itself uses, and the only anchor upstream's
 * `FileSystem` offers (there is no workspace-root accessor; a path
 * hard-coded here would break remote/container envs).
 *
 * A *missing* file is the designed empty case: `render` returns
 * `undefined` and pi-durable omits the section from the request. Any other
 * read failure is a real error and fails loud — render throws, upstream
 * reports it and keeps the last shown text (verified:
 * dist/harness/prompt.js renderSections).
 */

import type { Context } from "@earendil-works/chord";
import { defineExtension, section } from "@earendil-works/pi-durable";
import type { PromptInput } from "@earendil-works/pi-durable";

/**
 * Read one workspace-root context file for a prompt section render.
 * Resolves `undefined` for the designed empty cases (no env, missing file).
 */
async function readContextFile(
	input: PromptInput,
	fileName: string,
	context: Context,
): Promise<string | undefined> {
	// Without an environment there is nothing to read: an empty section, not
	// an error (upstream leaves `PromptInput.env` undefined when the harness
	// opens without an `env` option).
	const env = input.env;
	if (env === undefined) return undefined;
	const result = await env.readTextFile(fileName, context);
	if (result.ok) return result.value;
	if (result.error.code === "not_found") return undefined;
	throw new Error(
		`Failed to read ${fileName}: ${result.error.message}`,
		{ cause: result.error },
	);
}

/**
 * The context-files extension: `persona` from `SOUL.md` and
 * `workspace-instructions` from `AGENTS.md`, read relative to the
 * conversation env's cwd (the workspace root by default).
 */
export const contextFilesExtension = defineExtension({
	name: "sigrun.context-files",
	sections: [
		section("persona", (input, context) =>
			readContextFile(input, "SOUL.md", context),
		),
		section("workspace-instructions", (input, context) =>
			readContextFile(input, "AGENTS.md", context),
		),
	],
});
