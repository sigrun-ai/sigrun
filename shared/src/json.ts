/**
 * The JSON value mirrors (the shared leaf's local declarations of
 * chord/pi-durable's `JsonValue`/`JsonObject`).
 *
 * Declared LOCALLY — never imported — so every shared module stays
 * import-free at runtime (the shared-package invariant: the webui
 * compiles DOM-only against these files, and a dependency import would
 * drag a module only one client can resolve). The shapes mirror
 * `@earendil-works/chord`'s `JsonValue` exactly (structural identity —
 * the server-side doc definitions accept records built from these types
 * wherever pi-durable's own `JsonObject` is required).
 */

/** A strict-JSON value: primitives, arrays, or a JSON object. */
export type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

/** JSON object used as the root of every durable document. */
export type JsonObject = { [key: string]: JsonValue };
