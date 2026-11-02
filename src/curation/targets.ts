/**
 * The curation-target registry (curator P7, spec §6.5): the boot-built
 * view over every loaded extension's `curationTargets` declaration.
 *
 * The loader validates each declaration (a target without `undo`, a
 * tool the extension does not register, or a duplicate qualified id
 * quarantines the WHOLE extension before anything is collected); boot
 * folds the surviving bindings into ONE {@link CurationRegistry} and
 * exposes it on the opened harness.
 *
 * `isCurationTool` is the A8 wrapping feed: `true` for `skill_manage`
 * and every LISTED target tool, `false` for everything else — an
 * extension's unlisted direct write tools (a "remember this" path the
 * extension owns itself) are never intercepted, never gated, never
 * undone by the curator.
 */

import type { CurationTarget } from "../extension.js";

/**
 * A target attributed to its extension: the qualified id
 * (`<slug>:<name>`) and the slug identity, merged onto the target's
 * own declaration shape.
 */
export type QualifiedTarget = CurationTarget & {
	/** The qualified identity: `<slug>:<name>`. */
	readonly id: string;
	/** The declaring extension's slug. */
	readonly extension: string;
};

/**
 * The registered tool names that are curation tools by core ownership.
 * Exported for the A8 wrap feed's seed (the feed starts with the core
 * set and grows as the loader validates target tools).
 */
export const CORE_CURATION_TOOLS: ReadonlySet<string> = new Set([
	"skill_manage",
]);

/** The boot-built registry over the loaded curation targets. */
export class CurationRegistry {
	readonly #targets: readonly QualifiedTarget[];
	readonly #tools: ReadonlySet<string>;

	constructor(targets: readonly QualifiedTarget[]) {
		this.#targets = [...targets];
		const tools = new Set<string>(CORE_CURATION_TOOLS);
		for (const target of this.#targets) {
			for (const tool of target.tools) tools.add(tool);
		}
		this.#tools = tools;
	}

	/** Every registered target, in load order. */
	targets(): readonly QualifiedTarget[] {
		return this.#targets;
	}

	/** The target a tool belongs to, or `undefined` when it is none. */
	byTool(tool: string): QualifiedTarget | undefined {
		return this.#targets.find((target) => target.tools.includes(tool));
	}

	/**
	 * Whether a tool is a curation tool: `skill_manage` and every listed
	 * target tool — the A8 wrapping feed. An extension's unlisted tools
	 * are never curation tools.
	 */
	isCurationTool(tool: string): boolean {
		return this.#tools.has(tool);
	}
}

/**
 * Fold per-extension curation-target bindings into one registry. The
 * loader quarantined every invalid declaration, so this pass only
 * attributes: each target gains its qualified id (`<slug>:<name>`) and
 * the extension slug. A duplicate qualified id here is a loader bug
 * (the load-time check already rejected it) — it fails loud rather
 * than shadowing.
 */
export function buildCurationRegistry(
	bindings: readonly {
		extension: string;
		targets: readonly CurationTarget[];
	}[],
): CurationRegistry {
	const targets: QualifiedTarget[] = [];
	const seen = new Set<string>();
	for (const binding of bindings) {
		for (const target of binding.targets) {
			const id = `${binding.extension}:${target.name}`;
			if (seen.has(id)) {
				throw new Error(
					`duplicate curation target id "${id}" — the loader already rejected this; a second arrival is a boot bug`,
				);
			}
			seen.add(id);
			targets.push({ ...target, id, extension: binding.extension });
		}
	}
	return new CurationRegistry(targets);
}
