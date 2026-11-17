/**
 * Defensive inputs: `sigrun.tool-result-cap` — a hooks-only core
 * extension that bounds a tool result's `details`.
 *
 * WHY THIS EXISTS. A tool result carries two channels: `output` (what the
 * model reads) and `details` (what programs and the UI read). Pi-durable
 * bounds the first — `OutputBuffer` truncates it and the tool declares
 * `outputLimits` — but nothing bounds the second. `@sigrun/ext-mcp` sets
 * `details: result` (the raw MCP protocol payload) while the model sees
 * only the bounded `content` blocks, so ONE `crawl4ai/crawl` call stored
 * an 8.1 MB entry: 7.2 KB of model-visible text beside 8.5 MB of
 * `details`. Every consumer that materializes the record then pays for
 * it — recall re-read the record per indexed passage at boot and
 * exhausted the container's heap.
 *
 * WHAT IT DOES. Over `server.maxInlineFileBytes` (the same knob the
 * attachment cap uses — both answer "how much of one thing is it
 * reasonable to inline?"), `details` is replaced by a marker object
 * naming the original byte size and shape. The model-visible `output` is
 * NEVER touched: a tool already owns that budget, and rewriting it here
 * would fight `externalize`-style extensions that legitimately replace
 * output with a handle.
 *
 * The marker keeps the row renderable: a UI can show "details elided
 * (8.5 MB object)" instead of nothing, and programmatic callers see a
 * plain object rather than a silently missing field.
 *
 * INSTALLED BY BOOT; SELECTED UNLESS THE EXTENSION ARRAY OPTS OUT. This is a
 * host-owned invariant, not an optional extension: `settings.extensions`
 * filters user/curator entries out of the host default, and boot installs
 * this alongside the other core-owned entries (coding tools, search tools,
 * the decisions placeholder). The one way out is an EXACT extension
 * selection: a conversation whose stored `pi.agent.extensions` is an exact
 * array that omits `sigrun.tool-result-cap` does not get the cap (bounded
 * consequence: `details` is unbounded in that conversation). `agent.tools`
 * is a tool-name filter applied INSIDE the selected extensions, so no tool
 * list can de-select this hook. Boot's host default always re-adds the cap,
 * and lean retry is unrelated: it force-appends itself to every exact
 * selection and skips request hooks through its own wrap.
 */

import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";
import type {
	Extension,
	ToolExecutionResult,
	ToolHookCall,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import type { HookApi } from "@earendil-works/pi-durable";

/** The cap extension's registered name. */
export const TOOL_RESULT_CAP_EXTENSION = "sigrun.tool-result-cap";

/** The marker that replaces an oversized `details` value. */
export interface CappedDetails {
	/** Always `true` — the discriminator a reader tests. */
	readonly capped: true;
	/** The original serialized size, in UTF-8 bytes. */
	readonly bytes: number;
	/** The original value's JSON shape (`object`, `array`, `string`, …). */
	readonly kind: string;
	/** A fixed note so a human reading the row knows where it went. */
	readonly note: string;
}

/** The JSON shape name for a `details` value (the marker's `kind`). */
function jsonKind(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

/**
 * Build the cap: one `pi.tool` `afterTool` hook, no tools, no sections,
 * no prompt bytes. `maxBytes` is the resolved `server.maxInlineFileBytes`
 * (boot reads it from config, so the extension needs no store access).
 */
export function createToolResultCapExtension(maxBytes: number): Extension {
	return defineExtension({
		name: TOOL_RESULT_CAP_EXTENSION,
		hooks: [
			hook(ToolTask, {
				/**
				 * Replace an oversized `details` with the marker. `undefined`
				 * (no details, or under the cap) passes the result through
				 * untouched — including the exact object identity pi-durable
				 * recorded, so small details (diffs, block state, structured
				 * summaries) are unchanged.
				 */
				afterTool(
					_call: ToolHookCall,
					result: ToolExecutionResult,
					_api: HookApi,
					_context: Context,
				): ToolExecutionResult | undefined {
					if (result.details === undefined) return undefined;
					// Measure the value as it will be stored (JSON), not as a
					// guess from the JS object.
					const serialized = JSON.stringify(result.details) ?? "";
					const bytes = Buffer.byteLength(serialized, "utf8");
					if (bytes <= maxBytes) return undefined;
					const capped: CappedDetails = {
						capped: true,
						bytes,
						kind: jsonKind(result.details),
						note: `tool result details elided: ${bytes} bytes exceeds server.maxInlineFileBytes (${maxBytes})`,
					};
					// SAFETY: `details` is typed as the tool's own TDetails extends
					// JsonValue; `CappedDetails` is a plain JSON object, so it is a
					// valid value for that channel at runtime — the substitution is
					// exactly the point of the cap, and no reader can assume the
					// tool's own shape for a value it never wrote.
					return { ...result, details: capped as unknown as never };
				},
			}),
		],
	});
}
