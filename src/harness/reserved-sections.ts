/**
 * The reserved core prompt-section keys (spec §6.5 R11).
 *
 * The prompt-section keys the core surfaces own (system-prompt Task 3).
 * The registry itself permits duplicate section keys across extensions
 * (last-writer-wins at render), so a loaded extension could silently
 * replace a core surface. The loader therefore rejects the LOAD of any
 * extension declaring one of these keys — a load-time quarantine, never
 * a boot abort (src/harness/loader.ts) — while boot's post-install walk
 * over `RESERVED_CORE_SECTION_OWNERS` (src/harness/boot.ts) stays as a
 * core-only assertion that can fire only on a core bug.
 *
 * Lives in its own module (not boot.ts) so the loader can read the
 * contract without importing boot's runtime graph; boot re-exports the
 * constant for existing importers.
 */
export const RESERVED_CORE_SECTION_KEYS = [
	"identity",
	"persona",
	"workspace-instructions",
	"skills",
	"tool-guidance",
	"execution-guidance",
] as const;
