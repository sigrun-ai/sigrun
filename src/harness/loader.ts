/**
 * The extension loader (spec §3 boot order, §4.1 deploy-time list).
 *
 * Extensions are EXTERNAL packages (separate repos — the
 * extension-separation ruling). `SIGRUN_EXTENSIONS` carries a comma-separated
 * list of package specifiers (npm names or `file:` URLs); the loader
 * dynamic-imports each, resolves the sigrun extension-package contract, and
 * installs the pi-durable `Extension` into the registry *before*
 * `Harness.open` reads it.
 *
 * A failing extension is QUARANTINED: logged, reported as a degraded surface
 * via the outcome list (which `GET /v1/meta`, Task 9, surfaces as
 * `extensions[].status`), and boot continues — the loader never throws.
 *
 * The sigrun extension-package contract: a package's default export is a
 * factory returning an object with an `extension: Extension` field. The two
 * real packages (`sigrun-ext-memory`, `sigrun-ext-approvals`) predate the
 * settled contract and export named factories (`createMemory` /
 * `createApprovals`) whose results carry the same `.extension` field, so the
 * loader resolves, in order:
 *
 * 1. the default export, if it is a factory returning `{ extension }` or is
 *    itself an `Extension` (named `name`),
 * 2. a named `createMemory` / `createApprovals` factory (the bridge for the
 *    two real packages),
 * 3. a named `extension` export.
 *
 * The factories take no arguments; any configuration they need is resolved
 * from their own package context.
 */

import type { Extension, Registry } from "@earendil-works/pi-durable";

/** One loaded extension's boot outcome, for `GET /v1/meta` `extensions[]`. */
export interface ExtensionOutcome {
	/** The extension name on success; the specifier on quarantine. */
	readonly name: string;
	readonly status: "ok" | "quarantined";
	/** The failure message; present only when `status === "quarantined"`. */
	readonly error?: string;
}

/** Minimal module shape the contract resolution reads. */
interface ExtensionModule {
	readonly default?: unknown;
	readonly extension?: unknown;
	readonly createMemory?: unknown;
	readonly createApprovals?: unknown;
}

/** A structural check for "looks like a pi-durable Extension". */
function isExtension(value: unknown): value is Extension {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as Extension).name === "string"
	);
}

/** Call an unknown-typed factory and validate the `{ extension }` result. */
function extensionFromFactory(
	factory: unknown,
): Extension | undefined {
	if (typeof factory !== "function") return undefined;
	const result = (factory as () => unknown)();
	if (typeof result === "object" && result !== null && isExtension((result as { extension?: unknown }).extension)) {
		return (result as { extension: Extension }).extension;
	}
	return undefined;
}

/**
 * Resolve one imported module to the pi-durable `Extension` the loader
 * installs, per the contract order documented on this module.
 */
export function resolveExtension(module: ExtensionModule): Extension | undefined {
	// 1. Default export: factory returning `{ extension }`, or the Extension itself.
	const defaultExport = module.default;
	if (isExtension(defaultExport)) return defaultExport;
	const fromDefault = extensionFromFactory(defaultExport);
	if (fromDefault !== undefined) return fromDefault;

	// 2. Named real-package factories (bridge for the pre-contract packages).
	const fromMemory = extensionFromFactory(module.createMemory);
	if (fromMemory !== undefined) return fromMemory;
	const fromApprovals = extensionFromFactory(module.createApprovals);
	if (fromApprovals !== undefined) return fromApprovals;

	// 3. Named `extension` export.
	if (isExtension(module.extension)) return module.extension;

	return undefined;
}

/**
 * Load and install every configured extension, quarantining failures.
 *
 * @param specifiers package specifiers from `SIGRUN_EXTENSIONS` (npm names or
 * `file:` URLs) — or the test seam's explicit list.
 * @param registry the application-owned registry; install publishes at once,
 * so extensions land before `Harness.open` reads the registry.
 * @returns the outcome list, one entry per specifier, in order — never
 * empty-entry gaps; boot stores this for `GET /v1/meta` (Task 9).
 */
export async function loadExtensions(
	specifiers: readonly string[],
	registry: Registry,
): Promise<ExtensionOutcome[]> {
	const outcomes: ExtensionOutcome[] = [];
	for (const specifier of specifiers) {
		try {
			const module = (await import(specifier)) as ExtensionModule;
			const extension = resolveExtension(module);
			if (extension === undefined) {
				throw new Error(
					`does not satisfy the sigrun extension-package contract ` +
						`(expected a default-export factory returning { extension })`,
				);
			}
			registry.install(extension);
			outcomes.push({ name: extension.name, status: "ok" });
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			console.warn(
				`extension quarantined: ${specifier} failed to load: ${message}`,
			);
			outcomes.push({
				name: specifier,
				status: "quarantined",
				error: message,
			});
		}
	}
	return outcomes;
}
