/**
 * Type declarations only; ci-core-ref.mjs is the source of truth.
 *
 * The resolver reads npm packuments to determine which versions of the
 * core and each built-in extension are currently released, returning
 * a JSON object mapping repo names to their release tags.
 */

export type NpmView = (spec: string, field: string) => Promise<unknown>;

export function resolveRefs(
	mode: "main" | "release",
	npmView: NpmView,
): Promise<Record<string, string>>;

export function resolveRefsFromManifest(
	manifest: { version?: unknown; dependencies?: unknown },
	npmView: NpmView,
): Promise<Record<string, string>>;
