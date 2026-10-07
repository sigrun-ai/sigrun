/**
 * The no-op memory default (spec §3, extension-separation ruling).
 *
 * Bare sigrun core (zero extensions) boots a NO-OP memory surface: the same
 * stable `long-term-memory` placeholder section the real degenerate backend
 * renders (`"long-term memory backend not configured"` — the string
 * `sigrun-ext-memory`'s `MEMORY_PLACEHOLDER` defines), no recall tool, no
 * hooks. Memory features appear only when a memory extension is installed;
 * until then every conversation still sees a stable prompt surface — the
 * zero-extensions guarantee holds via no-op defaults, not bundled
 * degenerate implementations.
 *
 * The section is intentionally NOT gated on the real package's export: the
 * string is part of the prompt contract, duplicated here so core has no
 * dependency on any extension package.
 */

import { defineExtension, section } from "@earendil-works/pi-durable";

/** The section key the memory surface owns (real extension shares it). */
export const MEMORY_SECTION_KEY = "long-term-memory";

/**
 * The stable placeholder text — byte-identical to sigrun-ext-memory's
 * `MEMORY_PLACEHOLDER` ("long-term memory backend not configured").
 */
export const MEMORY_PLACEHOLDER = "long-term memory backend not configured";

/**
 * The no-op memory extension: one placeholder section, nothing else.
 * The render reads nothing from the input, so it is stable for any
 * `PromptInput`.
 */
export const noopMemoryExtension = defineExtension({
	name: "sigrun.memory-noop",
	sections: [
		section(MEMORY_SECTION_KEY, () => MEMORY_PLACEHOLDER),
	],
});
