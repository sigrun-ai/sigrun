/**
 * The curator-run gate (curator P6): `sigrun.curation-gate` — a
 * hooks-only core extension that confines an internal curator run to
 * its allow list.
 *
 * Selected ONLY in the run conversations A9's producer creates (this
 * task installs it; boot keeps it OUT of the host default extension
 * selection, the same never-defaulted treatment as per-user entries).
 * Its `beforeTool` blocks any tool not in `CurationRunDoc.allow` with
 * `"<tool> is not available in this review; use one of: <allow,
 * comma-separated>"` — a decision only; it writes nothing (a hook
 * cannot commit, and the gate has no write to make). A conversation
 * with no run doc (never, for a correctly-created run) allows
 * everything: the gate is a confinement, not a filter on ordinary
 * conversations.
 */

import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";
import type { Extension, HookApi } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { curationRun } from "./run-doc.js";

/** The gate extension's registered name. */
export const CURATION_GATE_EXTENSION = "sigrun.curation-gate";

/**
 * Build the gate extension: one `pi.tool` hook, no tools, no sections,
 * no prompt bytes. Boot installs it into the registry; A9's producer
 * selects it in the internal run conversations it creates.
 */
export function createCurationGateExtension(): Extension {
	return defineExtension({
		name: CURATION_GATE_EXTENSION,
		hooks: [
			hook(ToolTask, {
				/**
				 * Block any tool outside the run's allow list, naming the
				 * allowed list so the model can recover without another
				 * round of guessing. `undefined` (no run doc, or the tool
				 * is allowed) lets the call proceed.
				 */
				async beforeTool(
					call: { readonly name: string },
					api: HookApi,
					context: Context,
				): Promise<{ readonly block: string } | undefined> {
					const run = await curationRun(api, api.conversationId, context);
					if (run === undefined) return undefined;
					if (run.allow.includes(call.name)) return undefined;
					return {
						block: `${call.name} is not available in this review; use one of: ${run.allow.join(", ")}`,
					};
				},
			}),
		],
	});
}
