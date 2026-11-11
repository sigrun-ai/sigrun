/**
 * Settings split Plan 2 Task 2: the one locality answer, keyed by the
 * PROVIDER EXTENSION slug. The pseudo-slug `"core"` names the env-driven
 * chat provider (it has no `providerOwnership` entry). Resolution is
 * live on every call: an admin's PUT reaches the next model kind — chat,
 * decision, or embedding — without a restart.
 *
 * The registry that OWNS a kind supplies the owner: collision losers
 * never answer for a provider id (last-registered wins, everywhere).
 */

export type ModelKind = "chat" | "decision" | "embedding";

export interface Locality {
	/** True when the extension slug (or `"core"`) is in `localProviders`. */
	isLocalExtension(slug: string): boolean;
	/** Resolve `provider/model` to its owning extension, then the switch. */
	isLocalModel(kind: ModelKind, model: string): boolean;
}

export function createLocality(deps: {
	localProviders(): readonly string[];
	ownerOf(kind: ModelKind, providerId: string, modelId?: string): string | undefined;
}): Locality {
	return {
		isLocalExtension(slug) {
			return deps.localProviders().includes(slug);
		},
		isLocalModel(kind, model) {
			// Slugs never contain `/` (the route grammar depends on it), so
			// the FIRST separator is provider/model even for chain-shaped ids
			// such as `bifrost/bifrost/chain`.
			const slash = model.indexOf("/");
			if (slash <= 0 || slash === model.length - 1) return false;
			const providerId = model.slice(0, slash);
			const owner = deps.ownerOf(kind, providerId, model.slice(slash + 1));
			if (owner === undefined) return false;
			return deps.localProviders().includes(owner);
		},
	};
}
