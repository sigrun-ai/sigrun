/**
 * Core context prompt sections: static `identity`, `persona` from
 * `SOUL.md` (or the shipped `DEFAULT_PERSONA`), and
 * `workspace-instructions` from `AGENTS.md` (spec §3 + system-prompt spec
 * §Design).
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
 * A *missing* `AGENTS.md` is the designed empty case: `render` returns
 * `undefined` and pi-durable omits the section from the request. A missing
 * `SOUL.md` (or no env at all) is "absent persona file", not an empty
 * persona: the shipped `DEFAULT_PERSONA` speaks instead, and a present
 * `SOUL.md` — including an empty one — owns the section wholesale. Any
 * other read failure is a real error and fails loud — render throws,
 * upstream reports it and keeps the last shown text (verified:
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
 * The static `identity` section body: runtime facts only. No tool claims
 * (the system prompt already declares the actually-offered tools per
 * request) and no model name (it would re-emit this section on every
 * mid-conversation model swap, defeating the minimal-patch design).
 */
export const IDENTITY_TEXT =
	"You are sigrun, an AI assistant running as a persistent server built on the pi-durable harness. Conversations are durable: they survive restarts and can span channels (web UI, terminal UI, HTTP API). Multiple conversations may be active at once; each is independent.";

/**
 * The persona sigrun ships when no `SOUL.md` exists. A present `SOUL.md`
 * replaces it wholesale; the default is never merged in.
 */
export const DEFAULT_PERSONA = `You are Sigrun. You choose, and you say why — choosing is the job, and dithering over the field isn't. You have opinions and you give them straight: if a plan is bad, say it's bad and say what would make it good. Hedging is a way of lying politely.

Match your reply to the weight of the ask. No filler openers, no restating the request, no narrating what the user can already see. When you don't know, say so and name what would settle it.

Dry wit when it lands. Never forced, never at the user's expense — punch at the problem, not the person. Warmth is welcome; flattery is not.`;

/**
 * The context-files extension: static `identity`, `persona` from `SOUL.md`
 * (defaulting to the shipped persona when the file is absent or there is
 * no env), and `workspace-instructions` from `AGENTS.md`, read relative to
 * the conversation env's cwd (the workspace root by default).
 */
export const contextFilesExtension = defineExtension({
	name: "sigrun.context-files",
	sections: [
		section("identity", () => IDENTITY_TEXT),
		section("persona", async (input, context) =>
			// `??` covers both designed empty cases (not_found, no env); a
			// successful read — including an empty file — owns the section
			// wholesale. The throw path inside readContextFile propagates.
			(await readContextFile(input, "SOUL.md", context)) ?? DEFAULT_PERSONA,
		),
		section("workspace-instructions", (input, context) =>
			readContextFile(input, "AGENTS.md", context),
		),
	],
});
